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

/**
 * Values shorter than this are not redacted: "abc" or "true" would mangle
 * unrelated transcript text. ponytail: a fixed floor, not entropy scoring.
 */
const MIN_REDACT_LEN = 6;

/**
 * Objects (messages, work-log items) already scanned against the thread's
 * current secrets, so streaming does not rescan the whole transcript on
 * every update. Store updates replace objects, so a change is a new object.
 * @type {Map<string, WeakSet<object>>}
 */
const scrubbed = new Map();

/** @param {string} threadId @param {string} name @param {string} value */
function set(threadId, name, value) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
  byThread.set(threadId, { ...byThread.get(threadId), [name]: value });
  // A new value: everything must be checked again.
  scrubbed.delete(threadId);
}

/** @param {string} threadId */
function clear(threadId) {
  byThread.delete(threadId);
  scrubbed.delete(threadId);
}

/**
 * `value` with every secret of this thread replaced by `[secret:NAME]`
 * (#1531 follow-up): an agent that prints $NAME must not put the value in
 * the transcript, the store or a detail push. Walks strings in plain
 * objects and arrays; unchanged parts keep their identity, and with no
 * secrets the input comes back as is.
 * @template T
 * @param {string} threadId
 * @param {T} value
 * @returns {T}
 */
function redact(threadId, value) {
  const s = byThread.get(threadId);
  if (!s) return value;
  // Longest first, so a value containing another is replaced whole.
  const pairs = Object.entries(s)
    .filter(([, v]) => typeof v === "string" && v.length >= MIN_REDACT_LEN)
    .sort((a, b) => b[1].length - a[1].length);
  if (pairs.length === 0) return value;
  let seen = scrubbed.get(threadId);
  if (!seen) scrubbed.set(threadId, (seen = new WeakSet()));
  const done = seen;
  /** @param {unknown} v @returns {unknown} */
  const walk = (v) => {
    if (typeof v === "string") {
      let out = v;
      for (const [name, secret] of pairs) {
        if (out.includes(secret)) out = out.split(secret).join(`[secret:${name}]`);
      }
      return out;
    }
    if (!v || typeof v !== "object" || done.has(v)) return v;
    let changed = false;
    /** @type {any} */
    let out;
    if (Array.isArray(v)) {
      out = v.map((item) => {
        const next = walk(item);
        if (next !== item) changed = true;
        return next;
      });
    } else {
      out = {};
      for (const [k, item] of Object.entries(v)) {
        const next = walk(item);
        if (next !== item) changed = true;
        out[k] = next;
      }
    }
    const result = changed ? out : v;
    done.add(result);
    return result;
  };
  return /** @type {T} */ (walk(value));
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

module.exports = { NAME_RE, MIN_REDACT_LEN, set, clear, withEnv, redact };
