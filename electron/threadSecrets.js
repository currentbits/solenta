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

module.exports = { NAME_RE, set, clear, withEnv };
