"use strict";

/**
 * One-way harness import from Claude Code, Cursor, and Codex homes.
 * Preview never executes imported files. Staging lives only under
 * <userDataPath>/harness-imports/<id>. Re-run is idempotent: existing
 * skills, MCP names, command dest files, plugin slash-command names,
 * plugin skill packages, and near-duplicate memories are skipped.
 * Plugin marketplace cache trees are never copied.
 *
 * Does not copy the whole provider home and does not import CLI sessions
 * (those stay on the #433 path).
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const {
  SKILL_NAME_RE,
  SKILL_DIRS,
  SKILL_TARGETS,
  parseSkillMarkdown,
  activeSkillTargets,
  skillBaseDir,
} = require("./skills.js");
const { parseMcpConfigDocument } = require("./mcp.js");
const {
  newInstallId,
  installIdsForName,
  commitInstalls,
} = require("./skillRegistry.js");
const { encodeClaudeProjectDir } = require("./cli-sessions.js");
const {
  collectCursorPluginRoots,
  collectCodexPluginRoots,
} = require("./pluginRoots.js");
const { readPluginManifest } = require("./pluginManifest.js");

const CLOCK_SKEW_MS = 60_000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_ID_RE = /^[a-f0-9]{32}$/;
const MARKER_NAME = ".solenta-skill.json";
const MAX_JSON_BYTES = 512 * 1024;
const MAX_MD_BYTES = 256 * 1024;
const MAX_SKILL_PACKAGES = 200;
const MAX_MEMORY_FILES = 50;
const MAX_INSTRUCTION_FILES = 40;
const MAX_SKILL_TREE_FILES = 200;
const MAX_COMMAND_FILES = 200;
const MAX_PLUGIN_GROUPS = 40;
const COMMAND_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const PLUGIN_NAME_RE = /^[a-z0-9-]+$/i;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__MACOSX",
  ".openclaw",
  "benchmarks",
  "sessions",
  "projects",
  "logs",
  "debug",
  "cache",
  "marketplaces",
  "telemetry",
  "statsig",
  "file-history",
  "shell-snapshots",
  "todos",
]);

const SOURCES = Object.freeze([
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
]);

function nowMs(now) {
  if (typeof now === "function") return now();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

function importsRoot(userDataPath) {
  return path.join(String(userDataPath || ""), "harness-imports");
}

function requireUserData(userDataPath) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    throw new Error("Harness import storage is not configured");
  }
  return userDataPath;
}

function resolvePreviewDir(userDataPath, previewId) {
  if (typeof previewId !== "string" || !PREVIEW_ID_RE.test(previewId)) {
    throw new Error("Import preview is invalid");
  }
  const root = path.resolve(requireUserData(userDataPath), "harness-imports");
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

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sourceMeta(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

function resolveHarnessHome(id, env) {
  const e = env || process.env;
  const home = e.HOME || os.homedir();
  if (id === "claude") {
    if (e.CLAUDE_CONFIG_DIR) return e.CLAUDE_CONFIG_DIR;
    return path.join(home, ".claude");
  }
  if (id === "cursor") {
    if (e.CURSOR_HOME) return e.CURSOR_HOME;
    return path.join(home, ".cursor");
  }
  if (id === "codex") {
    if (e.CODEX_HOME) return e.CODEX_HOME;
    return path.join(home, ".codex");
  }
  throw new Error("Unknown harness source");
}

function homeExists(dir) {
  return isPlainDir(dir);
}

function detectSources(opts) {
  const env = (opts && opts.env) || process.env;
  return SOURCES.map((s) => ({
    id: s.id,
    label: s.label,
    present: homeExists(resolveHarnessHome(s.id, env)),
  }));
}

function existingNameSet(current) {
  const names = new Set();
  if (!Array.isArray(current)) return names;
  for (const s of current) {
    if (s && typeof s.name === "string") names.add(s.name);
  }
  return names;
}

function hasSkillCollision(name, env) {
  if (!SKILL_NAME_RE.test(name)) return false;
  const dirs = SKILL_DIRS(env);
  for (const target of SKILL_TARGETS) {
    const dir = path.join(dirs[target], name);
    if (path.relative(dirs[target], dir) !== name) continue;
    if (isPlainFile(path.join(dir, "SKILL.md"))) return true;
  }
  return false;
}

function sha16(parts) {
  const h = crypto.createHash("sha256");
  for (const part of parts) h.update(String(part));
  return h.digest("hex").slice(0, 16);
}

function excerptText(text, max) {
  const compact = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function titleFromMarkdown(body, fallback) {
  const text = String(body || "");
  const heading = text.match(/^#{1,3}\s+(.+)$/m);
  if (heading && heading[1].trim()) return excerptText(heading[1], 80);
  const fmTitle = text.match(/^title:\s*(.+)$/m);
  if (fmTitle && fmTitle[1].trim()) {
    return excerptText(fmTitle[1].replace(/^["']|["']$/g, ""), 80);
  }
  return excerptText(fallback || "Imported note", 80);
}

function readCappedFile(file, maxBytes) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) return null;
  if (st.size > maxBytes) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function listSkillPackagesInDir(baseDir, home, origin, seen, out, warnings) {
  if (out.length >= MAX_SKILL_PACKAGES) return;
  if (!isPlainDir(baseDir) || !isInside(home, baseDir)) return;
  let ents;
  try {
    ents = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (out.length >= MAX_SKILL_PACKAGES) {
      warnings.push("Skill scan reached the package cap");
      return;
    }
    if (ent.isSymbolicLink() || ent.name.includes("\0")) continue;
    if (!ent.isDirectory()) continue;
    if (IGNORED_DIRS.has(ent.name)) continue;
    if (!SKILL_NAME_RE.test(ent.name)) continue;
    if (seen.has(ent.name)) continue;
    const skillRoot = path.join(baseDir, ent.name);
    if (!isInside(home, skillRoot) || !isInside(baseDir, skillRoot)) continue;
    const mdPath = path.join(skillRoot, "SKILL.md");
    if (!isPlainFile(mdPath)) continue;
    const content = readCappedFile(mdPath, MAX_MD_BYTES);
    if (content == null) continue;
    const parsed = parseSkillMarkdown(content);
    seen.add(ent.name);
    out.push({
      name: ent.name,
      description: parsed.description || "",
      origin,
      rel: path.relative(home, skillRoot).split(path.sep).join("/"),
      bytes: Buffer.byteLength(content),
    });
  }
}

function skillDirsForSource(id) {
  if (id === "cursor") return ["skills", "skills-cursor"];
  return ["skills"];
}

function scanPluginRootSkills(home, roots, seen, out, warnings) {
  for (const pluginRoot of roots) {
    if (out.length >= MAX_SKILL_PACKAGES) return;
    if (!isPlainDir(pluginRoot) || !isInside(home, pluginRoot)) continue;
    const manifest = readPluginManifest(pluginRoot, { requireName: true });
    if (!manifest) continue;
    for (const dir of manifest.skillDirs) {
      listSkillPackagesInDir(dir, home, "plugin", seen, out, warnings);
    }
  }
}

function scanSkills(id, home, env, warnings) {
  /** @type {Array<{ name: string, description: string, origin: string, rel: string, bytes: number }>} */
  const out = [];
  const seen = new Set();
  for (const rel of skillDirsForSource(id)) {
    listSkillPackagesInDir(
      path.join(home, rel),
      home,
      rel,
      seen,
      out,
      warnings,
    );
  }
  // Indexed plugin roots + plugin.json skills dirs. Never walk plugins/.
  scanPluginRootSkills(home, pluginRootsForSource(id, home), seen, out, warnings);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out.map((pkg) => ({
    ...pkg,
    alreadyImported: hasSkillCollision(pkg.name, env),
    warnings: [],
  }));
}

