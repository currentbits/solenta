"use strict";

/**
 * Opaque skill-import previews and fan-out install. Staging lives only under
 * <userDataPath>/skill-imports/<id>. Preview never executes imported files.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  discoverSkillPackages,
  safeExtractZip,
  stageMarkdownSkill,
  stageGitHubSkill,
  parseGitHubSkillUrl,
} = require("./skillPackages.js");
const {
  SKILL_NAME_RE,
  SKILL_DIRS,
  SKILL_TARGETS,
  activeSkillTargets,
  skillBaseDir,
} = require("./skills.js");
const { getCatalogEntry } = require("./skillCatalog.js");
const {
  newInstallId,
  installIdsForName,
  commitInstalls,
} = require("./skillRegistry.js");
const { activateSkillPlugins } = require("./skillPluginAdapters.js");

const CLOCK_SKEW_MS = 60_000;

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_ID_RE = /^[a-f0-9]{32}$/;
const MARKER_NAME = ".solenta-skill.json";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__MACOSX",
  ".openclaw",
  "benchmarks",
]);

const EXEC_EXTS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".exe",
  ".bin",
  ".command",
  ".msi",
  ".com",
  ".dll",
  ".so",
  ".dylib",
]);

const PLUGIN_MARKERS = [
  {
    rel: ".claude-plugin/plugin.json",
    provider: "claude",
    kind: "claude-plugin",
    defaultLabel: "Claude plugin",
  },
  {
    rel: ".codex-plugin/plugin.json",
    provider: "codex",
    kind: "codex-plugin",
    defaultLabel: "Codex plugin",
  },
  {
    rel: ".grok-plugin/marketplace.json",
    provider: "grok",
    kind: "grok-plugin",
    defaultLabel: "Grok plugin",
  },
  {
    rel: "plugin.json",
    provider: "plugin",
    kind: "plugin",
    defaultLabel: "Plugin",
  },
];

function nowMs(now) {
  if (typeof now === "function") return now();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

function importsRoot(userDataPath) {
  return path.join(String(userDataPath || ""), "skill-imports");
}

function requireUserData(userDataPath) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    throw new Error("Skill import storage is not configured");
  }
  return userDataPath;
}

function resolvePreviewDir(userDataPath, previewId) {
  if (typeof previewId !== "string" || !PREVIEW_ID_RE.test(previewId)) {
    throw new Error("Import preview is invalid");
  }
  const root = path.resolve(requireUserData(userDataPath), "skill-imports");
  const dir = path.resolve(root, previewId);
  if (path.relative(root, dir) !== previewId) {
    throw new Error("Import preview is invalid");
  }
  return dir;
}

function parseCreatedAt(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return NaN;
}

function createdAtStatus(value, now) {
  const createdAt = parseCreatedAt(value);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now + CLOCK_SKEW_MS) {
    return "invalid";
  }
  if (now - createdAt > PREVIEW_TTL_MS) return "expired";
  return "ok";
}

function cleanStalePreviews(userDataPath, now, keepId) {
  const root = importsRoot(userDataPath);
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const full = path.join(root, ent.name);
    if (keepId && ent.name === keepId) continue;
    if (!ent.isDirectory() || !PREVIEW_ID_RE.test(ent.name)) {
      fs.rmSync(full, { recursive: true, force: true });
      continue;
    }
    let status = "invalid";
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(full, "manifest.json"), "utf8"),
      );
      status = createdAtStatus(raw && raw.createdAt, now);
    } catch {
      status = "invalid";
    }
    if (status !== "ok") {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
}

function isPlainFile(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function isPlainDir(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function unwrapArchive(root) {
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return root;
  }
  const visible = ents.filter((e) => e.name !== ".DS_Store");
  const files = visible.filter((e) => e.isFile());
  const dirs = visible.filter(
    (e) => e.isDirectory() && !e.isSymbolicLink() && !IGNORED_DIRS.has(e.name),
  );
  if (
    !isPlainFile(path.join(root, "SKILL.md")) &&
    files.length === 0 &&
    dirs.length === 1
  ) {
    return path.join(root, dirs[0].name);
  }
  return root;
}

function looksExecutable(rel, st) {
  const ext = path.posix.extname(rel).toLowerCase();
  if (EXEC_EXTS.has(ext)) return true;
  if (st && st.isFile() && (st.mode & 0o111) !== 0) return true;
  return false;
}

function readPluginMeta(file, fallback) {
  let pluginName = "";
  let label = fallback;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw.name === "string" && raw.name.trim()) {
      pluginName = raw.name.trim();
      label = pluginName;
    } else if (raw && typeof raw.description === "string" && raw.description.trim()) {
      label = raw.description.trim();
    }
  } catch {
    // ignore unreadable manifests
  }
  return { pluginName, label };
}

function listExecutableRel(root, dirName) {
  const dir = path.join(root, dirName);
  /** @type {string[]} */
  const out = [];
  function walk(current, rel) {
    let ents;
    try {
      ents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.isSymbolicLink() || ent.name.includes("\0")) continue;
      const nextRel = `${rel}/${ent.name}`;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        walk(full, nextRel);
      } else if (ent.isFile()) {
        let st;
        try {
          st = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (looksExecutable(nextRel, st)) out.push(nextRel);
      }
    }
  }
  walk(dir, dirName);
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * Repository-level extras. Never executes manifests, hooks, or commands.
 * @param {string} searchRoot
 */
