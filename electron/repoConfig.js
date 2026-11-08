"use strict";

/**
 * Checked-in solenta.json (#1506 H3): `setup` and `quickActions` read from
 * the repo root of the project checkout.
 *
 *   { "setup": "npm ci", "quickActions": [{ "name": "Test", "command": "npm test" }] }
 *
 * `onSettle` (#1531) runs in a worktree thread when it settles: a command
 * string, or the name of one of the file's quickActions.
 *
 * Layers (#438), highest first: project settings in the app, then a
 * gitignored solenta.local.json beside it, then solenta.json. App settings
 * win field by field: a stored setupCommand hides the files' `setup`, a
 * stored quickActions list hides the files' list. The two files merge
 * quick actions by id (see parseRepoConfig). `"$schema"` points editors at
 * site/solenta.schema.json; an unknown key makes the file an error.
 *
 * The file is code from whoever can push to the repo, so its commands only
 * run once the user has approved this exact set. The approval is a sha256
 * of the commands stored on the project; editing the file re-prompts.
 *
 * The repo's own environment spec (#396, envSpec.js: devcontainer.json,
 * copilot-setup-steps.yml) fills in where the file is silent: its setup
 * when solenta.json has none, its env always. Both join the same hash.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { normalizeCommand } = require("./verify.js");
const { readEnvSpec } = require("./envSpec.js");

const REPO_CONFIG_FILE = "solenta.json";
/** Gitignored per-checkout override of the commands (#438). */
const LOCAL_CONFIG_FILE = "solenta.local.json";
/** `"$schema"` value for editor autocomplete; served from site/. */
const SCHEMA_URL = "https://solenta.app/solenta.schema.json";
const QUICK_ACTION_MAX = 8;
const ACTION_NAME_MAX = 32;
const ACTION_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_BYTES = 256 * 1024;
/** Stable ids so a header button keeps its identity across reads. */
const REPO_ACTION_ID_PREFIX = "repo:";
/**
 * Every top-level key solenta.json may hold (#438). Anything else is a
 * typo and makes the file an error. Keep in step with site/solenta.schema.json.
 */
const REPO_KEYS = new Set(["$schema", "setup", "quickActions", "onSettle", "automations", "devServer", "iconPath"]);
/** solenta.local.json only overrides commands. */
const LOCAL_KEYS = new Set(["$schema", "setup", "quickActions", "onSettle", "devServer"]);

/** @type {Map<string, { key: string, json?: unknown, error?: string }>} */
const cache = new Map();

/**
 * @typedef {{
 *   setup?: string,
 *   setupSource?: string,
 *   onSettle?: string,
 *   devServerStopOnSettle?: boolean,
 *   quickActions?: Array<{ id: string, name: string, command: string, stopOnSettle?: boolean, source?: string }>,
 *   sources?: string[],
 *   env?: Record<string, string>,
 *   hash?: string,
 *   error?: string,
 * }} RepoConfig
 */

/**
 * @typedef {{ key: string, id?: string, name: string, command: string, stopOnSettle?: boolean, hidden?: boolean, source?: string }} ActionRow
 */

/**
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} keys
 */
function unknownKey(obj, keys) {
  return Object.keys(obj).find((k) => !keys.has(k));
}

/**
 * Validate one file's command keys. onSettle stays raw: it may name a
 * quick action from the other layer, so it resolves after the merge.
 *
 * @param {unknown} data
 * @param {string} file
 * @returns {{ error: string } | { setup?: string, onSettle?: unknown, quickActions?: ActionRow[] }}
 */
