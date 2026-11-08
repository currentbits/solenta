"use strict";

const nonnegative = (n) => Math.max(0, Number(n) || 0);

/**
 * Reconcile live app-server snapshots, never external rollout files. The cursor
 * belongs to a provider session, not to its process (which restarts each turn).
 * Input includes cache and output includes reasoning throughout this helper.
 */
function reconcileCodexUsage(info, previousCursor, options) {
  const total = info.totalUsage;
  if (!total) return { delta: info, cursor: previousCursor };
  const { sessionId, resuming } = options;
  let cursor = previousCursor?.sessionId === sessionId ? previousCursor : null;
  if (!cursor) {
    // On first adoption of an existing/imported session only its last request
    // is measured here. Its older transcript is outside the application ledger.
    if (resuming && info.snapshot) return { delta: null,
      cursor: { sessionId, total: { ...total }, inconsistent: true } };
    const prior = !resuming ? { inputTokens: 0, outputTokens: 0 }
      : { inputTokens: Math.max(0, total.inputTokens - info.inputTokens),
          outputTokens: Math.max(0, total.outputTokens - info.outputTokens) };
    for (const key of ["cachedInputTokens", "reasoningTokens"]) {
      if (!resuming) continue;
      if (!info.snapshot && total[key] != null && info[key] != null) prior[key] = Math.max(0, total[key] - info[key]);
    }
    cursor = { sessionId, total: prior };
  }
  const before = cursor.total;
  const decreased = total.inputTokens < before.inputTokens || total.outputTokens < before.outputTokens;
  const zero = total.inputTokens === 0 && total.outputTokens === 0;
  // A zero snapshot is also emitted around compaction. It is not evidence of
  // a new billable request. A new turn id alone cannot establish a counter reset:
  // it may be old history never observed by this application. Only a new provider
  // session establishes a new baseline. Retain uncertainty about backwards totals.
  if (zero || decreased) return { delta: null,
    cursor: decreased && !zero ? { ...cursor, inconsistent: true } : cursor };
  const base = before;
  const delta = {
    ...info,
    inputTokens: Math.max(0, total.inputTokens - (base.inputTokens || 0)),
    outputTokens: Math.max(0, total.outputTokens - (base.outputTokens || 0)),
  };
  for (const [key, max] of [["cachedInputTokens", delta.inputTokens], ["reasoningTokens", delta.outputTokens]]) {
    if (total[key] != null) delta[key] = Math.min(max, Math.max(0, total[key] - (base[key] || 0)));
    else if (info[key] != null) delta[key] = Math.min(max, nonnegative(info[key]));
  }
  const nextTotal = { ...base, ...total };
  return { delta, cursor: { ...cursor, sessionId, total: nextTotal } };
}

module.exports = { reconcileCodexUsage };