function detectPluginExtras(searchRoot) {
  /** @type {Array<{
   *   provider: string,
   *   label: string,
   *   pluginName?: string,
   *   executableFiles: string[],
   *   activation: { kind: string, status: "pending" },
   * }>} */
  const extras = [];
  for (const marker of PLUGIN_MARKERS) {
    const full = path.join(searchRoot, ...marker.rel.split("/"));
    if (!isPlainFile(full)) continue;
    const meta = readPluginMeta(full, marker.defaultLabel);
    extras.push({
      provider: marker.provider,
      label: meta.label,
      pluginName: meta.pluginName || undefined,
      executableFiles: [],
      activation: { kind: marker.kind, status: "pending" },
    });
  }
  if (isPlainDir(path.join(searchRoot, "hooks"))) {
    extras.push({
      provider: "hooks",
      label: "Hooks",
      executableFiles: listExecutableRel(searchRoot, "hooks"),
      activation: { kind: "hooks", status: "pending" },
    });
  }
  if (isPlainDir(path.join(searchRoot, "commands"))) {
    extras.push({
      provider: "commands",
      label: "Commands",
      executableFiles: listExecutableRel(searchRoot, "commands"),
      activation: { kind: "commands", status: "pending" },
    });
  }
  return extras;
}

function toRel(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Skill path escapes the staging directory");
  }
  return rel.split(path.sep).join("/");
}

function safeJoinStage(root, relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Skill path escapes the staging directory");
  }
  const dest = path.join(root, ...normalized.split("/").filter(Boolean));
  const rel = path.relative(root, dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Skill path escapes the staging directory");
  }
  return dest;
}

function hasCollision(name, env) {
  const dirs = SKILL_DIRS(env);
  for (const target of SKILL_TARGETS) {
    const dir = path.join(dirs[target], name);
    if (path.relative(dirs[target], dir) !== name) continue;
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return true;
  }
  return false;
}

function safeExecutableFiles(files) {
  return (files || []).filter(
    (rel) =>
      typeof rel === "string" &&
      rel &&
      !path.isAbsolute(rel) &&
      !rel.split("/").includes(".."),
  );
}

function storedPlugins(extras) {
  return extras.map((extra) => ({
    provider: extra.provider,
    label: extra.label,
    pluginName: extra.pluginName || undefined,
    executableFiles: safeExecutableFiles(extra.executableFiles),
    activation: {
      kind: extra.activation.kind,
      status: "pending",
    },
  }));
}

function publicPlugins(extras) {
  return extras.map((extra) => ({
    provider: extra.provider,
    label: extra.label,
    executableFiles: safeExecutableFiles(extra.executableFiles),
    activation: {
      kind: extra.activation.kind,
      status: "pending",
    },
  }));
}

function toPublicPreview(previewId, source, packages, extras, env) {
  return {
    previewId,
    source,
    skills: packages.map((pkg) => ({
      name: pkg.name,
      description: pkg.description,
      files: [...pkg.files],
      bytes: pkg.totalBytes,
      warnings: [...pkg.warnings],
      collision: hasCollision(pkg.name, env),
    })),
    plugins: publicPlugins(extras),
  };
}