function parseLayer(data, file) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: `${file} must be a JSON object` };
  }
  const d = /** @type {Record<string, unknown>} */ (data);
  const local = file === LOCAL_CONFIG_FILE;
  const bad = unknownKey(d, local ? LOCAL_KEYS : REPO_KEYS);
  if (bad) return { error: `${file}: unknown key "${bad}"` };
  if (d.devServer && typeof d.devServer === "object" && !Array.isArray(d.devServer)) {
    const devBad = unknownKey(/** @type {Record<string, unknown>} */ (d.devServer), new Set(local ? ["stopOnSettle"] : ["ready", "stopOnSettle"]));
    if (devBad) return { error: `${file}: unknown key "devServer.${devBad}"` };
  }
  /** @type {{ setup?: string, onSettle?: unknown, quickActions?: ActionRow[] }} */
  const out = {};
  if (d.devServer !== undefined) {
    if (!d.devServer || typeof d.devServer !== "object" || Array.isArray(d.devServer)) return { error: `${file}: devServer must be an object` };
    const value = d.devServer.stopOnSettle;
    if (value !== undefined && typeof value !== "boolean") return { error: `${file}: devServer.stopOnSettle must be boolean` };
    if (typeof value === "boolean") out.devServerStopOnSettle = value;
  }
  if (d.setup !== undefined) {
    const setup = normalizeCommand(d.setup);
    if (!setup) {
      return { error: `${file}: setup must be a non-empty command string (max 500 chars)` };
    }
    out.setup = setup;
  }
  if (d.quickActions !== undefined) {
    if (!Array.isArray(d.quickActions)) {
      return { error: `${file}: quickActions must be an array` };
    }
    if (d.quickActions.length > QUICK_ACTION_MAX) {
      return { error: `${file}: at most ${QUICK_ACTION_MAX} quickActions` };
    }
    const rowKeys = new Set(local ? ["id", "name", "command", "hidden", "stopOnSettle"] : ["id", "name", "command", "stopOnSettle"]);
    /** @type {ActionRow[]} */
    const rows = [];
    for (const [i, row] of d.quickActions.entries()) {
      const at = `${file}: quickActions[${i}]`;
      const r = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
      const rowBad = unknownKey(r, rowKeys);
      if (rowBad) return { error: `${at}: unknown key "${rowBad}"` };
      if (r.id !== undefined && (typeof r.id !== "string" || !ACTION_ID_RE.test(r.id))) {
        return { error: `${at}.id must be a slug matching ${ACTION_ID_RE}` };
      }
      const id = /** @type {string | undefined} */ (r.id);
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (r.hidden !== undefined) {
        if (r.hidden !== true) return { error: `${at}.hidden must be true` };
        if (!id && !name) return { error: `${at} needs an id or name to hide` };
        rows.push({ key: id || name, ...(id ? { id } : {}), name, command: "", hidden: true });
        continue;
      }
      const command = normalizeCommand(r.command);
      if (!name || name.length > ACTION_NAME_MAX) {
        return { error: `${at}.name must be 1 to ${ACTION_NAME_MAX} characters` };
      }
      if (!command) {
        return { error: `${at}.command must be a non-empty command string` };
      }
      if (r.stopOnSettle !== undefined && typeof r.stopOnSettle !== "boolean") return { error: `${at}.stopOnSettle must be boolean` };
      rows.push({ key: id || name, ...(id ? { id } : {}), name, command, ...(typeof r.stopOnSettle === "boolean" ? { stopOnSettle: r.stopOnSettle } : {}) });
    }
    const keys = rows.map((r) => r.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) return { error: `${file}: duplicate quick action "${dup}"` };
    out.quickActions = rows;
  }
  if (d.onSettle !== undefined) out.onSettle = d.onSettle;
  return out;
}

/**
 * Validate parsed solenta.json, layered under an optional parsed
 * solenta.local.json (#438). Local setup/onSettle replace the shared ones;
 * quick actions merge by id (or name when there is no id), and a local
 * `{ "id": "x", "hidden": true }` hides a shared entry. An invalid file
 * contributes no commands at all (never a partial list) and reports the
 * first problem.
 *
 * @param {unknown} data
 * @param {unknown} [localData] omitted = no local file
 * @returns {RepoConfig | null} null when the files declare no commands
 */