function grokCommandsDir(scope, env, projectPath) {
  if (scope === "project") {
    return path.join(String(projectPath || ""), ".grok", "commands");
  }
  return path.join((env && env.HOME) || os.homedir(), ".grok", "commands");
}

function commandDestPath(scope, rel, env, projectPath) {
  const base = grokCommandsDir(scope, env, projectPath);
  const parts = String(rel || "")
    .split("/")
    .filter(Boolean);
  if (!parts.length || parts.includes("..")) {
    throw new Error("Command path escapes the commands directory");
  }
  const dest = path.resolve(base, ...parts);
  if (!isInside(base, dest) || dest === base) {
    throw new Error("Command path escapes the commands directory");
  }
  return dest;
}

function hasCommandCollision(scope, rel, env, projectPath) {
  try {
    return isPlainFile(commandDestPath(scope, rel, env, projectPath));
  } catch {
    return false;
  }
}

function posixRel(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function addCommandRow(row, seen, out) {
  if (out.length >= MAX_COMMAND_FILES) return false;
  if (seen.has(row.id) || seen.has(`dest:${row.destRel}`)) return false;
  seen.add(row.id);
  seen.add(`dest:${row.destRel}`);
  out.push(row);
  return true;
}

/**
 * Installed plugin roots from installed_plugins.json. Never walks the
 * marketplace cache or unlisted cache trees.
 * @param {string} home
 * @returns {string[]}
 */
function pluginInstallPaths(home) {
  const plugins = path.join(home, "plugins");
  const raw = readCappedFile(
    path.join(plugins, "installed_plugins.json"),
    MAX_JSON_BYTES,
  );
  if (raw == null) return [];
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const table =
    json && json.plugins && typeof json.plugins === "object" ? json.plugins : {};
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const entries of Object.values(table)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const p =
        entry && typeof entry.installPath === "string" ? entry.installPath : "";
      if (!p) continue;
      const resolved = path.resolve(p);
      if (seen.has(resolved)) continue;
      if (!isPlainDir(resolved) || !isInside(home, resolved)) continue;
      if (isPlainDir(plugins) && !isInside(plugins, resolved)) continue;
      const rel = posixRel(home, resolved);
      if (
        !rel ||
        rel.split("/").includes("..") ||
        rel.split("/").includes("marketplaces")
      ) {
        continue;
      }
      seen.add(resolved);
      out.push(resolved);
      if (out.length >= MAX_PLUGIN_GROUPS) return out;
    }
  }
  return out;
}

function pluginRootsForSource(id, home) {
  if (id === "claude") return pluginInstallPaths(home);
  if (id === "codex") return collectCodexPluginRoots(home);
  if (id === "cursor") return collectCursorPluginRoots(home);
  return [];
}