function resolveFetch(fetchImpl) {
  const fn = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof fn !== "function") {
    throw new Error("Skill import is unavailable");
  }
  return fn;
}

function slugName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param {{
 *   userDataPath: string,
 *   kind: "local" | "github" | "catalog",
 *   label: string,
 *   sourceUrl?: string,
 *   catalogId?: string,
 *   packageId: string,
 *   stageFn: (stageDir: string) => Promise<Array<{
 *     name: string,
 *     description: string,
 *     skillRoot: string,
 *     files: string[],
 *     totalBytes: number,
 *     warnings: string[],
 *   }>>,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number | (() => number),
 * }} opts
 */
async function createPreview(opts) {
  const userDataPath = requireUserData(opts.userDataPath);
  const env = opts.env || process.env;
  const t = nowMs(opts.now);
  cleanStalePreviews(userDataPath, t);
  const previewId = crypto.randomBytes(16).toString("hex");
  const previewDir = path.join(importsRoot(userDataPath), previewId);
  const stageDir = path.join(previewDir, "stage");
  fs.mkdirSync(stageDir, { recursive: true });
  try {
    const packages = await opts.stageFn(stageDir);
    const extras = detectPluginExtras(unwrapArchive(stageDir));
    const manifest = {
      previewId,
      createdAt: t,
      kind: opts.kind,
      label: opts.label,
      sourceUrl: opts.sourceUrl,
      catalogId: opts.catalogId,
      packageId: opts.packageId,
      skills: packages.map((pkg) => ({
        name: pkg.name,
        rel: toRel(stageDir, pkg.skillRoot),
      })),
      plugins: storedPlugins(extras),
    };
    fs.writeFileSync(
      path.join(previewDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return toPublicPreview(
      previewId,
      { kind: opts.kind, label: opts.label },
      packages,
      extras,
      env,
    );
  } catch (err) {
    fs.rmSync(previewDir, { recursive: true, force: true });
    throw err;
  }
}

function dialogFilters() {
  return [
    { name: "Skills", extensions: ["md", "zip"] },
    { name: "Markdown", extensions: ["md"] },
    { name: "ZIP", extensions: ["zip"] },
  ];
}

/**
 * Main-process file picker. The renderer must not choose a destination or
 * supply a local source path.
 */
async function pickImport(opts) {
  const dialog = opts && opts.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== "function") {
    throw new Error("File picker is not available in this mode");
  }
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: dialogFilters(),
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return null;
  }
  const src = result.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown" && ext !== ".zip") {
    throw new Error("Choose a Markdown or ZIP file");
  }
  return createPreview({
    userDataPath: opts.userDataPath,
    kind: "local",
    label: path.basename(src),
    packageId: slugName(path.basename(src, ext)) || "local",
    env: opts.env,
    now: opts.now,
    stageFn: async (stageDir) => {
      if (ext === ".zip") {
        await safeExtractZip(src, stageDir);
        return discoverSkillPackages(stageDir);
      }
      const pkg = await stageMarkdownSkill(src, stageDir);
      return [pkg];
    },
  });
}

async function previewImport(opts) {
  const input = opts && opts.input;
  if (!input || typeof input !== "object") {
    throw new Error("Import source is required");
  }
  if (input.kind === "catalog") {
    const entry = getCatalogEntry(input.id);
    if (!entry) throw new Error("Unknown catalog item");
    return createPreview({
      userDataPath: opts.userDataPath,
      kind: "catalog",
      label: entry.name,
      sourceUrl: entry.sourceUrl,
      catalogId: entry.id,
      packageId: entry.id,
      env: opts.env,
      now: opts.now,
      stageFn: async (stageDir) => {
        const result = await stageGitHubSkill(entry.sourceUrl, stageDir, {
          fetchImpl: resolveFetch(opts.fetchImpl),
        });
        return result.packages;
      },
    });
  }
  if (input.kind === "github") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) throw new Error("GitHub URL is required");
    const parsed = parseGitHubSkillUrl(url);
    return createPreview({
      userDataPath: opts.userDataPath,
      kind: "github",
      label: `${parsed.owner}/${parsed.repo}`,
      sourceUrl: url,
      packageId: `${parsed.owner}/${parsed.repo}`,
      env: opts.env,
      now: opts.now,
      stageFn: async (stageDir) => {
        const result = await stageGitHubSkill(url, stageDir, {
          fetchImpl: resolveFetch(opts.fetchImpl),
        });
        return result.packages;
      },
    });
  }
  throw new Error("Unsupported import source");
}