function parseRepoConfig(data, localData) {
  const shared = parseLayer(data, REPO_CONFIG_FILE);
  if ("error" in shared) return { error: shared.error };
  const local = localData === undefined ? {} : parseLayer(localData, LOCAL_CONFIG_FILE);
  if ("error" in local) return { error: local.error };

  /** @type {ActionRow[]} */
  const rows = (shared.quickActions || []).slice();
  for (const row of local.quickActions || []) {
    // An id-less local row also matches a shared row by name, and keeps its id.
    const at = rows.findIndex((r) => r.key === row.key || (!row.id && r.name === row.name));
    const prev = at >= 0 ? rows[at] : null;
    const next = row.hidden && prev
      ? { ...prev, hidden: true }
      : { ...row, ...(prev && prev.id && !row.id ? { id: prev.id } : {}), source: LOCAL_CONFIG_FILE };
    if (prev) rows[at] = next;
    // ponytail: hiding an id the shared file no longer has is a no-op, not an error.
    else if (!row.hidden) rows.push(next);
  }
  const visible = rows.filter((r) => !r.hidden);
  if (visible.length > QUICK_ACTION_MAX) {
    return { error: `${LOCAL_CONFIG_FILE}: at most ${QUICK_ACTION_MAX} quickActions after merging with ${REPO_CONFIG_FILE}` };
  }

  /** @type {RepoConfig} */
  const out = {};
  const setup = local.setup || shared.setup;
  if (setup) {
    out.setup = setup;
    if (local.setup) out.setupSource = LOCAL_CONFIG_FILE;
  }
  if (visible.length) {
    out.quickActions = visible.map((r, i) => ({
      id: `${REPO_ACTION_ID_PREFIX}${r.id || i}`,
      name: r.name,
      command: r.command,
      ...(typeof r.stopOnSettle === "boolean" ? { stopOnSettle: r.stopOnSettle } : {}),
      ...(r.source ? { source: r.source } : {}),
    }));
  }
  const settleFile = local.onSettle !== undefined ? LOCAL_CONFIG_FILE : REPO_CONFIG_FILE;
  const rawSettle = local.onSettle !== undefined ? local.onSettle : shared.onSettle;
  if (rawSettle !== undefined) {
    // A hidden action still lends its command to onSettle by name.
    const named = rows.find((a) => !a.hidden && a.name === rawSettle) ||
      (shared.quickActions || []).find((a) => a.name === rawSettle);
    const onSettle = named ? named.command : normalizeCommand(rawSettle);
    if (!onSettle) {
      return { error: `${settleFile}: onSettle must be a quickActions name or a non-empty command string` };
    }
    out.onSettle = onSettle;
  }
  const devStop = local.devServerStopOnSettle ?? shared.devServerStopOnSettle;
  if (typeof devStop === "boolean") out.devServerStopOnSettle = devStop;
  if (!out.setup && !out.quickActions && !out.onSettle && devStop === undefined) return null;
  out.hash = commandsHash(out);
  return out;
}

/**
 * onSettle only joins the canonical form when set, so a file without it
 * keeps the hash it was approved under.
 * Same for env (#396).
 * @param {{ setup?: string, onSettle?: string, env?: Record<string, string>, quickActions?: Array<{ name: string, command: string }> }} cfg
 */
