"use strict";

/**
 * Opaque MCP-import previews. Staging lives only under
 * <userDataPath>/mcp-imports/<id>. Preview never executes imported files
 * or package install scripts.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  safeExtractZip,
  stageGitHubTree,
  parseGitHubSkillUrl,
} = require("./skillPackages.js");
const { parseMcpConfigDocument, upsertMcpServer } = require("./mcp.js");
const { getCatalogEntry } = require("./mcpCatalog.js");

const CLOCK_SKEW_MS = 60_000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_ID_RE = /^[a-f0-9]{32}$/;
const MAX_WALK_FILES = 400;
const MAX_JSON_BYTES = 512 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__MACOSX",
  ".openclaw",
  "benchmarks",
]);

const CONFIG_FILES = [
  "mcp.json",
  ".mcp.json",
  "claude_desktop_config.json",
  path.join(".cursor", "mcp.json"),
  path.join(".vscode", "mcp.json"),
  path.join(".kimi-code", "mcp.json"),
];
const WALK_NAMES = new Set(["mcp.json", ".mcp.json"]);

const MCP_PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "kimi", label: "Kimi" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
  { id: "cursor", label: "Cursor" },
];

function nowMs(now) {
  if (typeof now === "function") return now();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

function importsRoot(userDataPath) {
  return path.join(String(userDataPath || ""), "mcp-imports");
}

function requireUserData(userDataPath) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    throw new Error("MCP import storage is not configured");
  }
  return userDataPath;
}

function resolvePreviewDir(userDataPath, previewId) {
  if (typeof previewId !== "string" || !PREVIEW_ID_RE.test(previewId)) {
    throw new Error("Import preview is invalid");
  }
  const root = path.resolve(requireUserData(userDataPath), "mcp-imports");
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
  if (files.length === 0 && dirs.length === 1) {
    return path.join(root, dirs[0].name);
  }
  return root;
}

function providerSupport(stored) {
  return MCP_PROVIDERS.map((p) => {
    if (stored.transport === "sse" && p.id === "codex") {
      return {
        id: p.id,
        supported: false,
        note: "Codex does not support SSE",
      };
    }
    // grok mcp add has no cwd flag; ensureGrokMcpConfig skips these jobs.
    if (
      p.id === "grok" &&
      stored.transport === "stdio" &&
      typeof stored.cwd === "string" &&
      stored.cwd
    ) {
      return {
        id: p.id,
        supported: false,
        note: "Grok cannot express stdio cwd",
      };
    }
    return { id: p.id, supported: true };
  });
}

function publicServer(parsed, existingNames) {
  const stored = parsed.stored;
  const meta = parsed.meta || {};
  const warnings = [...(meta.warnings || [])];
  const collision = existingNames.has(stored.name);
  if (collision) warnings.push("A server with this name already exists");
  const envNames = [...(meta.envNames || [])];
  const headerNames = [...(meta.headerNames || [])];
  const requiredSecrets = Array.isArray(meta.requiredSecrets)
    ? meta.requiredSecrets.map((s) => ({ id: s.id, label: s.label }))
    : [];
  const row = {
    name: stored.name,
    transport: stored.transport,
    envNames,
    headerNames,
    hasToken: Boolean(meta.hasToken),
    hasSecrets: requiredSecrets.length > 0 || envNames.length > 0 || headerNames.length > 0,
    requiredSecrets,
    requiresTrust: stored.transport === "stdio",
    collision,
    warnings,
    providers: providerSupport(stored),
  };
  if (stored.transport === "stdio") {
    row.command = stored.command;
    row.args = Array.isArray(stored.args) ? [...stored.args] : [];
    row.trusted = false;
    if (stored.cwd) row.cwd = stored.cwd;
  } else {
    row.url = stored.url;
  }
  return row;
}

function findConfigFiles(root) {
  const found = [];
  const seen = new Set();
  function add(full) {
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) return;
      const resolved = path.resolve(full);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      found.push(full);
    } catch {
      // missing
    }
  }
  for (const rel of CONFIG_FILES) add(path.join(root, rel));
  const pkg = path.join(root, "package.json");
  add(pkg);
  let count = 0;
  function walk(dir, depth) {
    if (depth > 6 || count > MAX_WALK_FILES) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.isSymbolicLink() || ent.name.includes("\0")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      count += 1;
      if (WALK_NAMES.has(ent.name)) add(full);
    }
  }
  walk(root, 0);
  return found;
}

function parseConfigFile(file, warnings) {
  let raw;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_JSON_BYTES) {
      warnings.push(`${path.basename(file)} exceeds size limit`);
      return null;
    }
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (path.basename(file) === "package.json") {
    try {
      const obj = JSON.parse(raw);
      if (!obj || !obj.mcpServers) return null;
    } catch {
      return null;
    }
  }
  try {
    return parseMcpConfigDocument(raw);
  } catch (err) {
    if (Array.isArray(err && err.mcpWarnings)) {
      warnings.push(...err.mcpWarnings);
    }
    if (!err || !err.mcpWarnings || !err.mcpWarnings.length) {
      warnings.push(
        `${path.basename(file)}: ${err && err.message ? err.message : err}`,
      );
    }
    return null;
  }
}

function parseStagedTree(stageDir, warnings) {
  const root = unwrapArchive(stageDir);
  const files = findConfigFiles(root);
  const merged = [];
  const seen = new Map();
  for (const file of files) {
    const parsed = parseConfigFile(file, warnings);
    if (!parsed) continue;
    warnings.push(...parsed.warnings);
    for (const server of parsed.servers) {
      const prev = seen.get(server.stored.name);
      if (prev) {
        throw new Error(
          `Duplicate MCP server name "${server.stored.name}" in package`,
        );
      }
      seen.set(server.stored.name, file);
      merged.push(server);
    }
  }
  if (!merged.length) throw new Error("No MCP servers found in package");
  return merged;
}

function publicPreview(manifest, existingNames) {
  return {
    previewId: manifest.previewId,
    source: {
      kind: manifest.kind,
      label: manifest.label,
    },
    servers: (manifest.servers || []).map((row) =>
      publicServer(row, existingNames),
    ),
    warnings: [...(manifest.warnings || [])],
  };
}

function existingNameSet(current) {
  const names = new Set();
  if (!Array.isArray(current)) return names;
  for (const s of current) {
    if (s && typeof s.name === "string") names.add(s.name);
  }
  return names;
}

async function createPreview(opts) {
  const userDataPath = requireUserData(opts.userDataPath);
  const now = nowMs(opts.now);
  cleanStalePreviews(userDataPath, now);
  const previewId = crypto.randomBytes(16).toString("hex");
  const dir = resolvePreviewDir(userDataPath, previewId);
  fs.mkdirSync(dir, { recursive: true });
  const stageDir = path.join(dir, "stage");
  fs.mkdirSync(stageDir, { recursive: true });
  const warnings = [];
  let servers;
  try {
    servers = await opts.stageFn(stageDir, warnings);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const manifest = {
    previewId,
    createdAt: now,
    kind: opts.kind,
    label: opts.label,
    sourceUrl: opts.sourceUrl || "",
    catalogId: opts.catalogId || "",
    provenance: opts.catalogId ? "curated" : "added",
    warnings,
    servers,
  };
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(manifestPath, 0o600);
  } catch {
    // best-effort on platforms that ignore mode
  }
  return publicPreview(manifest, existingNameSet(opts.current));
}

function dialogFilters() {
  return [
    { name: "MCP config", extensions: ["json", "zip"] },
    { name: "JSON", extensions: ["json"] },
    { name: "ZIP", extensions: ["zip"] },
  ];
}

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
  if (ext !== ".json" && ext !== ".zip") {
    throw new Error("Choose a JSON or ZIP file");
  }
  return createPreview({
    userDataPath: opts.userDataPath,
    kind: "local",
    label: path.basename(src),
    current: opts.current,
    now: opts.now,
    stageFn: async (stageDir, warnings) => {
      if (ext === ".zip") {
        await safeExtractZip(src, stageDir);
        return parseStagedTree(stageDir, warnings);
      }
      const raw = fs.readFileSync(src, "utf8");
      const parsed = parseMcpConfigDocument(raw);
      warnings.push(...parsed.warnings);
      return parsed.servers;
    },
  });
}

async function readFetchText(res) {
  if (!res || res.ok === false) {
    throw new Error("GitHub fetch failed");
  }
  if (typeof res.text === "function") return await res.text();
  if (!res.body) throw new Error("GitHub fetch failed");
  const chunks = [];
  for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchGithubJson(source, fetchImpl) {
  const rawUrl =
    `https://raw.githubusercontent.com/${source.owner}/${source.repo}/` +
    `${source.ref}/${source.path}`;
  const res = await fetchImpl(rawUrl);
  return readFetchText(res);
}

async function previewImport(opts) {
  const input = opts && opts.input;
  if (!input || typeof input !== "object") {
    throw new Error("Import source is required");
  }
  if (input.kind === "json") {
    const text = typeof input.text === "string" ? input.text : "";
    if (!text.trim()) throw new Error("JSON is required");
    return createPreview({
      userDataPath: opts.userDataPath,
      kind: "json",
      label: "JSON",
      current: opts.current,
      now: opts.now,
      stageFn: async (_stageDir, warnings) => {
        const parsed = parseMcpConfigDocument(text);
        warnings.push(...parsed.warnings);
        return parsed.servers;
      },
    });
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
      current: opts.current,
      now: opts.now,
      stageFn: async () => {
        const parsed = parseMcpConfigDocument([entry.definition]);
        return parsed.servers;
      },
    });
  }
  if (input.kind === "github") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) throw new Error("GitHub URL is required");
    const parsedUrl = parseGitHubSkillUrl(url, {
      blobOk: (p) => /\.json$/i.test(String(p || "")),
    });
    const jsonBlob =
      parsedUrl.kind === "blob" || parsedUrl.kind === "raw";
    if (jsonBlob && !/\.json$/i.test(String(parsedUrl.path || ""))) {
      throw new Error("GitHub blob must be an MCP JSON candidate (mcp.json)");
    }
    return createPreview({
      userDataPath: opts.userDataPath,
      kind: "github",
      label: `${parsedUrl.owner}/${parsedUrl.repo}`,
      sourceUrl: url,
      current: opts.current,
      now: opts.now,
      stageFn: async (stageDir, warnings) => {
        if (jsonBlob) {
          const text = await fetchGithubJson(parsedUrl, opts.fetchImpl || fetch);
          const parsed = parseMcpConfigDocument(text);
          warnings.push(...parsed.warnings);
          return parsed.servers;
        }
        const staged = await stageGitHubTree(url, stageDir, {
          fetchImpl: opts.fetchImpl || fetch,
        });
        return parseStagedTree(staged.root, warnings);
      },
    });
  }
  throw new Error("Unknown MCP import kind");
}

function readManifest(userDataPath, previewId, now) {
  const dir = resolvePreviewDir(userDataPath, previewId);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    throw new Error("Import preview is invalid");
  }
  const status = createdAtStatus(raw && raw.createdAt, now);
  if (status !== "ok") {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      status === "expired" ? "Import preview expired" : "Import preview is invalid",
    );
  }
  return { dir, raw };
}

function applySecrets(value, secrets) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (all, label) => {
    for (const [id, secret] of Object.entries(secrets)) {
      if (id.endsWith(`:${label}`) && typeof secret === "string") return secret;
    }
    const err = new Error(`Missing secret for ${label}`);
    throw err;
  });
}

function applySecretMap(map, secrets) {
  if (!map || typeof map !== "object") return map;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = applySecrets(v, secrets);
  }
  return out;
}

async function installImport(opts) {
  const request = opts && opts.request ? opts.request : {};
  const previewId = request.previewId;
  const now = nowMs(opts.now);
  const { dir, raw } = readManifest(opts.userDataPath, previewId, now);
  const selected = Array.isArray(request.selected)
    ? request.selected.map((n) => String(n))
    : [];
  if (!selected.length) throw new Error("Select at least one MCP server");
  const replace = request.replace === true;
  const trustLocal =
    request.trustLocalCommands === true || request.trustLocal === true;
  const secrets =
    request.secrets && typeof request.secrets === "object" ? request.secrets : {};
  const current = Array.isArray(opts.current) ? opts.current : [];
  const existing = existingNameSet(current);
  const selectedSet = new Set(selected);
  const chosen = [];
  for (const row of raw.servers || []) {
    const stored = row && row.stored;
    if (!stored || !selectedSet.has(stored.name)) continue;
    if (existing.has(stored.name) && !replace) {
      throw new Error(`A server named "${stored.name}" already exists`);
    }
    if (stored.transport === "stdio" && trustLocal !== true) {
      throw new Error("Local MCP commands require explicit trust");
    }
    const entry = {
      ...stored,
      args: Array.isArray(stored.args) ? [...stored.args] : stored.args,
      env: stored.env ? { ...stored.env } : stored.env,
      headers: stored.headers ? { ...stored.headers } : stored.headers,
    };
    if (raw.catalogId) {
      entry.provenance = "curated";
      entry.catalogId = raw.catalogId;
    } else {
      entry.provenance = "added";
      delete entry.catalogId;
    }
    if (entry.transport === "stdio") {
      entry.trusted = true;
      entry.enabled = true;
      if (entry.env) entry.env = applySecretMap(entry.env, secrets);
    } else if (entry.headers) {
      entry.headers = applySecretMap(entry.headers, secrets);
    }
    chosen.push(entry);
  }
  if (!chosen.length) throw new Error("No matching MCP servers in preview");
  let next = current.slice();
  for (const entry of chosen) {
    next = upsertMcpServer(next, entry);
  }
  if (typeof opts.save === "function") opts.save(next);
  fs.rmSync(dir, { recursive: true, force: true });
  const { redactMcpServer } = require("./mcp.js");
  return {
    installed: chosen.map((s) => redactMcpServer(s)),
  };
}

function discardImport(opts) {
  const previewId = opts && opts.previewId;
  const dir = resolvePreviewDir(opts.userDataPath, previewId);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  pickImport,
  previewImport,
  installImport,
  discardImport,
  parseStagedTree,
  PREVIEW_TTL_MS,
};
