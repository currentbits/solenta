"use strict";

/**
 * Claimed-lane list + heartbeat (#346 / #1114).
 *
 * Recycle and promote stay off this module. listLanes / heartbeatLane only
 * stamp `thread.lane.lastBeat` so a claimed worktree stays alive while the
 * lead UI is open.
 */

/**
 * @param {unknown} raw
 * @returns {{ n: number, port: number, claimedAt: number, lastBeat: number } | null}
 */
function normalizeLane(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = Number(raw.n);
  if (!Number.isInteger(n) || n < 1) return null;
  const port = Number(raw.port);
  return {
    n,
    port: Number.isInteger(port) && port > 0 ? port : n,
    claimedAt:
      typeof raw.claimedAt === "number" && Number.isFinite(raw.claimedAt)
        ? raw.claimedAt
        : 0,
    lastBeat:
      typeof raw.lastBeat === "number" && Number.isFinite(raw.lastBeat)
        ? raw.lastBeat
        : 0,
  };
}

/**
 * @param {object} store
 * @param {string} projectId
 */
function listLanes(store, projectId) {
  const out = [];
  if (!projectId) return out;
  for (const t of store.getThreads()) {
    if (!t || t.projectId !== projectId) continue;
    const lane = normalizeLane(t.lane);
    if (!lane) continue;
    out.push({
      n: lane.n,
      threadId: t.id,
      port: lane.port,
      path: t.worktreePath || null,
      branch: t.branch || null,
      claimedAt: lane.claimedAt,
      lastBeat: lane.lastBeat,
    });
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

/**
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {number} [opts.now]
 */
function heartbeatLane(opts) {
  const store = opts && opts.store;
  const thread = store.getThread(opts.threadId);
  const lane = thread && normalizeLane(thread.lane);
  if (!lane) return null;
  const next = {
    ...lane,
    lastBeat: opts.now == null ? Date.now() : opts.now,
  };
  store.updateThread(thread.id, { lane: next });
  store.save();
  return next;
}

module.exports = {
  listLanes,
  heartbeatLane,
};
