"use strict";

/**
 * OpenTelemetry GenAI span export (issue #280).
 *
 * Solenta is the only place a cross-provider trace tree exists — it drives
 * claude/codex/kimi/grok from the outside — so it emits the spans itself
 * instead of relying on any one CLI's own telemetry.
 *
 * Wire format is OTLP/HTTP with a JSON body (`POST <endpoint>/v1/traces`).
 * That is a documented, stable encoding, so there is no @opentelemetry/*
 * dependency here: the whole exporter is a batched fetch of a plain object.
 *
 * ponytail: hand-rolled OTLP/JSON, no SDK. Swap in @opentelemetry/sdk-trace-node
 * only if we need sampling, context propagation into the CLIs, or metrics.
 *
 * Ids are DERIVED, never stored: traceId = hash(root thread id),
 * spanId = hash(run id / tool id). A tool span can therefore name its parent
 * run span with no registry, and a restart mid-thread keeps the same trace.
 *
 * Every method is fire-and-forget and must never throw into the run path.
 * With no endpoint configured nothing is buffered and no request is made.
 */

/**
 * @typedef {object} OtelDeps
 * @property {() => { endpoint: string | null, headers: Record<string, string>, claudeMetrics: boolean }} getSettings
 * @property {(threadId: string) => ({ id: string, title?: string, provider?: string, model?: string | null, handoffFrom?: string | null, orchWorker?: boolean, projectId?: string, permissionMode?: string, worktreePath?: string | null } | null | undefined)} getThread
 * @property {(input: RequestInfo, init?: RequestInit) => Promise<{ ok: boolean, status: number }>} [fetchImpl]
 * @property {() => number} [now]
 * @property {number} [flushMs] - batch window; default 2000
 * @property {number} [batchSize] - flush at this many spans; default 32
 * @property {number} [timeoutMs] - per-request timeout; default 5000
 */

/**
 * @param {OtelDeps} deps
 */
function createOtel(deps) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;

  /**
   * Open a span for one provider turn. Called once per run, at spawn time.
   *
   * @param {object} input
   * @param {string} input.threadId
   * @param {string} input.runId
   * @param {string} [input.provider] - resolved provider id (claude/codex/…)
   * @param {string | null} [input.model]
   * @param {string | null} [input.parentRunId] - the orchestrator run that
   *   forked this worker; null makes this run span a trace root.
   * @param {string} [input.projectName]
   */
  function startRun(input) {
    void input;
    void now;
  }

  /**
   * Close the span opened by startRun and stamp its outcome + usage.
   * Safe to call for a runId that was never started (no-op).
   *
   * @param {object} input
   * @param {string} input.threadId
   * @param {string} input.runId
   * @param {"done" | "failed" | "stopped"} input.status
   * @param {string} [input.error] - error text for a failed run
   * @param {string} [input.provider]
   * @param {string | null} [input.model]
   * @param {number} [input.tokensIn]
   * @param {number} [input.tokensOut]
   * @param {number} [input.costUsd]
   */
  function endRun(input) {
    void input;
  }

  /**
   * Emit a completed child span for one tool call. Called once, when the
   * tool result lands (so start and end are both known).
   *
   * @param {object} input
   * @param {string} input.threadId
   * @param {string} input.runId
   * @param {string} input.toolId
   * @param {string} input.name
   * @param {number} input.startedAt
   * @param {number} input.endedAt
   * @param {boolean} [input.isError]
   */
  function toolCall(input) {
    void input;
  }

  /**
   * Env additions that make Claude Code export its own native OTel metrics to
   * the same collector our spans go to. `{}` when export or claudeMetrics is
   * off, so the caller can always spread the result.
   *
   * @returns {Record<string, string>}
   */
  function claudeEnv() {
    return {};
  }

  /** Send anything buffered now. Never rejects. */
  async function flush() {}

  /** Stop the flush timer (app shutdown). */
  function stop() {}

  return { startRun, endRun, toolCall, claudeEnv, flush, stop };
}

module.exports = { createOtel };
