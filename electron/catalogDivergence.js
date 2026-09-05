"use strict";

/**
 * Compare a provider snapshot (electron/providers.js) to a cheap local CLI
 * catalog. Issue #745: warn when they diverge; never merge live ids into the
 * picker and never probe the network.
 *
 * Live sources, in order:
 *   Codex  ~/.codex/models_cache.json (visibility=list only)
 *   Grok   ~/.grok/models_cache.json, else `grok models` (CLI cache)
 *   Kimi   ~/.kimi-code/config.toml [models."..."] alias keys
 *   OpenCode `opencode models` (CLI cache; the models.json dump is every
 *            paid provider and must not be compared)
 *   Cursor `cursor-agent --list-models` (CLI cache)
 *   Claude skip: `claude --help` does not enumerate models
 *
 * Missing cache / failed parse / skipped Claude = no warning.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NOTE_ID_CAP = 3;
const FILE_BYTE_CAP = 2 * 1024 * 1024;

/**
 * @param {string[] | null | undefined} snapshotIds
 * @param {string[] | null | undefined} liveIds
 * @returns {{ extraLive: string[], extraSnapshot: string[] } | null}
 */
function diffCatalog(snapshotIds, liveIds) {
  if (!Array.isArray(liveIds)) return null;
  const snap = Array.isArray(snapshotIds) ? snapshotIds.map(String) : [];
  const live = liveIds.map(String);
  const snapSet = new Set(snap);
  const liveSet = new Set(live);
  const extraLive = [];
  const extraSnapshot = [];
  const seenLive = new Set();
  for (const id of live) {
    if (seenLive.has(id)) continue;
    seenLive.add(id);
    if (!snapSet.has(id)) extraLive.push(id);
  }
  const seenSnap = new Set();
  for (const id of snap) {
    if (seenSnap.has(id)) continue;
    seenSnap.add(id);
    if (!liveSet.has(id)) extraSnapshot.push(id);
  }
  return { extraLive, extraSnapshot };
}

/**
 * @param {string[]} ids
 */
function formatIdList(ids) {
  if (ids.length <= NOTE_ID_CAP) return ids.join(", ");
  return `${ids.slice(0, NOTE_ID_CAP).join(", ")}, and ${ids.length - NOTE_ID_CAP} more`;
}

/**
 * One line per harness. Null when there is nothing to say.
 *
 * @param {{ name: string, extraLive: string[], extraSnapshot: string[] }} input
 * @returns {string | null}
 */
function formatCatalogNote(input) {
  const name = String((input && input.name) || "").trim() || "Provider";
  const extraLive = Array.isArray(input && input.extraLive) ? input.extraLive : [];
  const extraSnapshot = Array.isArray(input && input.extraSnapshot)
    ? input.extraSnapshot
    : [];
  if (extraLive.length === 0 && extraSnapshot.length === 0) return null;
  const parts = [];
  if (extraLive.length > 0) {
    parts.push(
      `${name} CLI lists ${formatIdList(extraLive)}; snapshot does not`,
    );
  }
  if (extraSnapshot.length > 0) {
    parts.push(
      `Snapshot lists ${formatIdList(extraSnapshot)}; CLI does not`,
    );
  }
  if (extraLive.length > 0) {
    parts.push("Use Custom... for unlisted ids");
  }
  return `${parts.join(". ")}.`;
}

/**
 * @param {unknown} json
 * @returns {string[] | null}
 */
function parseCodexCache(json) {
  if (!json || typeof json !== "object") return null;
  const models = json.models;
  let entries;
  if (Array.isArray(models)) entries = models;
  else if (models && typeof models === "object") entries = Object.values(models);
  else return null;
  const ids = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.visibility !== "list") continue;
    const slug = entry.slug;
    if (typeof slug === "string" && slug) ids.push(slug);
  }
  return ids;
}

/**
 * @param {unknown} json
 * @returns {string[] | null}
 */
function parseGrokCache(json) {
  if (!json || typeof json !== "object") return null;
  const models = json.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const ids = [];
  for (const [id, val] of Object.entries(models)) {
    if (!id) continue;
    const hidden =
      val && typeof val === "object"
        ? val.hidden === true ||
          (val.info && typeof val.info === "object" && val.info.hidden === true)
        : false;
    if (hidden) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Alias keys from `[models."kimi-code/k3"]` tables. `-m` takes the alias.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseKimiToml(text) {
  const ids = [];
  const re = /^\[models\."([^"]+)"\]/gm;
  let m;
  while ((m = re.exec(String(text || "")))) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * `opencode models` prints one `provider/model` id per line.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
function parseOpencodeModels(text) {
  const ids = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /\s/.test(t) || !t.includes("/")) continue;
    ids.push(t);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * CSI / OSC / C1. cursor-agent --list-models colors even when stdout is
 * not a TTY (`\x1b[36mauto\x1b[39m \x1b[2m- Auto\x1b[22m...`).
 */
const ANSI_RE = new RegExp(
  "\\u001B\\[[0-?]*[ -\\/]*[@-~]" +
    "|\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)" +
    "|\\u001B[@-Z\\\\-_]",
  "g",
);

function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "");
}

/**
 * `cursor-agent --list-models` prints `id - Label` after a header.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
function parseCursorListModels(text) {
  const ids = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+) - /);
    if (m && m[1]) ids.push(m[1]);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * `grok models` prints `* grok-4.6 (default)` / `- grok-4.5`.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
function parseGrokModelsOutput(text) {
  const ids = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.trim().match(/^[*+-]\s+(\S+)/);
    if (m && m[1]) ids.push(m[1]);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string | undefined} homeOpt
 */
