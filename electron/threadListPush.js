"use strict";

/**
 * threads:changed wire encoding (#1475). Every caller broadcasts the whole
 * listThreads() array (2k rows, ~2.7 MB); this turns it into a row patch at
 * the one fan-out point, so callers stay unchanged.
 *
 * listThreads reuses a row object until that thread (or any project)
 * changes, so "row changed" is an identity check, not a deep compare.
 *
 * Payloads (src/shared/ipc.ts ThreadListPush):
 * - { seq, threads }: full list. Sent first, and whenever a row was added or
 *   the order moved (rare: create, fork, import).
 * - { seq, base, upserts, removedIds }: replace rows by id, drop removed ids.
 *   Only valid on top of push `base`; the renderer resyncs on a gap.
 */
function createThreadListEncoder() {
  /** @type {object[] | null} */
  let last = null;
  let seq = 0;

  /** @param {object[]} next */
  return function encode(next) {
    const prev = last;
    last = next;
    seq += 1;
    if (!prev) return { seq, threads: next };
    const patch = diffThreadList(prev, next);
    return patch ? { seq, base: seq - 1, ...patch } : { seq, threads: next };
  };
}

/**
 * Row patch from prev to next, or null when next added a row or reordered
 * the survivors (a full push is simpler than encoding positions).
 * @param {object[]} prev
 * @param {object[]} next
 */
function diffThreadList(prev, next) {
  const nextIds = new Set(next.map((r) => r.id));
  /** @type {string[]} */
  const removedIds = [];
  /** @type {object[]} */
  const upserts = [];
  let j = 0;
  for (const row of prev) {
    if (!nextIds.has(row.id)) {
      removedIds.push(row.id);
      continue;
    }
    const cur = next[j++];
    if (!cur || cur.id !== row.id) return null;
    if (cur !== row) upserts.push(cur);
  }
  if (j !== next.length) return null;
  return { upserts, removedIds };
}

module.exports = { createThreadListEncoder, diffThreadList };