function loadManifest(userDataPath, previewId, now) {
  const previewDir = resolvePreviewDir(userDataPath, previewId);
  const manifestPath = path.join(previewDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Import preview not found");
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fs.rmSync(previewDir, { recursive: true, force: true });
    throw new Error("Import preview is invalid");
  }
  const status = createdAtStatus(manifest.createdAt, now);
  if (status === "expired") {
    fs.rmSync(previewDir, { recursive: true, force: true });
    throw new Error("This import preview has expired. Preview the import again.");
  }
  if (status !== "ok") {
    throw new Error("Import preview is invalid");
  }
  return { previewDir, manifest };
}

function resolveInstallDir(target, name, env) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!SKILL_NAME_RE.test(n)) {
    throw new Error(
      `Skill name must be lowercase letters, digits, dashes (got "${n}")`,
    );
  }
  const base = skillBaseDir(target, env);
  const dir = path.join(base, n);
  if (path.relative(base, dir) !== n) {
    throw new Error("Skill path escapes the skills directory");
  }
  return dir;
}

function assertSafeSkillRoot(src) {
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    throw new Error("Skill package is missing from the preview");
  }
  if (st.isSymbolicLink()) {
    throw new Error("Skill package must be a real directory");
  }
  if (!st.isDirectory()) {
    throw new Error("Skill package must be a real directory");
  }
  const mdPath = path.join(src, "SKILL.md");
  let md;
  try {
    md = fs.lstatSync(mdPath);
  } catch {
    throw new Error("Skill package is missing SKILL.md");
  }
  if (md.isSymbolicLink() || !md.isFile()) {
    throw new Error("Skill package must contain a regular SKILL.md");
  }
}