function addPluginCommandFile(opts) {
  const {
    pluginName,
    pluginRel,
    commandDirRel,
    rel,
    full,
    env,
    projectPath,
    seen,
    out,
  } = opts;
  if (out.length >= MAX_COMMAND_FILES) return;
  if (!rel || rel.split("/").includes("..")) return;
  if (/^readme\.md$/i.test(path.basename(rel))) return;
  const slug = rel.replace(/\.md$/i, "").replace(/\//g, ":");
  const name = `${pluginName}:${slug}`;
  if (!COMMAND_SLUG_RE.test(name)) return;
  const destRel = `${pluginName}/${rel}`;
  const content = readCappedFile(full, MAX_MD_BYTES);
  if (content == null) return;
  const parsed = parseSkillMarkdown(content);
  addCommandRow(
    {
      id: `command:plugin:${pluginName}:${slug}`,
      name,
      description: parsed.description || "",
      origin: "plugin",
      pluginName,
      pluginRel,
      commandDirRel,
      rel,
      destRel,
      bytes: Buffer.byteLength(content),
      alreadyImported: hasCommandCollision("user", destRel, env, projectPath),
    },
    seen,
    out,
  );
}

/**
 * Recurse for `*.md` command files. `git/pr.md` → name `git:pr`.
 * Same naming rule as cliCommands.scanCommandDir.
 *
 * @param {string} baseDir
 * @param {string} root
 * @param {"user" | "project" | "plugin"} scope
 * @param {NodeJS.ProcessEnv} env
 * @param {string} projectPath
 * @param {Set<string>} seen
 * @param {Array<object>} out
 * @param {string[]} warnings
 * @param {string} [rel]
 * @param {{ name: string, pluginRel: string, commandDirRel: string } | null} [plugin]
 */
function scanCommandDir(
  baseDir,
  root,
  scope,
  env,
  projectPath,
  seen,
  out,
  warnings,
  rel = "",
  plugin = null,
) {
  if (out.length >= MAX_COMMAND_FILES) return;
  if (!isPlainDir(baseDir) || !isInside(root, baseDir)) return;
  let ents;
  try {
    ents = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (out.length >= MAX_COMMAND_FILES) {
      warnings.push("Command scan reached the file cap");
      return;
    }
    if (ent.isSymbolicLink() || ent.name.includes("\0")) continue;
    const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (nextRel.split("/").includes("..")) continue;
    const full = path.join(baseDir, ent.name);
    if (!isInside(root, full) || !isInside(baseDir, full)) continue;
    if (ent.isDirectory()) {
      if (IGNORED_DIRS.has(ent.name)) continue;
      scanCommandDir(
        full,
        root,
        scope,
        env,
        projectPath,
        seen,
        out,
        warnings,
        nextRel,
        plugin,
      );
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    if (/^readme\.md$/i.test(ent.name)) continue;
    if (plugin) {
      addPluginCommandFile({
        pluginName: plugin.name,
        pluginRel: plugin.pluginRel,
        commandDirRel: plugin.commandDirRel,
        rel: nextRel,
        full,
        env,
        projectPath,
        seen,
        out,
      });
      continue;
    }
    const slug = nextRel.replace(/\.md$/i, "").replace(/\//g, ":");
    if (!COMMAND_SLUG_RE.test(slug)) continue;
    const content = readCappedFile(full, MAX_MD_BYTES);
    if (content == null) continue;
    const destRel = nextRel;
    addCommandRow(
      {
        id: `command:${scope}:${slug}`,
        name: slug,
        description: parseSkillMarkdown(content).description || "",
        origin: scope,
        rel: nextRel,
        destRel,
        bytes: Buffer.byteLength(content),
        alreadyImported: hasCommandCollision(scope, destRel, env, projectPath),
      },
      seen,
      out,
    );
  }
}

function scanPluginCommands(id, home, env, projectPath, seen, out, warnings) {
  for (const pluginRoot of pluginRootsForSource(id, home)) {
    if (out.length >= MAX_COMMAND_FILES) return;
    const manifest = readPluginManifest(pluginRoot, { requireName: true });
    if (!manifest) continue;
    const pluginRel = posixRel(home, pluginRoot);
    if (!pluginRel || pluginRel.split("/").includes("..")) continue;
    for (const dir of manifest.commandDirs) {
      scanCommandDir(
        dir,
        pluginRoot,
        "plugin",
        env,
        projectPath,
        seen,
        out,
        warnings,
        "",
        {
          name: manifest.name,
          pluginRel,
          commandDirRel: posixRel(pluginRoot, dir) || ".",
        },
      );
    }
  }
}

function scanCommands(id, home, projectPath, env, warnings) {
  /** @type {Array<object>} */
  const out = [];
  const seen = new Set();
  if (id === "claude") {
    scanCommandDir(
      path.join(home, "commands"),
      home,
      "user",
      env,
      projectPath,
      seen,
      out,
      warnings,
    );
    const project =
      typeof projectPath === "string" ? projectPath.trim() : "";
    if (project && isPlainDir(project)) {
      scanCommandDir(
        path.join(project, ".claude", "commands"),
        project,
        "project",
        env,
        project,
        seen,
        out,
        warnings,
      );
    }
  }
  if (id === "claude" || id === "codex" || id === "cursor") {
    scanPluginCommands(id, home, env, projectPath, seen, out, warnings);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function stageCommand(srcRoot, rel, destRoot) {
  const parts = String(rel || "")
    .split("/")
    .filter(Boolean);
  if (!parts.length || parts.includes("..")) {
    throw new Error("Command path escapes the commands directory");
  }
  const src = path.resolve(srcRoot, ...parts);
  if (!isInside(srcRoot, src) || !isPlainFile(src)) {
    throw new Error("Command file is missing from the preview");
  }
  const dest = path.resolve(destRoot, ...parts);
  if (!isInside(destRoot, dest) || dest === destRoot) {
    throw new Error("Command path escapes the staging directory");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function splitTomlTableKey(raw) {
  const parts = [];
  let i = 0;
  const s = String(raw || "");
  while (i < s.length) {
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1;
      while (j < s.length && s[j] !== q) j += 1;
      parts.push(s.slice(i + 1, j));
      i = j + 1;
      if (s[i] === ".") i += 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== ".") j += 1;
    parts.push(s.slice(i, j));
    i = j + 1;
  }
  return parts.filter(Boolean);
}

function parseTomlScalar(raw) {
  const s = String(raw || "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseTomlArray(raw) {
  const s = String(raw || "").trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return null;
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  /** @type {string[]} */
  const out = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = "";
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      if (buf.trim()) out.push(String(parseTomlScalar(buf.trim())));
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(String(parseTomlScalar(buf.trim())));
  return out;
}

/**
 * Conservative extractor for Codex `[mcp_servers.NAME]` tables.
 * Never executes values. Env/header values stay on the stored object
 * (0o600 manifest) and are redacted from the public preview.
 * @param {string} text
 * @returns {Record<string, object>}
 */
function parseCodexMcpToml(text) {
  /** @type {Record<string, Record<string, unknown>>} */
  const servers = {};
  let current = null;
  let table = "main";
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const hash = rawLine.indexOf("#");
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const parts = splitTomlTableKey(header[1]);
      if (parts[0] !== "mcp_servers" || parts.length < 2) {
        current = null;
        table = "main";
        continue;
      }
      current = parts[1];
      if (!servers[current]) servers[current] = {};
      table = parts[2] === "env" || parts[2] === "http_headers" ? parts[2] : "main";
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const valueRaw = line.slice(eq + 1).trim();
    if (!key) continue;
    const arr = parseTomlArray(valueRaw);
    const value = arr || parseTomlScalar(valueRaw);
    if (table === "env" || table === "http_headers") {
      if (!servers[current][table] || typeof servers[current][table] !== "object") {
        servers[current][table] = {};
      }
      if (typeof value === "string") {
        /** @type {Record<string, string>} */ (servers[current][table])[key] =
          value;
      }
      continue;
    }
    if (key === "env" || key === "http_headers") continue;
    servers[current][key] = value;
  }
  return servers;
}

function tomlServersToConfig(map) {
  /** @type {Record<string, object>} */
  const mcpServers = {};
  for (const [name, def] of Object.entries(map || {})) {
    if (!def || typeof def !== "object") continue;
    /** @type {Record<string, unknown>} */
    const row = {};
    if (typeof def.command === "string") row.command = def.command;
    if (Array.isArray(def.args)) row.args = def.args.map(String);
    if (typeof def.url === "string") row.url = def.url;
    if (typeof def.cwd === "string") row.cwd = def.cwd;
    if (typeof def.type === "string") row.type = def.type;
    if (def.env && typeof def.env === "object") row.env = def.env;
    const headers = def.http_headers || def.headers;
    if (headers && typeof headers === "object") row.headers = headers;
    mcpServers[name] = row;
  }
  return { mcpServers };
}

function parseJsonMcpFile(file, warnings) {
  const raw = readCappedFile(file, MAX_JSON_BYTES);
  if (raw == null) return [];
  try {
    const parsed = parseMcpConfigDocument(raw);
    warnings.push(...(parsed.warnings || []));
    return parsed.servers || [];
  } catch (err) {
    if (err && /No MCP servers/.test(String(err.message || ""))) return [];
    warnings.push(
      `${path.basename(file)}: ${err && err.message ? err.message : err}`,
    );
    return [];
  }
}

function mcpFilesForSource(id, home, env) {
  const userHome = (env && env.HOME) || os.homedir();
  if (id === "claude") {
    return [
      path.join(home, ".mcp.json"),
      path.join(home, "mcp.json"),
      path.join(home, "settings.json"),
      path.join(userHome, ".claude.json"),
    ];
  }
  if (id === "cursor") {
    return [path.join(home, "mcp.json")];
  }
  if (id === "codex") {
    return [path.join(home, "config.toml")];
  }
  return [];
}

function scanMcp(id, home, env, current, warnings) {
  const existing = existingNameSet(current);
  /** @type {Map<string, { stored: object, meta: object }>} */
  const byName = new Map();
  for (const file of mcpFilesForSource(id, home, env)) {
    if (!isPlainFile(file)) continue;
    if (path.extname(file).toLowerCase() === ".toml") {
      const raw = readCappedFile(file, MAX_JSON_BYTES);
      if (raw == null) continue;
      try {
        const parsed = parseMcpConfigDocument(
          tomlServersToConfig(parseCodexMcpToml(raw)),
        );
        warnings.push(...(parsed.warnings || []));
        for (const server of parsed.servers || []) {
          if (!byName.has(server.stored.name)) byName.set(server.stored.name, server);
        }
      } catch (err) {
        if (!err || !/No MCP servers/.test(String(err.message || ""))) {
          warnings.push(
            `${path.basename(file)}: ${err && err.message ? err.message : err}`,
          );
        }
      }
      continue;
    }
    for (const server of parseJsonMcpFile(file, warnings)) {
      if (!byName.has(server.stored.name)) byName.set(server.stored.name, server);
    }
  }
  const rows = [...byName.values()].sort((a, b) =>
    a.stored.name < b.stored.name ? -1 : 1,
  );
  return rows.map((parsed) => {
    const stored = parsed.stored;
    const meta = parsed.meta || {};
    const envNames = [...(meta.envNames || [])];
    const headerNames = [...(meta.headerNames || [])];
    const requiredSecrets = Array.isArray(meta.requiredSecrets)
      ? meta.requiredSecrets.map((s) => ({ id: s.id, label: s.label }))
      : [];
    const collision = existing.has(stored.name);
    const row = {
      id: `mcp:${stored.name}`,
      name: stored.name,
      transport: stored.transport,
      envNames,
      headerNames,
      hasToken: Boolean(meta.hasToken),
      hasSecrets:
        requiredSecrets.length > 0 ||
        envNames.length > 0 ||
        headerNames.length > 0,
      requiredSecrets,
      requiresTrust: stored.transport === "stdio",
      collision,
      alreadyImported: collision,
      warnings: collision
        ? ["A server with this name already exists"]
        : [...(meta.warnings || [])],
    };
    if (stored.transport === "stdio") {
      row.command = stored.command;
      row.args = Array.isArray(stored.args) ? [...stored.args] : [];
      if (stored.cwd) row.cwd = stored.cwd;
    } else {
      row.url = stored.url;
    }
    return { public: row, stored, meta };
  });
}

function addMarkdownItem(file, home, kind, titlePrefix, out, cap, warnings) {
  if (out.length >= cap) {
    warnings.push(`${kind} scan reached the file cap`);
    return;
  }
  if (!isPlainFile(file)) return;
  const body = readCappedFile(file, MAX_MD_BYTES);
  if (body == null || !String(body).trim()) return;
  const rel = isInside(home, file)
    ? path.relative(home, file).split(path.sep).join("/")
    : path.basename(file);
  const title = `${titlePrefix}${titleFromMarkdown(body, path.basename(file, path.extname(file)))}`;
  const id = `${kind}:${sha16([rel, "\0", body])}`;
  out.push({
    id,
    title,
    excerpt: excerptText(body, 140),
    bytes: Buffer.byteLength(body),
    rel,
    body,
    alreadyImported: false,
  });
}

function scanMemories(id, home, projectPath, warnings) {
  /** @type {Array<object>} */
  const out = [];
  if (id === "claude" && projectPath) {
    const encoded = encodeClaudeProjectDir(projectPath);
    if (encoded) {
      const memDir = path.join(home, "projects", encoded, "memory");
      if (isPlainDir(memDir) && isInside(home, memDir)) {
        let ents;
        try {
          ents = fs.readdirSync(memDir, { withFileTypes: true });
        } catch {
          ents = [];
        }
        for (const ent of ents) {
          if (!ent.isFile() || ent.isSymbolicLink()) continue;
          if (!/\.(md|txt)$/i.test(ent.name)) continue;
          addMarkdownItem(
            path.join(memDir, ent.name),
            home,
            "memory",
            "Claude memory · ",
            out,
            MAX_MEMORY_FILES,
            warnings,
          );
        }
      }
      addMarkdownItem(
        path.join(home, "projects", encoded, "MEMORY.md"),
        home,
        "memory",
        "Claude memory · ",
        out,
        MAX_MEMORY_FILES,
        warnings,
      );
    }
  }
  if (id === "codex") {
    for (const rel of ["memories", "memory"]) {
      const dir = path.join(home, rel);
      if (!isPlainDir(dir) || !isInside(home, dir)) continue;
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of ents) {
        if (!ent.isFile() || ent.isSymbolicLink()) continue;
        if (!/\.(md|txt)$/i.test(ent.name)) continue;
        addMarkdownItem(
          path.join(dir, ent.name),
          home,
          "memory",
          "Codex memory · ",
          out,
          MAX_MEMORY_FILES,
          warnings,
        );
      }
    }
  }
  return out;
}

function scanInstructions(id, home, projectPath, warnings) {
  /** @type {Array<object>} */
  const out = [];
  const prefix =
    id === "claude" ? "Claude instructions · " : id === "cursor" ? "Cursor rules · " : "Codex instructions · ";
  if (id === "claude") {
    addMarkdownItem(
      path.join(home, "CLAUDE.md"),
      home,
      "instruction",
      prefix,
      out,
      MAX_INSTRUCTION_FILES,
      warnings,
    );
  }
  if (id === "codex") {
    addMarkdownItem(
      path.join(home, "AGENTS.md"),
      home,
      "instruction",
      prefix,
      out,
      MAX_INSTRUCTION_FILES,
      warnings,
    );
  }
  const project = typeof projectPath === "string" ? projectPath.trim() : "";
  if (project && isPlainDir(project)) {
    const files = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules"];
    for (const name of files) {
      addMarkdownItem(
        path.join(project, name),
        project,
        "instruction",
        prefix,
        out,
        MAX_INSTRUCTION_FILES,
        warnings,
      );
    }
    const rulesDir = path.join(project, ".cursor", "rules");
    if (isPlainDir(rulesDir) && isInside(project, rulesDir)) {
      let ents;
      try {
        ents = fs.readdirSync(rulesDir, { withFileTypes: true });
      } catch {
        ents = [];
      }
      for (const ent of ents) {
        if (!ent.isFile() || ent.isSymbolicLink()) continue;
        if (!/\.(md|mdc)$/i.test(ent.name)) continue;
        addMarkdownItem(
          path.join(rulesDir, ent.name),
          project,
          "instruction",
          prefix,
          out,
          MAX_INSTRUCTION_FILES,
          warnings,
        );
      }
    }
  }
  return out;
}

function collectEnvKeys(obj, into) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    if (typeof key === "string" && key) into.add(key);
  }
}

function scanSettings(id, home, env) {
  /** @type {Set<string>} */
  const envKeys = new Set();
  /** @type {boolean | null} */
  let sandboxEnabled = null;
  if (id === "claude") {
    const files = [
      path.join(home, "settings.json"),
      path.join((env && env.HOME) || os.homedir(), ".claude.json"),
    ];
    for (const file of files) {
      const raw = readCappedFile(file, MAX_JSON_BYTES);
      if (raw == null) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      collectEnvKeys(obj.env, envKeys);
      if (obj.sandbox && typeof obj.sandbox === "object") {
        if (typeof obj.sandbox.enabled === "boolean") {
          sandboxEnabled = obj.sandbox.enabled;
        }
      }
    }
  }
  if (id === "codex") {
    const raw = readCappedFile(path.join(home, "config.toml"), MAX_JSON_BYTES);
    if (raw != null) {
      const sandboxMatch = raw.match(/^\s*sandbox_mode\s*=\s*"?([A-Za-z0-9_-]+)"?/m);
      if (sandboxMatch) {
        sandboxEnabled = sandboxMatch[1] !== "disabled" && sandboxMatch[1] !== "off";
      }
      const enabledMatch = raw.match(/^\s*enabled\s*=\s*(true|false)/im);
      if (raw.includes("[sandbox]") && enabledMatch) {
        sandboxEnabled = enabledMatch[1] === "true";
      }
    }
  }
  if (id === "cursor") {
    const raw = readCappedFile(path.join(home, "argv.json"), MAX_JSON_BYTES);
    if (raw != null) {
      try {
        const obj = JSON.parse(raw);
        collectEnvKeys(obj && obj.env, envKeys);
      } catch {
        // ignore
      }
    }
  }
  if (!envKeys.size && sandboxEnabled == null) return null;
  const keys = [...envKeys].sort();
  const bits = [];
  if (keys.length) bits.push(`env keys: ${keys.join(", ")}`);
  if (sandboxEnabled != null) bits.push(`sandbox enabled: ${sandboxEnabled}`);
  const summary = bits.join("; ") || "no mappable settings";
  const body = [
    `Imported from ${sourceMeta(id).label}. Solenta did not apply permission modes or env values.`,
    "",
    summary,
  ].join("\n");
  return {
    id: `settings:${id}`,
    title: `Imported ${sourceMeta(id).label} settings`,
    summary,
    body,
    alreadyImported: false,
  };
}

function copySkillTree(src, dest) {
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
  let files = 0;
  for (const ent of ents) {
    if (ent.isSymbolicLink() || ent.name.includes("\0")) continue;
    if (ent.name === MARKER_NAME) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (!isInside(src, from)) continue;
    if (ent.isDirectory()) {
      copySkillTree(from, to);
    } else if (ent.isFile()) {
      files += 1;
      if (files > MAX_SKILL_TREE_FILES) {
        throw new Error("Skill package has too many files");
      }
      fs.copyFileSync(from, to);
    }
  }
}

function stageSkill(home, rel, destRoot) {
  const src = path.resolve(home, ...String(rel || "").split("/").filter(Boolean));
  if (!isInside(home, src) || !isPlainDir(src)) {
    throw new Error("Skill path escapes the harness home");
  }
  const dest = path.join(destRoot, path.basename(src));
  copySkillTree(src, dest);
  return path.basename(src);
}

async function titlesInMemory(memory, titles, projectPath) {
  const found = new Set();
  if (!memory || typeof memory.search !== "function") return found;
  for (const title of titles) {
    try {
      const rows = await memory.search({
        query: title,
        project: projectPath || undefined,
      });
      const list = Array.isArray(rows) ? rows : [];
      if (list.some((row) => row && row.title === title)) found.add(title);
    } catch {
      // Memory server optional during preview.
    }
  }
  return found;
}

function publicPreview(manifest) {
  return {
    previewId: manifest.previewId,
    source: {
      id: manifest.sourceId,
      label: manifest.sourceLabel,
    },
    skills: (manifest.skills || []).map((s) => ({
      id: `skill:${s.name}`,
      name: s.name,
      description: s.description,
      origin: s.origin,
      bytes: s.bytes,
      alreadyImported: Boolean(s.alreadyImported),
      warnings: [...(s.warnings || [])],
    })),
    commands: (manifest.commands || []).map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      origin: c.origin,
      bytes: c.bytes,
      alreadyImported: Boolean(c.alreadyImported),
    })),
    mcp: (manifest.mcp || []).map((row) => ({ ...row.public })),
    memories: (manifest.memories || []).map((m) => ({
      id: m.id,
      title: m.title,
      excerpt: m.excerpt,
      bytes: m.bytes,
      alreadyImported: Boolean(m.alreadyImported),
    })),
    instructions: (manifest.instructions || []).map((m) => ({
      id: m.id,
      title: m.title,
      excerpt: m.excerpt,
      bytes: m.bytes,
      alreadyImported: Boolean(m.alreadyImported),
    })),
    settings: manifest.settings
      ? {
          id: manifest.settings.id,
          title: manifest.settings.title,
          summary: manifest.settings.summary,
          alreadyImported: Boolean(manifest.settings.alreadyImported),
        }
      : null,
    warnings: [...(manifest.warnings || [])],
  };
}