function resolveHomedir(env, homeOpt) {
  if (homeOpt) return homeOpt;
  const e = env || process.env;
  if (e.HOME) return e.HOME;
  if (e.USERPROFILE) return e.USERPROFILE;
  return os.homedir();
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function defaultReadFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > FILE_BYTE_CAP) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} raw
 * @param {(json: unknown) => string[] | null} parse
 * @returns {string[] | null}
 */
function parseJsonFile(raw, parse) {
  if (raw == null) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Cheap live ids for one harness. Null means "do not warn".
 *
 * @param {string} providerId
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   readFile?: (filePath: string) => string | null,
 *   cliCache?: Map<string, string[] | null>,
 * }} [opts]
 * @returns {string[] | null}
 */
function readLiveIds(providerId, opts = {}) {
  if (!providerId || providerId === "claude" || providerId === "simulate") {
    return null;
  }
  const env = opts.env || process.env;
  const home = resolveHomedir(env, opts.home);
  const read = opts.readFile || defaultReadFile;
  const cache = opts.cliCache;

  if (providerId === "codex") {
    const dir = env.CODEX_HOME || path.join(home, ".codex");
    return parseJsonFile(read(path.join(dir, "models_cache.json")), parseCodexCache);
  }

  if (providerId === "grok") {
    const dir = env.GROK_HOME || path.join(home, ".grok");
    const fromFile = parseJsonFile(
      read(path.join(dir, "models_cache.json")),
      parseGrokCache,
    );
    if (fromFile) return fromFile;
    const cached = cache && cache.get("grok");
    return cached || null;
  }

  if (providerId === "kimi") {
    const dir = env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
    const raw = read(path.join(dir, "config.toml"));
    if (raw == null) return null;
    return parseKimiToml(raw);
  }

  if (providerId === "opencode" || providerId === "cursor") {
    const cached = cache && cache.get(providerId);
    return cached || null;
  }

  return null;
}

/**
 * Parse stdout from a local `models` / `--list-models` command.
 *
 * @param {string} providerId
 * @param {string} text
 * @returns {string[] | null}
 */
function parseCliCatalog(providerId, text) {
  if (providerId === "opencode") return parseOpencodeModels(text);
  if (providerId === "cursor") return parseCursorListModels(text);
  if (providerId === "grok") return parseGrokModelsOutput(text);
  return null;
}

/**
 * Attach `catalogNote` when live ids diverge. Does not rewrite `models`.
 *
 * @param {Array<{ id: string, name?: string, models?: string[], catalogNote?: string }>} providers
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   readFile?: (filePath: string) => string | null,
 *   cliCache?: Map<string, string[] | null>,
 * }} [opts]
 */
function attachCatalogNotes(providers, opts = {}) {
  if (!Array.isArray(providers)) return providers;
  for (const p of providers) {
    if (!p || !p.id) continue;
    const live = readLiveIds(p.id, opts);
    if (!live) continue;
    const diff = diffCatalog(p.models, live);
    if (!diff) continue;
    let note = formatCatalogNote({
      name: p.name || p.id,
      extraLive: diff.extraLive,
      extraSnapshot: diff.extraSnapshot,
    });
    if (note && p.id === "codex" && diff.extraSnapshot.length > 0) {
      note = `${note} Run \`codex update\` to use snapshot-only ids.`;
    }
    if (note) p.catalogNote = note;
    else delete p.catalogNote;
  }
  return providers;
}

/**
 * Prefer live-supported snapshot ids without merging live-only ones (#745).
 * Missing live catalog = no change. Empty live list = no live match, keep
 * snapshot recommended.
 *
 * @param {Array<{
 *   id?: string,
 *   models?: string[],
 *   modelInfo?: Array<{ id: string, recommended?: boolean }>,
 * }>} providers
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   readFile?: (filePath: string) => string | null,
 *   cliCache?: Map<string, string[] | null>,
 * }} [opts]
 */
function alignCatalogWithLive(providers, opts = {}) {
  if (!Array.isArray(providers)) return providers;
  for (const p of providers) {
    if (!p || !p.id) continue;
    const live = readLiveIds(p.id, opts);
    if (!live) continue;
    const liveSet = new Set(live);
    const models = Array.isArray(p.models) ? p.models.map(String) : [];
    if (models.length > 0) {
      const inLive = [];
      const rest = [];
      const seen = new Set();
      for (const id of models) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (liveSet.has(id)) inLive.push(id);
        else rest.push(id);
      }
      p.models = inLive.concat(rest);
    }
    const infos = Array.isArray(p.modelInfo) ? p.modelInfo : [];
    if (infos.length > 0) {
      const byId = new Map(infos.map((m) => [m && m.id, m]));
      const ordered = [];
      const used = new Set();
      for (const id of p.models || []) {
        const row = byId.get(id);
        if (row && !used.has(id)) {
          ordered.push(row);
          used.add(id);
        }
      }
      for (const row of infos) {
        if (row && row.id && !used.has(row.id)) {
          ordered.push(row);
          used.add(row.id);
        }
      }
      const nextRec = ordered.find((m) => liveSet.has(m.id));
      if (nextRec) {
        for (const m of ordered) {
          if (m.id === nextRec.id) m.recommended = true;
          else delete m.recommended;
        }
      }
      p.modelInfo = ordered;
    }
  }
  return providers;
}

module.exports = {
  NOTE_ID_CAP,
  FILE_BYTE_CAP,
  diffCatalog,
  formatCatalogNote,
  parseCodexCache,
  parseGrokCache,
  parseKimiToml,
  parseOpencodeModels,
  parseCursorListModels,
  parseGrokModelsOutput,
  parseCliCatalog,
  readLiveIds,
  attachCatalogNotes,
  alignCatalogWithLive,
  resolveHomedir,
};
