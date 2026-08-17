const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createOtel } = require("../otel.js");

function hexId(input, chars) {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, chars);
}

function collect() {
  /** @type {{ url: unknown, init: RequestInit }[]} */
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  }
  return { calls, fetchImpl };
}

function spansOf(calls) {
  /** @type {object[]} */
  const spans = [];
  for (const c of calls) {
    const body = JSON.parse(String(c.init.body));
    for (const rs of body.resourceSpans || []) {
      for (const ss of rs.scopeSpans || []) spans.push(...(ss.spans || []));
    }
  }
  return spans;
}

function attr(span, key) {
  return (span.attributes || []).find((a) => a.key === key);
}

function attrVal(span, key) {
  const a = attr(span, key);
  if (!a) return undefined;
  const v = a.value || {};
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return v.intValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  return undefined;
}

describe("createOtel", () => {
  /** @type {{ stop: () => void }[]} */
  const live = [];
  afterEach(() => {
    for (const o of live) o.stop();
    live.length = 0;
  });

  function otel(overrides) {
    const o = createOtel(overrides);
    live.push(o);
    return o;
  }

  it("is inert when endpoint is null", async () => {
    const { calls, fetchImpl } = collect();
    const o = otel({
      getSettings: () => ({ endpoint: null, headers: {}, claudeMetrics: false }),
      getThread: () => ({ id: "t" }),
      fetchImpl,
      flushMs: 60_000,
      now: () => 1,
    });
    o.startRun({ threadId: "t", runId: "r", provider: "claude", model: "m" });
    o.toolCall({
      threadId: "t",
      runId: "r",
      toolId: "tool-1",
      name: "Bash",
      startedAt: 1,
      endedAt: 2,
    });
    o.endRun({ threadId: "t", runId: "r", status: "done" });
    await o.flush();
    assert.equal(calls.length, 0);
  });

  it("emits a full run span with derived ids, nano strings, and GenAI attrs", async () => {
    const { calls, fetchImpl } = collect();
    let t = 1_700_000_000_000;
    const o = otel({
      getSettings: () => ({
        endpoint: "http://127.0.0.1:4318",
        headers: { Authorization: "Bearer x" },
        claudeMetrics: false,
      }),
      getThread: () => ({ id: "thr-1", projectId: "proj-9" }),
      fetchImpl,
      flushMs: 60_000,
      now: () => t,
    });
    o.startRun({
      threadId: "thr-1",
      runId: "run-1",
      provider: "claude",
      model: "claude-opus-4",
    });
    t += 5_000;
    o.endRun({
      threadId: "thr-1",
      runId: "run-1",
      status: "done",
      provider: "claude",
      model: "claude-opus-4",
      tokensIn: 12,
      tokensOut: 34,
      costUsd: 0.04,
    });
    await o.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:4318/v1/traces");
    assert.equal(calls[0].init.headers["content-type"], "application/json");
    assert.equal(calls[0].init.headers.Authorization, "Bearer x");

    const body = JSON.parse(String(calls[0].init.body));
    const resource = body.resourceSpans[0].resource.attributes;
    assert.equal(resource.find((a) => a.key === "service.name").value.stringValue, "solenta");
    assert.equal(body.resourceSpans[0].scopeSpans[0].scope.name, "solenta");

    const span = spansOf(calls)[0];
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
    assert.equal(span.traceId, hexId("thr-1", 32));
    assert.equal(span.spanId, hexId("run-1", 16));
    assert.equal(span.parentSpanId, undefined);
    assert.equal(span.name, "invoke_agent claude");
    assert.equal(span.kind, 3);
    assert.equal(span.startTimeUnixNano, "1700000000000000000");
    assert.equal(span.endTimeUnixNano, "1700000005000000000");
    assert.equal(typeof span.startTimeUnixNano, "string");
    assert.equal(span.status.code, 1);

    assert.equal(attrVal(span, "gen_ai.operation.name"), "invoke_agent");
    assert.equal(attrVal(span, "gen_ai.provider.name"), "claude");
    assert.equal(attrVal(span, "gen_ai.agent.id"), "claude:claude-opus-4");
    assert.equal(attrVal(span, "gen_ai.request.model"), "claude-opus-4");
    assert.equal(attrVal(span, "session.id"), "thr-1");
    assert.equal(attrVal(span, "solenta.thread.id"), "thr-1");
    assert.equal(attrVal(span, "solenta.run.id"), "run-1");
    assert.equal(attrVal(span, "solenta.run.status"), "done");
    assert.equal(attrVal(span, "solenta.project.id"), "proj-9");
    assert.equal(attr(span, "gen_ai.usage.input_tokens").value.intValue, "12");
    assert.equal(typeof attr(span, "gen_ai.usage.input_tokens").value.intValue, "string");
    assert.equal(attr(span, "gen_ai.usage.output_tokens").value.intValue, "34");
    assert.equal(attr(span, "solenta.cost.usd").value.doubleValue, 0.04);
  });

  it("shares the orchestrator traceId across a handoffFrom fork and parents the worker span", async () => {
    const threads = {
      orch: { id: "orch", handoffFrom: null, projectId: "p1" },
      worker: { id: "worker", handoffFrom: "orch", orchWorker: true, projectId: "p1" },
    };
    const { calls, fetchImpl } = collect();
    const o = otel({
      getSettings: () => ({ endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false }),
      getThread: (id) => threads[id],
      fetchImpl,
      flushMs: 60_000,
      now: () => 1000,
    });
    o.startRun({ threadId: "orch", runId: "run-orch", provider: "claude", model: "opus" });
    o.startRun({
      threadId: "worker",
      runId: "run-worker",
      provider: "grok",
      model: "grok-4",
      parentRunId: "run-orch",
    });
    o.endRun({ threadId: "orch", runId: "run-orch", status: "done" });
    o.endRun({ threadId: "worker", runId: "run-worker", status: "done" });
    await o.flush();

    const spans = spansOf(calls);
    const orch = spans.find((s) => s.spanId === hexId("run-orch", 16));
    const worker = spans.find((s) => s.spanId === hexId("run-worker", 16));
    assert.ok(orch && worker);
    assert.equal(orch.traceId, hexId("orch", 32));
    assert.equal(worker.traceId, orch.traceId);
    assert.equal(worker.parentSpanId, orch.spanId);
    assert.equal(attrVal(worker, "session.id"), "worker");
    assert.equal(attrVal(worker, "solenta.orch.worker"), true);
    assert.equal(attr(orch, "solenta.orch.worker"), undefined);
  });

  it("marks a failed run ERROR and a stopped run OK", async () => {
    const { calls, fetchImpl } = collect();
    const o = otel({
      getSettings: () => ({ endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false }),
      getThread: () => ({ id: "t" }),
      fetchImpl,
      flushMs: 60_000,
      now: () => 1,
    });
    o.startRun({ threadId: "t", runId: "fail", provider: "codex" });
    o.endRun({
      threadId: "t",
      runId: "fail",
      status: "failed",
      error: "boom exploded",
      provider: "codex",
    });
    o.startRun({ threadId: "t", runId: "stop", provider: "codex" });
    o.endRun({ threadId: "t", runId: "stop", status: "stopped", provider: "codex" });
    await o.flush();

    const spans = spansOf(calls);
    const failed = spans.find((s) => s.spanId === hexId("fail", 16));
    const stopped = spans.find((s) => s.spanId === hexId("stop", 16));
    assert.equal(failed.status.code, 2);
    assert.equal(failed.status.message, "boom exploded");
    assert.equal(stopped.status.code, 1);
    assert.equal(attrVal(stopped, "solenta.run.status"), "stopped");
  });

  it("parents a tool span to its run span in the same trace, even without startRun", async () => {
    const { calls, fetchImpl } = collect();
    const o = otel({
      getSettings: () => ({ endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false }),
      getThread: () => ({ id: "t" }),
      fetchImpl,
      flushMs: 60_000,
      now: () => 10,
    });
    o.startRun({ threadId: "t", runId: "run-1", provider: "kimi", model: "k2" });
    o.toolCall({
      threadId: "t",
      runId: "run-1",
      toolId: "tool-9",
      name: "Bash",
      startedAt: 10,
      endedAt: 20,
      isError: true,
    });
    o.endRun({ threadId: "t", runId: "run-1", status: "done", provider: "kimi", model: "k2" });
    o.toolCall({
      threadId: "t",
      runId: "orphan-run",
      toolId: "tool-x",
      name: "Read",
      startedAt: 1,
      endedAt: 2,
    });
    await o.flush();

    const spans = spansOf(calls);
    const run = spans.find((s) => s.spanId === hexId("run-1", 16));
    const tool = spans.find((s) => s.spanId === hexId("run-1:tool-9", 16));
    const orphan = spans.find((s) => s.spanId === hexId("orphan-run:tool-x", 16));
    assert.ok(run && tool && orphan);
    assert.equal(tool.traceId, run.traceId);
    assert.equal(tool.parentSpanId, run.spanId);
    assert.equal(tool.name, "execute_tool Bash");
    assert.equal(tool.status.code, 2);
    assert.equal(attrVal(tool, "gen_ai.operation.name"), "execute_tool");
    assert.equal(attrVal(tool, "gen_ai.tool.name"), "Bash");
    assert.equal(attrVal(tool, "solenta.tool.id"), "tool-9");
    assert.equal(attrVal(tool, "session.id"), "t");
    assert.equal(orphan.parentSpanId, hexId("orphan-run", 16));
    assert.equal(orphan.traceId, hexId("t", 32));
    assert.equal(orphan.status.code, 1);
  });

  it("swallows a rejecting or 500 fetch from endRun and flush", async () => {
    const o500 = otel({
      getSettings: () => ({ endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false }),
      getThread: () => ({ id: "t" }),
      fetchImpl: async () => ({ ok: false, status: 500 }),
      flushMs: 60_000,
      now: () => 1,
    });
    assert.doesNotThrow(() => {
      o500.startRun({ threadId: "t", runId: "r1", provider: "claude" });
      o500.endRun({ threadId: "t", runId: "r1", status: "done" });
    });
    await assert.doesNotReject(() => o500.flush());

    const oRej = otel({
      getSettings: () => ({ endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false }),
      getThread: () => ({ id: "t" }),
      fetchImpl: async () => {
        throw new Error("collector down");
      },
      flushMs: 60_000,
      now: () => 1,
    });
    assert.doesNotThrow(() => {
      oRej.startRun({ threadId: "t", runId: "r2", provider: "claude" });
      oRej.endRun({ threadId: "t", runId: "r2", status: "failed", error: "x" });
    });
    await assert.doesNotReject(() => oRej.flush());
  });

  it("derives the same ids across two createOtel instances", async () => {
    const settings = () => ({ endpoint: "http://127.0.0.1:4318", headers: {}, claudeMetrics: false });
    const getThread = () => ({ id: "t" });
    const a = collect();
    const b = collect();
    const oa = otel({ getSettings: settings, getThread, fetchImpl: a.fetchImpl, flushMs: 60_000, now: () => 1 });
    const ob = otel({ getSettings: settings, getThread, fetchImpl: b.fetchImpl, flushMs: 60_000, now: () => 1 });
    oa.startRun({ threadId: "t", runId: "r1", provider: "claude", model: "m" });
    oa.endRun({ threadId: "t", runId: "r1", status: "done" });
    ob.startRun({ threadId: "t", runId: "r1", provider: "claude", model: "m" });
    ob.endRun({ threadId: "t", runId: "r1", status: "done" });
    await oa.flush();
    await ob.flush();
    const sa = spansOf(a.calls)[0];
    const sb = spansOf(b.calls)[0];
    assert.equal(sa.traceId, sb.traceId);
    assert.equal(sa.spanId, sb.spanId);
    assert.equal(sa.traceId, hexId("t", 32));
    assert.equal(sa.spanId, hexId("r1", 16));
  });

  it("returns Claude OTel env only when endpoint and claudeMetrics are both on", () => {
    const off = otel({
      getSettings: () => ({ endpoint: null, headers: {}, claudeMetrics: true }),
      getThread: () => null,
    });
    assert.deepEqual(off.claudeEnv(), {});

    const noMetrics = otel({
      getSettings: () => ({ endpoint: "http://127.0.0.1:4318", headers: { a: "b" }, claudeMetrics: false }),
      getThread: () => null,
    });
    assert.deepEqual(noMetrics.claudeEnv(), {});

    const on = otel({
      getSettings: () => ({
        endpoint: "http://127.0.0.1:4318/",
        headers: { Authorization: "Bearer x", "x-foo": "bar" },
        claudeMetrics: true,
      }),
      getThread: () => null,
    });
    assert.deepEqual(on.claudeEnv(), {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x,x-foo=bar",
    });
  });
});