async function previewImport(opts) {
  const userDataPath = requireUserData(opts && opts.userDataPath);
  const env = (opts && opts.env) || process.env;
  const now = nowMs(opts && opts.now);
  const meta = sourceMeta(opts && opts.source);
  if (!meta) throw new Error("Unknown harness source");
  const home = resolveHarnessHome(meta.id, env);
  if (!homeExists(home)) {
    throw new Error(`${meta.label} home not found`);
  }
  cleanStalePreviews(userDataPath, now);
  const previewId = crypto.randomBytes(16).toString("hex");
  const previewDir = resolvePreviewDir(userDataPath, previewId);
  fs.mkdirSync(previewDir, { recursive: true });
  const stageDir = path.join(previewDir, "stage");
  fs.mkdirSync(stageDir, { recursive: true });
  const warnings = [];
  const projectPath =
    opts && typeof opts.projectPath === "string" && opts.projectPath.trim()
      ? opts.projectPath.trim()
      : "";
  try {
    const skills = scanSkills(meta.id, home, env, warnings);
    const commands = scanCommands(meta.id, home, projectPath, env, warnings);
    const mcp = scanMcp(meta.id, home, env, opts && opts.current, warnings);
    const memories = scanMemories(meta.id, home, projectPath, warnings);
    const instructions = scanInstructions(meta.id, home, projectPath, warnings);
    const settings = scanSettings(meta.id, home, env);

    const skillStage = path.join(stageDir, "skills");
    fs.mkdirSync(skillStage, { recursive: true });
    for (const skill of skills) {
      try {
        stageSkill(home, skill.rel, skillStage);
      } catch (err) {
        warnings.push(
          `${skill.name}: ${err && err.message ? err.message : err}`,
        );
      }
    }

    const commandStage = path.join(stageDir, "commands");
    fs.mkdirSync(commandStage, { recursive: true });
    for (const cmd of commands) {
      try {
        let srcRoot;
        let stageDest;
        if (cmd.origin === "project") {
          srcRoot = path.join(projectPath, ".claude", "commands");
          stageDest = path.join(commandStage, "project");
        } else if (cmd.origin === "plugin") {
          const pluginRoot = path.join(home, cmd.pluginRel);
          if (!isInside(home, pluginRoot)) {
            throw new Error("Plugin path escapes the harness home");
          }
          srcRoot =
            cmd.commandDirRel && cmd.commandDirRel !== "."
              ? path.join(
                  pluginRoot,
                  ...String(cmd.commandDirRel).split("/").filter(Boolean),
                )
              : pluginRoot;
          if (!isInside(pluginRoot, srcRoot)) {
            throw new Error("Plugin command path escapes the plugin root");
          }
          stageDest = path.join(commandStage, "plugin", cmd.pluginName);
        } else {
          srcRoot = path.join(home, "commands");
          stageDest = path.join(commandStage, "user");
        }
        stageCommand(srcRoot, cmd.rel, stageDest);
      } catch (err) {
        warnings.push(
          `${cmd.name}: ${err && err.message ? err.message : err}`,
        );
      }
    }

    const textTitles = [
      ...memories.map((m) => m.title),
      ...instructions.map((m) => m.title),
    ];
    if (settings) textTitles.push(settings.title);
    const already = await titlesInMemory(opts && opts.memory, textTitles, projectPath);
    for (const row of memories) {
      if (already.has(row.title)) row.alreadyImported = true;
    }
    for (const row of instructions) {
      if (already.has(row.title)) row.alreadyImported = true;
    }
    if (settings && already.has(settings.title)) settings.alreadyImported = true;

    const empty =
      skills.length === 0 &&
      commands.length === 0 &&
      mcp.length === 0 &&
      memories.length === 0 &&
      instructions.length === 0 &&
      !settings;
    if (empty) warnings.push(`Nothing new to import from ${meta.label}`);

    const manifest = {
      previewId,
      createdAt: now,
      sourceId: meta.id,
      sourceLabel: meta.label,
      home,
      projectPath,
      warnings,
      skills,
      commands,
      mcp,
      memories,
      instructions,
      settings,
    };
    const manifestPath = path.join(previewDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(manifestPath, 0o600);
    } catch {
      // best-effort
    }
    return publicPreview(manifest);
  } catch (err) {
    fs.rmSync(previewDir, { recursive: true, force: true });
    throw err;
  }
}

