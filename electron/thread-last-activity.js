"use strict";

// One-line "last assistant activity" snippet persisted on the thread row
// (#1475 finding 2). threads:summaries used to read every transcript shard
// synchronously to find it: 1,166 shards / 463 MiB / 2 s on the first call.
// Now the row carries `lastActivity: { text, at } | null` (undefined =
// not known yet) and summaries never touch a shard on the main thread.

const fs = require("node:fs");
const { peekLastAssistantValue } = require("./jsonEnvelope.js");

const TAIL_BYTES = 64 * 1024;
const BACKFILL_CONCURRENCY = 8;

/**
 * Same truncation summaries always used: first line, trimmed, 200 chars.
 * `at` is null when the message has no createdAt; readers fall back to the
 * thread's updatedAt so the payload matches the old output exactly.
 * @param {object | null} last
 * @returns {{ text: string, at: number | null } | null}
 */
function snippetOf(last) {
  if (!last) return null;
  return {
    text: String(last.text).split(/\r?\n/, 1)[0].trim().slice(0, 200),
    at: Number(last.createdAt) || null,
  };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameSnippet(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.text === b.text && a.at === b.at;
}

/**
 * True when store.getLastAssistantMessage(id) cannot touch the disk: the
 * memo is warm, the transcript is already loaded, or there is no shard.
 * ponytail: reads Store privates (read-only) because store*.js is off limits
 * for this change; a public `store.hasMessagesInMemory(id)` is the upgrade.
 * @param {import('./store').Store} store
 * @param {string} threadId
 */
function messagesInMemory(store, threadId) {
  return (
    store._lastAssistantByThread.has(threadId) ||
    Object.prototype.hasOwnProperty.call(store._messagesHydrated, threadId) ||
    store._messagesRaw.has(threadId) ||
    !store._messageShards.has(threadId)
  );
}

/**
 * Recompute the snippet from in-memory messages and write it to the row via
 * updateThread (no touch) when it changed. Callers guarantee the messages are
 * in memory, so this never reads a shard.
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {{ text: string, at: number | null } | null}
 */
function stampLastActivity(store, threadId) {
  const next = snippetOf(store.getLastAssistantMessage(threadId));
  const t = store.getThread(threadId);
  if (t && (t.lastActivity === undefined || !sameSnippet(t.lastActivity, next))) {
    store.updateThread(threadId, { lastActivity: next });
    // Cache field: ride the next real flush rather than force a rewrite (#636).
    store.markDirty();
  }
  return next;
}

/**
 * Last assistant message from the tail of a compact JSON message array.
 * Tries each `,{` boundary from the end: `"[" + rest` only parses when the
 * boundary is a top-level element separator (a nested or in-string `,{`
 * leaves unbalanced brackets or quotes). Returns undefined when the tail
 * holds no assistant message, so the caller reads the whole file.
 * @param {string} tail  last bytes of the shard, ending with `]`
 * @returns {object | null | undefined}
 */
function lastAssistantFromTail(tail) {
  for (let p = tail.lastIndexOf(",{"); p >= 0; p = p > 0 ? tail.lastIndexOf(",{", p - 1) : -1) {
    let arr;
    try {
      arr = JSON.parse("[" + tail.slice(p + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (m && m.role === "assistant" && typeof m.text === "string" && m.text.trim() !== "") {
        return m;
      }
    }
  }
  return undefined;
}

/**
 * Async last-assistant lookup for one shard: tail read first, whole file only
 * when the tail has no assistant message. Never blocks the main thread.
 * @param {string} file
 * @returns {Promise<object | null>}
 */
async function readLastAssistant(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size > TAIL_BYTES) {
      const buf = Buffer.alloc(TAIL_BYTES);
      await fh.read(buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      // A cut multi-byte char at the head only damages the first fragment,
      // which never parses as an array suffix anyway.
      const hit = lastAssistantFromTail(buf.toString("utf8"));
      if (hit !== undefined) return hit;
    }
    const raw = (await fh.readFile("utf8")).toString();
    return peekLastAssistantValue(raw, 0, raw.length);
  } finally {
    await fh.close();
  }
}

/** @type {WeakMap<object, Set<string>>} */
const inFlight = new WeakMap();

/**
 * Stamp `lastActivity` on rows that do not have it yet. Async, bounded
 * concurrency, each thread at most once per process. Rows that got a value
 * meanwhile (a run's pushDetail stamp) are left alone.
 * @param {import('./store').Store} store
 * @param {string[]} threadIds
 * @returns {Promise<void>}
 */
function backfillLastActivity(store, threadIds) {
  let pending = inFlight.get(store);
  if (!pending) {
    pending = new Set();
    inFlight.set(store, pending);
  }
  const queue = threadIds.filter((id) => !pending.has(id));
  for (const id of queue) pending.add(id);
  if (queue.length === 0) return Promise.resolve();
  let changed = false;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      let last = null;
      try {
        if (!store._messageShards.has(id)) continue;
        last = await readLastAssistant(store._messagePath(id));
      } catch {
        // Unreadable shard: leave the row unknown; a later call retries.
        pending.delete(id);
        continue;
      }
      const t = store.getThread(id);
      if (!t || t.lastActivity !== undefined) continue;
      // Loaded while we read: memory is the truth, not our stale tail.
      if (
        Object.prototype.hasOwnProperty.call(store._messagesHydrated, id) ||
        store._messagesRaw.has(id)
      ) {
        stampLastActivity(store, id);
        continue;
      }
      store.updateThread(id, { lastActivity: snippetOf(last) });
      changed = true;
    }
  };
  return Promise.all(
    Array.from({ length: Math.min(BACKFILL_CONCURRENCY, queue.length) }, worker),
  ).then(() => {
    if (changed) store.markDirty();
  });
}

module.exports = {
  snippetOf,
  messagesInMemory,
  stampLastActivity,
  lastAssistantFromTail,
  readLastAssistant,
  backfillLastActivity,
};
