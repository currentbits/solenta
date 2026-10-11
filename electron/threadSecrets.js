"use strict";

/**
 * Secrets the user typed into a secret request card (issue #1531, #289).
 *
 * Main-process memory ONLY: never the store, a transcript, a log, an MCP
 * result or an IPC broadcast. A value lives until the app quits or the thread
 * is archived, settled or deleted (retireAgent), and rides the env of the
 * thread's next provider spawns. Spawns that cross a boundary (remote host,
 * sandbox wrapper) get it in the local wrapper's env only.
 */

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** @type {Map<string, Record<string, string>>} */
const byThread = new Map();

/** @param {string} threadId @param {string} name @param {string} value */
function set(threadId, name, value) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
  byThread.set(threadId, { ...byThread.get(threadId), [name]: value });
}

/** @param {string} threadId */
function clear(threadId) {
  byThread.delete(threadId);
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
  const s = byThread.get(threadId);
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
  const s = byThread.get(threadId);
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

module.exports = { NAME_RE, set, clear, withEnv, redact };