function loadManifest(userDataPath, previewId, now) {
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

function writeOwnedMarker(dir, marker) {
  /** @type {Record<string, string>} */
  const clean = { installId: marker.installId };
  if (marker.sourceLabel) clean.sourceLabel = marker.sourceLabel;
  fs.writeFileSync(
    path.join(dir, MARKER_NAME),
    `${JSON.stringify(clean, null, 2)}\n`,
    { mode: 0o644 },
  );
}

function resolveSkillDest(target, name, env) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!SKILL_NAME_RE.test(n)) {
    throw new Error(`Skill name must be lowercase letters, digits, dashes (got "${n}")`);
  }
  const base = skillBaseDir(target, env);
  const dir = path.join(base, n);
  if (path.relative(base, dir) !== n) {
    throw new Error("Skill path escapes the skills directory");
  }
  return dir;
}

function installSkills(manifest, selected, replace, env, userDataPath, dir) {
  /** @type {Array<{ name: string, status: "installed" | "skipped" | "replaced" }>} */
  const results = [];
  const active = activeSkillTargets(env);
  const byName = new Map((manifest.skills || []).map((s) => [s.name, s]));
  const now = new Date().toISOString();
  for (const name of selected) {
    if (!name.startsWith("skill:")) continue;
    const skillName = name.slice("skill:".length);
    const row = byName.get(skillName);
    if (!row) throw new Error(`Unknown skill in this preview: ${skillName}`);
    const exists = hasSkillCollision(skillName, env);
    if (exists && !replace) {
      results.push({ name: skillName, status: "skipped" });
      continue;
    }
    if (!active.length) {
      throw new Error("No active skill targets. Set up a supported CLI first.");
    }
    const src = path.join(dir, "stage", "skills", skillName);
    if (!isPlainFile(path.join(src, "SKILL.md"))) {
      throw new Error(`Skill package is missing SKILL.md: ${skillName}`);
    }
    const installId = newInstallId();
    for (const target of active) {
      const dest = resolveSkillDest(target, skillName, env);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      copySkillTree(src, dest);
      writeOwnedMarker(dest, {
        installId,
        sourceLabel: manifest.sourceLabel,
      });
    }
    commitInstalls(userDataPath, {
      removeIds: installIdsForName(userDataPath, skillName),
      add: {
        [installId]: {
          name: skillName,
          provenance: "added",
          sourceLabel: manifest.sourceLabel,
          importedAt: now,
        },
      },
    });
    results.push({ name: skillName, status: exists ? "replaced" : "installed" });
  }
  return results;
}

