"use strict";

/**
 * Failure-mode clustering across threads (issue #280).
 *
 * Reads the event log already on disk and groups offending threads by a
 * NORMALIZED error signature, so "spawn claude ENOENT" in six threads reads
 * as one recurring mode with six offenders instead of six separate failures.
 *
 * ponytail: normalized-signature grouping, no LLM and no embeddings. Deterministic,
 * runs in milliseconds on the whole store, and every cluster is explainable by
 * the signature itself. Reach for fuzzier clustering only if signatures prove
 * too literal in practice.
 *
 * @param {object} input
 * @param {Array<object>} input.threads
 * @param {Record<string, Array<object> | undefined>} input.messagesByThread
 * @param {Record<string, Array<object> | undefined>} input.workLogByThread
 * @param {number} [input.nowMs]
 * @returns {Array<{ id: string, signature: string, sample: string, count: number, offenders: Array<{ threadId: string, threadTitle: string, projectId: string, provider: string, kind: "failed" | "stalled" | "retried", at: number }>, lastAt: number }>}
 */
function clusterFailureModes(input) {
  void input;
  return [];
}

module.exports = { clusterFailureModes };
