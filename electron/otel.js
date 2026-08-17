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

const crypto = require("node:crypto");
const { version: SERVICE_VERSION } = require("../package.json");
const CAP = 500;

function hexId(input, n) {
  const h = crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, n);
  return /^0+$/.test(h) ? `1${"0".repeat(n - 1)}` : h;
}
function kv(k, f, v) { return v == null || v === "" ? null : { key: k, value: { [f]: v } }; }
function i(n) { return typeof n === "number" && Number.isFinite(n) ? String(Math.trunc(n)) : null; }

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
  const flushMs = deps.flushMs != null ? Number(deps.flushMs) : 2000;
  const batchSize = deps.batchSize != null ? Number(deps.batchSize) : 32;
  const timeoutMs = deps.timeoutMs != null ? Number(deps.timeoutMs) : 5000;
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const runs = new Map();
  let buffer = [];
  let timer = null;
  let sending = null;

  function cfg() { try { return deps.getSettings() || {}; } catch { return {}; } }
  function dest() {
    const e = cfg().endpoint;
    if (!e) { buffer = []; clearTimer(); return null; }
    return String(e).replace(/\/+$/, "");
  }
  function thread(id) { try { return (id && deps.getThread(id)) || null; } catch { return null; } }
  function rootId(id) {
    let cur = id;
    const seen = new Set();
    for (let n = 0; n < 32 && cur && !seen.has(cur); n++) {
      seen.add(cur);
      const t = thread(cur);
      if (!t || !t.handoffFrom) return cur;
      cur = t.handoffFrom;
    }
    return cur || id;
  }
  function clearTimer() { if (timer != null) { clearTimeout(timer); timer = null; } }

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
    try {
      if (!dest() || !input || !input.runId) return;
      // ponytail: fixed 500-run cap, persist mid-flight starts if a 500-run fan-out becomes real
      if (runs.size >= CAP) runs.delete(runs.keys().next().value);
      runs.set(input.runId, {
        startedAt: now(), provider: input.provider, model: input.model,
        threadId: input.threadId, parentRunId: input.parentRunId || null,
      });
    } catch { /* never throw into the run path */ }
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
    try {
      if (!input || !input.runId) return;
      const rec = runs.get(input.runId);
      runs.delete(input.runId);
      if (!rec || !dest()) return;
      const threadId = input.threadId || rec.threadId;
      const provider = input.provider || rec.provider || "";
      const model = input.model !== undefined ? input.model : rec.model;
      const t = thread(threadId);
      const span = {
        traceId: hexId(rootId(threadId), 32), spanId: hexId(input.runId, 16),
        name: `invoke_agent ${provider}`.trim(), kind: 3,
        startTimeUnixNano: `${rec.startedAt}000000`, endTimeUnixNano: `${now()}000000`,
        attributes: [
          kv("gen_ai.operation.name", "stringValue", "invoke_agent"),
          kv("gen_ai.provider.name", "stringValue", provider),
          kv("gen_ai.agent.id", "stringValue", provider && model ? `${provider}:${model}` : provider),
          kv("gen_ai.request.model", "stringValue", model),
          kv("gen_ai.usage.input_tokens", "intValue", i(input.tokensIn)),
          kv("gen_ai.usage.output_tokens", "intValue", i(input.tokensOut)),
          kv("session.id", "stringValue", threadId),
          kv("solenta.thread.id", "stringValue", threadId),
          kv("solenta.run.id", "stringValue", input.runId),
          kv("solenta.run.status", "stringValue", input.status),
          kv("solenta.project.id", "stringValue", t && t.projectId),
          kv("solenta.cost.usd", "doubleValue", Number.isFinite(input.costUsd) ? input.costUsd : null),
          kv("solenta.orch.worker", "boolValue", t && t.orchWorker ? true : null),
        ].filter(Boolean),
        status: input.status === "failed"
          ? { code: 2, ...(input.error ? { message: String(input.error).slice(0, 256) } : {}) }
          : { code: 1 },
      };
      if (rec.parentRunId) span.parentSpanId = hexId(rec.parentRunId, 16);
      enqueue(span);
    } catch { /* never throw */ }
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
    try {
      if (!dest() || !input || !input.toolId) return;
      enqueue({
        traceId: hexId(rootId(input.threadId), 32),
        spanId: hexId(`${input.runId}:${input.toolId}`, 16),
        parentSpanId: hexId(input.runId, 16),
        name: `execute_tool ${input.name || ""}`.trim(), kind: 3,
        startTimeUnixNano: `${input.startedAt}000000`, endTimeUnixNano: `${input.endedAt}000000`,
        attributes: [
          kv("gen_ai.operation.name", "stringValue", "execute_tool"),
          kv("gen_ai.tool.name", "stringValue", input.name),
          kv("solenta.tool.id", "stringValue", input.toolId),
          kv("session.id", "stringValue", input.threadId),
          kv("solenta.thread.id", "stringValue", input.threadId),
          kv("solenta.run.id", "stringValue", input.runId),
        ].filter(Boolean),
        status: input.isError ? { code: 2 } : { code: 1 },
      });
    } catch { /* never throw */ }
  }

  function enqueue(span) {
    if (!dest()) return;
    // ponytail: fixed 500-span cap, add disk spill if a dead collector proves lossy
    if (buffer.length >= CAP) buffer.shift();
    buffer.push(span);
    if (buffer.length >= batchSize) { clearTimer(); void pump(); } else arm();
  }
  function arm() {
    if (timer != null || !buffer.length || !dest()) return;
    timer = setTimeout(() => { timer = null; void pump(); }, flushMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
  function pump() {
    if (sending) return sending;
    const url = dest();
    if (!url || !buffer.length) return Promise.resolve();
    const spans = buffer;
    buffer = [];
    clearTimer();
    sending = (async () => {
      try {
        await doFetch(`${url}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(cfg().headers || {}) },
          body: JSON.stringify({ resourceSpans: [{
            resource: { attributes: [
              { key: "service.name", value: { stringValue: "solenta" } },
              { key: "service.version", value: { stringValue: String(SERVICE_VERSION) } },
            ] },
            scopeSpans: [{ scope: { name: "solenta" }, spans }],
          }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { /* drop */ } finally {
        sending = null;
        if (buffer.length >= batchSize) void pump();
        else if (buffer.length) arm();
      }
    })();
    return sending;
  }

  /**
   * Env additions that make Claude Code export its own native OTel metrics to
   * the same collector our spans go to. `{}` when export or claudeMetrics is
   * off, so the caller can always spread the result.
   *
   * @returns {Record<string, string>}
   */
  function claudeEnv() {
    try {
      const s = cfg();
      if (!s.endpoint || !s.claudeMetrics) return {};
      const env = {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: String(s.endpoint).replace(/\/+$/, ""),
      };
      const pairs = Object.entries(s.headers || {}).filter(([k, v]) => k && v);
      if (pairs.length) env.OTEL_EXPORTER_OTLP_HEADERS = pairs.map(([k, v]) => `${k}=${v}`).join(",");
      return env;
    } catch { return {}; }
  }

  /** Send anything buffered now. Never rejects. */
  async function flush() {
    try {
      clearTimer();
      if (sending) { try { await sending; } catch { /* ignore */ } }
      await pump();
    } catch { /* never reject */ }
  }

  /** Stop the flush timer (app shutdown). */
  function stop() { clearTimer(); }

  return { startRun, endRun, toolCall, claudeEnv, flush, stop };
}

module.exports = { createOtel };