function installCommands(manifest, selected, replace, env, dir) {
  /** @type {Array<{ name: string, status: "installed" | "skipped" | "replaced" }>} */
  const results = [];
  const byId = new Map((manifest.commands || []).map((c) => [c.id, c]));
  const projectPath = manifest.projectPath || "";
  for (const id of selected) {
    if (!id.startsWith("command:")) continue;
    const row = byId.get(id);
    if (!row) throw new Error(`Unknown command in this preview: ${id}`);
    if (
      row.origin === "plugin" &&
      !PLUGIN_NAME_RE.test(String(row.pluginName || ""))
    ) {
      throw new Error(`Unknown command in this preview: ${id}`);
    }
    const destRel = row.destRel || row.rel;
    const destScope = row.origin === "project" ? "project" : "user";
    const exists = hasCommandCollision(destScope, destRel, env, projectPath);
    if (exists && !replace) {
      results.push({ name: row.name, status: "skipped" });
      continue;
    }
    const srcParts =
      row.origin === "plugin" ? ["plugin", row.pluginName] : [row.origin];
    const src = path.join(
      dir,
      "stage",
      "commands",
      ...srcParts,
      ...String(row.rel || "").split("/").filter(Boolean),
    );
    if (!isPlainFile(src)) {
      throw new Error(`Command file is missing from the preview: ${row.name}`);
    }
    const dest = commandDestPath(destScope, destRel, env, projectPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.copyFileSync(src, dest);
    results.push({ name: row.name, status: exists ? "replaced" : "installed" });
  }
  return results;
}

function installMcp(manifest, selected, replace, trustLocal, current, saveMcp) {
  /** @type {Array<{ name: string, status: "installed" | "skipped" | "replaced" }>} */
  const results = [];
  const existing = existingNameSet(current);
  const selectedSet = new Set(selected);
  let nextList = Array.isArray(current) ? current.slice() : [];
  let dirty = false;
  for (const row of manifest.mcp || []) {
    const stored = row && row.stored;
    if (!stored || !selectedSet.has(`mcp:${stored.name}`)) continue;
    const exists = existing.has(stored.name);
    if (exists && !replace) {
      results.push({ name: stored.name, status: "skipped" });
      continue;
    }
    if (stored.transport === "stdio" && trustLocal !== true) {
      throw new Error("Local MCP commands require explicit trust");
    }
    const entry = {
      ...stored,
      args: Array.isArray(stored.args) ? [...stored.args] : stored.args,
      env: stored.env ? { ...stored.env } : stored.env,
      headers: stored.headers ? { ...stored.headers } : stored.headers,
      provenance: "added",
    };
    if (entry.transport === "stdio") {
      entry.trusted = true;
      entry.enabled = true;
    }
    const { upsertMcpServer } = require("./mcp.js");
    nextList = upsertMcpServer(nextList, entry);
    dirty = true;
    results.push({ name: stored.name, status: exists ? "replaced" : "installed" });
  }
  if (dirty) {
    if (typeof saveMcp !== "function") {
      throw new Error("MCP save is not configured");
    }
    saveMcp(nextList);
  }
  return results;
}

async function storeTextItems(rows, selectedPrefix, selected, memory, projectPath, type) {
  /** @type {Array<{ title: string, status: "stored" | "skipped" }>} */
  const results = [];
  if (!rows || !rows.length) return results;
  const selectedSet = new Set(selected);
  for (const row of rows) {
    if (!selectedSet.has(row.id) && !row.id.startsWith(selectedPrefix)) continue;
    if (!selectedSet.has(row.id)) continue;
    if (!memory || typeof memory.store !== "function") {
      results.push({ title: row.title, status: "skipped" });
      continue;
    }
    try {
      await memory.store({
        type,
        title: row.title,
        body: row.body,
        project: projectPath || undefined,
        source: "import",
        importance: type === "convention" ? 5 : 3,
        citations: row.rel
          ? [{ kind: "file", path: row.rel }]
          : undefined,
      });
      results.push({ title: row.title, status: "stored" });
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      if (/near-duplicate/i.test(msg) || /not running/i.test(msg)) {
        results.push({ title: row.title, status: "skipped" });
        continue;
      }
      throw err;
    }
  }
  return results;
}

async function installImport(opts) {
  const request = (opts && opts.request) || {};
  const userDataPath = requireUserData(opts && opts.userDataPath);
  const env = (opts && opts.env) || process.env;
  const now = nowMs(opts && opts.now);
  const { dir, raw } = loadManifest(userDataPath, request.previewId, now);
  cleanStalePreviews(userDataPath, now, raw.previewId || request.previewId);
  const selected = Array.isArray(request.selected)
    ? request.selected.map((n) => String(n || "").trim()).filter(Boolean)
    : [];
  if (!selected.length) throw new Error("Select at least one item to import");
  const replace = request.replace === true;
  const trustLocal = request.trustLocal === true;
  const projectPath =
    (opts && opts.projectPath) || raw.projectPath || "";

  const skills = installSkills(
    raw,
    selected,
    replace,
    env,
    userDataPath,
    dir,
  );
  const commands = installCommands(raw, selected, replace, env, dir);
  const mcp = installMcp(
    raw,
    selected,
    replace,
    trustLocal,
    opts && opts.current,
    opts && opts.saveMcp,
  );
  const memories = await storeTextItems(
    raw.memories,
    "memory:",
    selected,
    opts && opts.memory,
    projectPath,
    "knowledge",
  );
  const instructions = await storeTextItems(
    raw.instructions,
    "instruction:",
    selected,
    opts && opts.memory,
    projectPath,
    "convention",
  );
  /** @type {{ status: "stored" | "skipped" } | null} */
  let settings = null;
  if (raw.settings && selected.includes(raw.settings.id)) {
    const stored = await storeTextItems(
      [raw.settings],
      "settings:",
      selected,
      opts && opts.memory,
      projectPath,
      "convention",
    );
    settings = stored[0]
      ? { status: stored[0].status }
      : { status: "skipped" };
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return { skills, commands, mcp, memories, instructions, settings };
}

function discardImport(opts) {
  const dir = resolvePreviewDir(opts && opts.userDataPath, opts && opts.previewId);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  PREVIEW_TTL_MS,
  detectSources,
  previewImport,
  installImport,
  discardImport,
  parseCodexMcpToml,
};
