"use strict";

/**
 * Cursor and Codex plugin-root walks shared by the live / palette
 * (cliCommands.listInvocableCommands) and Skills-tab import
 * (harnessImports.pluginRootsForSource). Callers pass the already-resolved
 * home. Plugin files are never executed.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_JSON_BYTES = 512 * 1024;
const MAX_PLUGIN_GROUPS = 40;
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

/**
 * `plugins/installed.json` `user` entries: `"name@marketplace"` or `"name"`.
 * @param {string} raw
 * @returns {{ name: string, marketplace: string }[]}
 */
function parseCursorInstalledSpecs(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const user = json && Array.isArray(json.user) ? json.user : [];
  /** @type {{ name: string, marketplace: string }[]} */
  const out = [];
  for (const item of user) {
    if (typeof item !== "string") continue;
    const spec = item.trim();
    if (!spec) continue;
    const at = spec.lastIndexOf("@");
    if (at > 0) {
      out.push({ name: spec.slice(0, at), marketplace: spec.slice(at + 1) });
    } else {
      out.push({ name: spec, marketplace: "" });
    }
  }
  return out;
}

/**
 * `[plugins."name@marketplace"]` tables with `enabled = true`.
 * Nested plugin subtables and disabled rows are ignored.
 * @param {string} text
 * @returns {{ enabled: string[] }}
 */
function parseCodexPluginTables(text) {
  /** @type {string[]} */
  const enabled = [];
  /** @type {string | null} */
  let current = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const hash = rawLine.indexOf("#");
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const parts = splitTomlTableKey(header[1]);
      current =
        parts[0] === "plugins" && parts.length === 2 && parts[1]
          ? parts[1]
          : null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = parseTomlScalar(line.slice(eq + 1).trim());
    if (key === "enabled" && value === true) enabled.push(current);
  }
  return { enabled };
}

function listVersionDirs(dir) {
  if (!isPlainDir(dir)) return [];
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter(
      (ent) =>
        ent.isDirectory() &&
        !ent.isSymbolicLink() &&
        !ent.name.includes("\0") &&
        !IGNORED_DIRS.has(ent.name) &&
        ent.name !== "." &&
        ent.name !== "..",
    )
    .map((ent) => path.join(dir, ent.name));
}

/**
 * Cursor plugin roots: plugins/local/<name>, plus installed.json user
 * entries at plugins/cache/<marketplace>/<name>/<hash>. Unlisted cache
 * trees stay out.
 * @param {string} home
 * @returns {string[]}
 */
function collectCursorPluginRoots(home) {
  const plugins = path.join(home, "plugins");
  const local = path.join(plugins, "local");
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const child of listVersionDirs(local)) {
    if (!isInside(plugins, child) || !isInside(local, child)) continue;
    if (!isPlainDir(child)) continue;
    if (seen.has(child)) continue;
    seen.add(child);
    out.push(child);
    if (out.length >= MAX_PLUGIN_GROUPS) return out;
  }

  const raw = readCappedFile(path.join(plugins, "installed.json"), MAX_JSON_BYTES);
  if (raw == null) return out;
  for (const spec of parseCursorInstalledSpecs(raw)) {
    const name = spec.name;
    if (!PLUGIN_NAME_RE.test(name)) continue;
    const marketplaces = spec.marketplace
      ? [spec.marketplace]
      : listVersionDirs(path.join(plugins, "cache")).map((dir) =>
          path.basename(dir),
        );
    for (const mp of marketplaces) {
      if (!PLUGIN_NAME_RE.test(mp)) continue;
      const cacheRoot = path.join(plugins, "cache", mp, name);
      if (!isInside(plugins, cacheRoot)) continue;
      for (const versionDir of listVersionDirs(cacheRoot)) {
        if (!isInside(cacheRoot, versionDir) || !isPlainDir(versionDir)) continue;
        if (seen.has(versionDir)) continue;
        seen.add(versionDir);
        out.push(versionDir);
        if (out.length >= MAX_PLUGIN_GROUPS) return out;
      }
    }
  }
  return out;
}

/**
 * Enabled Codex plugin version dirs: config.toml plus
 * plugins/cache/<marketplace>/<name>/<version>. Never the rest of cache.
 * @param {string} home
 * @returns {string[]}
 */
function collectCodexPluginRoots(home) {
  const plugins = path.join(home, "plugins");
  const raw = readCappedFile(path.join(home, "config.toml"), MAX_JSON_BYTES);
  if (raw == null) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const spec of parseCodexPluginTables(raw).enabled) {
    const at = String(spec).lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const mp = spec.slice(at + 1);
    if (!PLUGIN_NAME_RE.test(name) || !PLUGIN_NAME_RE.test(mp)) continue;
    const cacheRoot = path.join(plugins, "cache", mp, name);
    if (!isInside(plugins, cacheRoot)) continue;
    for (const versionDir of listVersionDirs(cacheRoot)) {
      if (!isInside(cacheRoot, versionDir) || !isPlainDir(versionDir)) continue;
      if (seen.has(versionDir)) continue;
      seen.add(versionDir);
      out.push(versionDir);
      if (out.length >= MAX_PLUGIN_GROUPS) return out;
    }
  }
  return out;
}

module.exports = {
  collectCursorPluginRoots,
  collectCodexPluginRoots,
};