function commandsHash(cfg) {
  const canonical = JSON.stringify({
    setup: cfg.setup || null,
    quickActions: (cfg.quickActions || []).map((a) => [a.name, a.command, ...(typeof a.stopOnSettle === "boolean" ? [a.stopOnSettle] : [])]),
    ...(typeof cfg.devServerStopOnSettle === "boolean" ? { devServerStopOnSettle: cfg.devServerStopOnSettle } : {}),
    ...(cfg.onSettle ? { onSettle: cfg.onSettle } : {}),
    ...(cfg.env ? { env: cfg.env } : {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Read `<root>/<file>` as JSON, cached on mtime+size. Missing file → null.
 * Oversize / invalid JSON → `{ error }`.
 *
 * @param {string | null | undefined} root
 * @param {string} file
 * @returns {{ json?: unknown, error?: string } | null}
 */
function readJsonFile(root, file) {
  if (!root || typeof root !== "string") return null;
  const abs = path.join(root, file);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    cache.delete(abs);
    return null;
  }
  if (!st.isFile()) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(abs);
  if (hit && hit.key === key) return hit;
  /** @type {{ key: string, json?: unknown, error?: string }} */
  let entry;
  if (st.size > MAX_BYTES) {
    entry = { key, error: `${file} is larger than 256 KB` };
  } else {
    try {
      entry = { key, json: JSON.parse(fs.readFileSync(abs, "utf8")) };
    } catch {
      entry = { key, error: `${file} is not valid JSON` };
    }
  }
  cache.set(abs, entry);
  return entry;
}

/**
 * `<root>/solenta.json` via readJsonFile. Shared with automations-file.js
 * and devservers.js so every section sees one cache.
 * @param {string | null | undefined} root
 */
function readRepoJson(root) {
  return readJsonFile(root, REPO_CONFIG_FILE);
}

/**
 * Drop the cached parse for `<root>/solenta.json` (or the file itself),
 * and the local override beside it.
 * @param {string | null | undefined} absFileOrRoot
 */
function invalidateRepoConfigCache(absFileOrRoot) {
  if (!absFileOrRoot || typeof absFileOrRoot !== "string") return;
  const root =
    path.basename(absFileOrRoot) === REPO_CONFIG_FILE
      ? path.dirname(absFileOrRoot)
      : absFileOrRoot;
  cache.delete(path.join(root, REPO_CONFIG_FILE));
  cache.delete(path.join(root, LOCAL_CONFIG_FILE));
}

/**
 * Read `<root>/solenta.json` + `<root>/solenta.local.json`, cached on
 * mtime+size. Neither file → null.
 * @param {string | null | undefined} root
 * @returns {RepoConfig | null}
 */
function readRepoConfig(root) {
  const raw = readRepoJson(root);
  const local = readJsonFile(root, LOCAL_CONFIG_FILE);
  if (!raw && !local) return null;
  if (raw && raw.error) return { error: raw.error };
  if (local && local.error) return { error: local.error };
  return parseRepoConfig(raw ? raw.json : {}, local ? local.json : undefined);
}

/**
 * The file's commands for a project, or null. Remote (SSH) projects have
 * no local checkout to read.
 * @param {any} project
 */
function repoConfigFor(project) {
  if (!project || project.remoteHost) return null;
  return withEnvSpec(readRepoConfig(project.path), readEnvSpec(project.path));
}

/**
 * Fold the env spec into the solenta.json config. A broken spec only
 * reports when there is no solenta.json to fall back on.
 * @param {RepoConfig | null} cfg
 * @param {import("./envSpec.js").EnvSpec | null} spec
 * @returns {RepoConfig | null}
 */
function withEnvSpec(cfg, spec) {
  if (!spec || (cfg && cfg.error)) return cfg;
  if (spec.error) return cfg || { error: spec.error };
  const setup = cfg && cfg.setup ? null : spec.setup;
  if (!setup && !spec.env) return cfg;
  /** @type {RepoConfig} */
  const out = {
    ...cfg,
    ...(setup ? { setup, setupSource: spec.file } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    sources: [...(cfg ? [REPO_CONFIG_FILE] : []), spec.file],
  };
  out.hash = commandsHash(out);
  return out;
}

/**
 * @param {any} project
 * @param {RepoConfig | null} cfg
 */
function isTrusted(project, cfg) {
  return Boolean(cfg && cfg.hash && project && project.repoConfigTrust === cfg.hash);
}

/**
 * Effective setup + quick actions after precedence. `fromRepo` marks rows
 * that came from solenta.json; `trusted` says whether those may run.
 * @param {any} project
 */
function effectiveCommands(project) {
  const cfg = repoConfigFor(project);
  const ok = cfg && !cfg.error ? cfg : null;
  const ownSetup = normalizeCommand(project && project.setupCommand);
  const ownActions =
    project && Array.isArray(project.quickActions) && project.quickActions.length
      ? project.quickActions
      : null;
  return {
    setup: ownSetup
      ? { command: ownSetup, fromRepo: false }
      : ok && ok.setup
        ? { command: ok.setup, fromRepo: true, source: ok.setupSource || REPO_CONFIG_FILE }
        : null,
    quickActions: ownActions
      ? ownActions.map((/** @type {any} */ a) => ({ ...a, fromRepo: false }))
      : ok && ok.quickActions
        ? ok.quickActions.map((a) => ({ ...a, fromRepo: true }))
        : [],
    devServerStopOnSettle: ok && ok.devServerStopOnSettle,
    onSettle: ok && ok.onSettle ? { command: ok.onSettle, fromRepo: true } : null,
    env: ok && ok.env ? ok.env : null,
    hash: ok ? ok.hash || null : null,
    trusted: isTrusted(project, ok),
  };
}

/**
 * ProjectInfo.repoConfig for the renderer. Never persisted.
 * @param {any} project
 */
function presentRepoConfig(project) {
  const cfg = repoConfigFor(project);
  if (!cfg) return null;
  if (cfg.error) return { error: cfg.error, trusted: false };
  return {
    ...(typeof cfg.devServerStopOnSettle === "boolean" ? { devServerStopOnSettle: cfg.devServerStopOnSettle } : {}),
    ...(cfg.setup ? { setupCommand: cfg.setup } : {}),
    ...(cfg.setupSource ? { setupSource: cfg.setupSource } : {}),
    ...(cfg.quickActions ? { quickActions: cfg.quickActions } : {}),
    ...(cfg.onSettle ? { onSettleCommand: cfg.onSettle } : {}),
    ...(cfg.env ? { env: cfg.env } : {}),
    sources: cfg.sources || [REPO_CONFIG_FILE],
    hash: cfg.hash,
    trusted: isTrusted(project, cfg),
  };
}

/**
 * Stored approval hash shape: sha256 hex, else dropped.
 * @param {unknown} raw
 */
function normalizeTrustHash(raw) {
  return typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

module.exports = {
  REPO_CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  SCHEMA_URL,
  REPO_KEYS,
  REPO_ACTION_ID_PREFIX,
  parseRepoConfig,
  readRepoJson,
  readRepoConfig,
  invalidateRepoConfigCache,
  effectiveCommands,
  presentRepoConfig,
  normalizeTrustHash,
};