function copySkillTree(src, dest, stripMarker) {
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    throw new Error("Skill package is missing from the preview");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error("Skill package must be a real directory");
  }
  let ents;
  try {
    ents = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    throw new Error("Skill package is unreadable");
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of ents) {
    if (ent.isSymbolicLink() || ent.name.includes("\0")) continue;
    if (stripMarker && ent.name === MARKER_NAME) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copySkillTree(from, to, stripMarker);
    } else if (ent.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function writeOwnedMarker(dir, marker) {
  /** @type {Record<string, string>} */
  const clean = { installId: marker.installId };
  if (marker.sourceLabel) clean.sourceLabel = marker.sourceLabel;
  if (marker.sourceUrl) clean.sourceUrl = marker.sourceUrl;
  fs.writeFileSync(
    path.join(dir, MARKER_NAME),
    `${JSON.stringify(clean, null, 2)}\n`,
    { mode: 0o644 },
  );
}

async function installImport(opts) {
  const request = (opts && opts.request) || {};
  const env = (opts && opts.env) || process.env;
  const userDataPath = requireUserData(opts && opts.userDataPath);
  const now = nowMs(opts && opts.now);
  // Test-only hooks: injected by direct module calls. Never read from `request`
  // (IPC/renderer cannot reach these).
  const afterTargetWrite =
    opts && typeof opts.afterTargetWrite === "function"
      ? opts.afterTargetWrite
      : null;
  const runFile = opts && typeof opts.runFile === "function" ? opts.runFile : null;
  const selected = Array.isArray(request.selected)
    ? request.selected.map((n) => String(n || "").trim()).filter(Boolean)
    : [];
  if (!selected.length) {
    throw new Error("Select at least one skill to install");
  }
  const replace = Boolean(request.replace);
  const trustPluginCode = request.trustPluginCode === true;

  const { previewDir, manifest } = loadManifest(
    userDataPath,
    request.previewId,
    now,
  );
  cleanStalePreviews(userDataPath, now, manifest.previewId || request.previewId);
  const active = activeSkillTargets(env);
  if (!active.length) {
    throw new Error("No active skill targets. Set up a supported CLI first.");
  }

  const byName = new Map(
    (manifest.skills || []).map((row) => [row.name, row]),
  );
  /** @type {Array<{ name: string, src: string }>} */
  const selectedRoots = [];
  for (const name of selected) {
    if (!byName.has(name)) {
      throw new Error(`Unknown skill in this preview: ${name}`);
    }
    if (!replace && hasCollision(name, env)) {
      throw new Error(`Skill already exists: ${name}`);
    }
    const src = safeJoinStage(
      path.join(previewDir, "stage"),
      byName.get(name).rel,
    );
    assertSafeSkillRoot(src);
    selectedRoots.push({ name, src });
  }

  const incomingRoot = path.join(previewDir, "incoming");
  fs.rmSync(incomingRoot, { recursive: true, force: true });

  const curated = Boolean(manifest.catalogId && getCatalogEntry(manifest.catalogId));
  const importedAt = new Date(now).toISOString();
  /** @type {Record<string, { installId: string, record: object, replaceIds: string[] }>} */
  const pending = {};

  try {
    fs.mkdirSync(incomingRoot, { recursive: true });
    for (const { name, src } of selectedRoots) {
      const dest = path.join(incomingRoot, name);
      copySkillTree(src, dest, true);
      assertSafeSkillRoot(dest);
      const installId = newInstallId();
      writeOwnedMarker(dest, {
        installId,
        sourceLabel: manifest.label,
        sourceUrl: manifest.sourceUrl,
      });
      pending[name] = {
        installId,
        replaceIds: installIdsForName(userDataPath, name),
        record: {
          name,
          provenance: curated ? "curated" : "added",
          catalogId: curated ? manifest.catalogId : undefined,
          sourceLabel: manifest.label,
          sourceUrl: manifest.sourceUrl,
          packageId: manifest.packageId,
          importedAt,
        },
      };
    }
  } catch (err) {
    fs.rmSync(incomingRoot, { recursive: true, force: true });
    throw err;
  }

  /** @type {Array<{ dest: string, backup: string | null }>} */
  const moves = [];
  try {
    for (const target of active) {
      for (const name of selected) {
        const dest = resolveInstallDir(target, name, env);
        let backup = null;
        if (fs.existsSync(dest)) {
          backup = `${dest}.solenta-bak-${crypto.randomBytes(6).toString("hex")}`;
          fs.renameSync(dest, backup);
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
        }
        moves.push({ dest, backup });
        copySkillTree(path.join(incomingRoot, name), dest, false);
        assertSafeSkillRoot(dest);
      }
      if (afterTargetWrite) afterTargetWrite(target);
    }
    /** @type {Record<string, object>} */
    const add = {};
    /** @type {string[]} */
    const removeIds = [];
    for (const name of selected) {
      add[pending[name].installId] = pending[name].record;
      removeIds.push(...pending[name].replaceIds);
    }
    commitInstalls(userDataPath, { add, removeIds });
  } catch (err) {
    for (const { dest, backup } of moves) {
      fs.rmSync(dest, { recursive: true, force: true });
      if (backup && fs.existsSync(backup)) {
        fs.renameSync(backup, dest);
      }
    }
    fs.rmSync(incomingRoot, { recursive: true, force: true });
    throw err;
  }
  for (const { backup } of moves) {
    if (backup) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch {
        // Destination writes and registry commit already succeeded.
      }
    }
  }
  try {
    fs.rmSync(previewDir, { recursive: true, force: true });
  } catch {
    // Install already committed; leftover staging is cleaned later.
  }

  /** @type {object[]} */
  let plugins;
  try {
    plugins = await activateSkillPlugins({
      manifest,
      trustPluginCode,
      runFile,
    });
  } catch {
    plugins = (manifest.plugins || []).map((extra) => ({
      provider: extra.provider,
      label: extra.label,
      status: trustPluginCode ? "failed" : "skipped",
      ...(trustPluginCode ? { error: "Plugin activation failed" } : {}),
    }));
  }

  return {
    installed: selected.map((name) => ({
      name,
      installedIn: [...active],
    })),
    plugins,
  };
}

function discardImport(opts) {
  const dir = resolvePreviewDir(opts && opts.userDataPath, opts && opts.previewId);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  PREVIEW_TTL_MS,
  pickImport,
  previewImport,
  installImport,
  discardImport,
  detectPluginExtras,
};
