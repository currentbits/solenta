"use strict";

/**
 * Secrets the user typed into a secret request card (issue #1531, #289).
 *
 * Never the store, a transcript, a log, an MCP result or an IPC broadcast.
 * A value lives 24 hours from when it was provided (#1744), or until the
 * thread is archived, settled or deleted (retireAgent), and rides the env of
 * the thread's provider spawns. Spawns that cross a boundary (remote host,
 * sandbox wrapper) get it in the local wrapper's env only.
 *
 * Once main.js calls configure({ file }), values also live in their own
 * userData file (thread-secrets.json, mode 0600, written tmp + rename) so a
 * relaunch doesn't make the agent ask again. Values go through secrets.js
 * seal/open: encrypted when SOLENTA_ENABLE_SAFE_STORAGE is on, otherwise
 * PLAINTEXT protected only by the 0600 mode, same as stored provider keys.
 * Without configure (tests), it's memory-only.
 */

const fs = require("node:fs");
const { getDefaultSecrets } = require("./secrets.js");

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const TTL_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, Record<string, { value: string, savedAt: number }>>} */
const byThread = new Map();
/** @type {string | null} */
let file = null;
let now = Date.now;
let sealer = getDefaultSecrets();

function persist() {
  if (!file) return;
  const rows = [];
  for (const [threadId, s] of byThread) {
    for (const [name, e] of Object.entries(s)) {
      rows.push({ threadId, name, value: sealer.seal(e.value), savedAt: e.savedAt });
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (!rows.length) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    // Memory still holds the value; only the restart survival is lost.
    console.warn(`threadSecrets: could not write ${file}: ${err && err.message}`);
  }
}

/** Drop entries older than TTL_MS, rewriting the file when any went. */
function prune() {
  const cutoff = now() - TTL_MS;
  let changed = false;
  for (const [threadId, s] of byThread) {
    const fresh = Object.entries(s).filter(([, e]) => e.savedAt > cutoff);
    if (fresh.length === Object.keys(s).length) continue;
    changed = true;
    if (fresh.length) byThread.set(threadId, Object.fromEntries(fresh));
    else byThread.delete(threadId);
  }
  if (changed) persist();
}

/**
 * Point the module at its file (main.js, before the Store loads, so
 * redaction has the values from the first append) and load it.
 * @param {{ file?: string | null, now?: () => number, secrets?: { seal: (v: string) => string, open: (v: unknown, o?: { key?: string }) => string | null | undefined } }} opts
 */
function configure(opts = {}) {
  file = opts.file || null;
  now = opts.now || Date.now;
  sealer = opts.secrets || getDefaultSecrets();
  byThread.clear();
  if (!file) return;
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Missing or unreadable: start empty.
  }
  if (!Array.isArray(rows)) rows = [];
  let dropped = false;
  for (const r of rows) {
    const value =
      r && typeof r.threadId === "string" && NAME_RE.test(r.name) && typeof r.savedAt === "number"
        ? sealer.open(r.value, { key: `thread-secret:${r.name}` })
        : null;
    if (!value) {
      dropped = true;
      continue;
    }
    byThread.set(r.threadId, { ...byThread.get(r.threadId), [r.name]: { value, savedAt: r.savedAt } });
  }
  if (dropped) persist();
  prune();
}

/** @param {string} threadId @returns {Record<string, string> | null} */
function live(threadId) {
  if (!byThread.size) return null;
  prune();
  const s = byThread.get(threadId);
  return s ? Object.fromEntries(Object.entries(s).map(([k, e]) => [k, e.value])) : null;
}

/** @param {string} threadId @param {string} name @param {string} value */
function set(threadId, name, value) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
  byThread.set(threadId, { ...byThread.get(threadId), [name]: { value, savedAt: now() } });
  persist();
}

/** @param {string} threadId */
function clear(threadId) {
  if (byThread.delete(threadId)) persist();
}

/**
 * Overlay `base` with this thread's secrets. Returns `base` untouched when
 * there are none, so callers keep their "undefined means inherit" semantics.
 * @template {Record<string, string> | NodeJS.ProcessEnv | undefined} T
 * @param {string} threadId
 * @param {T} base
 * @returns {T}
 */
function withEnv(threadId, base) {
  const s = live(threadId);
  return s ? /** @type {T} */ ({ ...(base || {}), ...s }) : base;
}

/** Shorter values would redact ordinary words ("true", "admin"). */
const MIN_REDACT_LEN = 6;

/**
 * Replace this thread's secret values with `[secret:NAME]` in every string of
 * a JSON-shaped value (message, patch, text). Returns `value` itself when the
 * thread has no redactable secrets, so the common path allocates nothing.
 * @template T
 * @param {string} threadId
 * @param {T} value
 * @returns {T}
 */
function redact(threadId, value) {
  const s = live(threadId);
  if (!s) return value;
  // Longest first, so a secret containing another redacts whole.
  const pairs = Object.entries(s)
    .filter(([, v]) => typeof v === "string" && v.length >= MIN_REDACT_LEN)
    .sort((a, b) => b[1].length - a[1].length);
  if (!pairs.length) return value;
  /** @param {unknown} v @returns {unknown} */
  const walk = (v) => {
    if (typeof v === "string") {
      return pairs.reduce((t, [name, secret]) => t.replaceAll(secret, `[secret:${name}]`), v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return /** @type {T} */ (walk(value));
}

module.exports = { NAME_RE, TTL_MS, configure, set, clear, withEnv, redact };
