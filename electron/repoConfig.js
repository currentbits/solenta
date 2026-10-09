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
 * Project settings in the app win field by field: a stored setupCommand
 * hides the file's `setup`, a stored quickActions list hides the file's
 * list. Other keys (iconPath, ...) are ignored here.
 *
 * The file is code from whoever can push to the repo, so its commands only
 * run once the user has approved this exact set. The approval is a sha256
 * of the commands stored on the project; editing the file re-prompts.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { normalizeCommand } = require("./verify.js");

const REPO_CONFIG_FILE = "solenta.json";
const QUICK_ACTION_MAX = 8;
const ACTION_NAME_MAX = 32;
const MAX_BYTES = 64 * 1024;
/** Stable ids so a header button keeps its identity across reads. */
const REPO_ACTION_ID_PREFIX = "repo:";

/** @type {Map<string, { key: string, value: RepoConfig | null }>} */
const cache = new Map();

/**
 * @typedef {{
 *   setup?: string,
 *   onSettle?: string,
 *   quickActions?: Array<{ id: string, name: string, command: string }>,
 *   hash?: string,
 *   error?: string,
 * }} RepoConfig
 */

/**
 * Validate parsed solenta.json. An invalid file contributes no commands
 * at all (never a partial list) and reports the first problem.
 *
 * @param {unknown} data
 * @returns {RepoConfig | null} null when the file declares no commands
 */
function parseRepoConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "solenta.json must be a JSON object" };
  }
  const d = /** @type {Record<string, unknown>} */ (data);
  /** @type {RepoConfig} */
  const out = {};
  if (d.setup !== undefined) {
    const setup = normalizeCommand(d.setup);
    if (!setup) {
      return { error: "solenta.json: setup must be a non-empty command string (max 500 chars)" };
    }
    out.setup = setup;
  }
  if (d.quickActions !== undefined) {
    if (!Array.isArray(d.quickActions)) {
      return { error: "solenta.json: quickActions must be an array" };
    }
    if (d.quickActions.length > QUICK_ACTION_MAX) {
      return { error: `solenta.json: at most ${QUICK_ACTION_MAX} quickActions` };
    }
    const actions = [];
    for (const [i, row] of d.quickActions.entries()) {
      const r = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const command = normalizeCommand(r.command);
      if (!name || name.length > ACTION_NAME_MAX) {
        return { error: `solenta.json: quickActions[${i}].name must be 1 to ${ACTION_NAME_MAX} characters` };
      }
      if (!command) {
        return { error: `solenta.json: quickActions[${i}].command must be a non-empty command string` };
      }
      actions.push({ id: `${REPO_ACTION_ID_PREFIX}${i}`, name, command });
    }
    if (actions.length) out.quickActions = actions;
  }
  if (d.onSettle !== undefined) {
    const named = (out.quickActions || []).find((a) => a.name === d.onSettle);
    const onSettle = named ? named.command : normalizeCommand(d.onSettle);
    if (!onSettle) {
      return { error: "solenta.json: onSettle must be a quickActions name or a non-empty command string" };
    }
    out.onSettle = onSettle;
  }
  if (!out.setup && !out.quickActions && !out.onSettle) return null;
  out.hash = commandsHash(out);
  return out;
}

/**
 * onSettle only joins the canonical form when set, so a file without it
 * keeps the hash it was approved under.
 * @param {{ setup?: string, onSettle?: string, quickActions?: Array<{ name: string, command: string }> }} cfg
 */
function commandsHash(cfg) {
  const canonical = JSON.stringify({
    setup: cfg.setup || null,
    quickActions: (cfg.quickActions || []).map((a) => [a.name, a.command]),
    ...(cfg.onSettle ? { onSettle: cfg.onSettle } : {}),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Read `<root>/solenta.json`, cached on mtime+size. Missing file → null.
 * @param {string | null | undefined} root
 * @returns {RepoConfig | null}
 */
function readRepoConfig(root) {
  if (!root || typeof root !== "string") return null;
  const abs = path.join(root, REPO_CONFIG_FILE);
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
  if (hit && hit.key === key) return hit.value;
  /** @type {RepoConfig | null} */
  let value;
  if (st.size > MAX_BYTES) {
    value = { error: "solenta.json is larger than 64 KB" };
  } else {
    try {
      value = parseRepoConfig(JSON.parse(fs.readFileSync(abs, "utf8")));
    } catch {
      value = { error: "solenta.json is not valid JSON" };
    }
  }
  cache.set(abs, { key, value });
  return value;
}

/**
 * The file's commands for a project, or null. Remote (SSH) projects have
 * no local checkout to read.
 * @param {any} project
 */
function repoConfigFor(project) {
  if (!project || project.remoteHost) return null;
  return readRepoConfig(project.path);
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
        ? { command: ok.setup, fromRepo: true }
        : null,
    quickActions: ownActions
      ? ownActions.map((/** @type {any} */ a) => ({ ...a, fromRepo: false }))
      : ok && ok.quickActions
        ? ok.quickActions.map((a) => ({ ...a, fromRepo: true }))
        : [],
    onSettle: ok && ok.onSettle ? { command: ok.onSettle, fromRepo: true } : null,
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
    ...(cfg.setup ? { setupCommand: cfg.setup } : {}),
    ...(cfg.quickActions ? { quickActions: cfg.quickActions } : {}),
    ...(cfg.onSettle ? { onSettleCommand: cfg.onSettle } : {}),
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
  REPO_ACTION_ID_PREFIX,
  parseRepoConfig,
  readRepoConfig,
  effectiveCommands,
  presentRepoConfig,
  normalizeTrustHash,
};
