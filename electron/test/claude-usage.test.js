"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createClaudeUsage } = require("../claude-usage.js");
const assistant = (id, model, usage, parent_tool_use_id = null) => ({ type: "assistant", parent_tool_use_id, message: { id, model, usage } });
const result = (usage, total_cost_usd, modelUsage) => ({ type: "result", usage, total_cost_usd, modelUsage });

describe("Claude measured usage reconciliation", () => {
  it("retains cache-only measurements and sparse interleaved stream deltas on their parent", () => {
    const tracker = createClaudeUsage();
    tracker.observe({ parent_tool_use_id: null }, { type: "message_start", message: { id: "root", model: "root-model", usage: { cache_read_input_tokens: 12, cache_creation_input_tokens: 3 } } });
    tracker.observe({ parent_tool_use_id: "task" }, { type: "message_start", message: { id: "child", model: "child-model", usage: { input_tokens: 2, output_tokens: 1 } } });
    tracker.observe({ parent_tool_use_id: null }, { type: "message_delta", usage: { output_tokens: 4 } });
    const batch = tracker.finish(null, {}, "never-use-fallback-for-observations");
    assert.equal(batch.cachedInputTokens, 12);
    assert.equal(batch.cacheWriteTokens, 3);
    assert.equal(batch.outputTokens, 5);
    assert.equal(batch.rows.find(row => row.model === "root-model").outputTokens, 4);
    assert.equal(batch.rows.find(row => row.model === "child-model").outputTokens, 1);
    assert.equal(tracker.finish(null, {}, null), null, "terminal flush is idempotent");
  });

  it("a late process summary subtracts measurements already billed on the warm process", () => {
    const handle = {};
    const first = createClaudeUsage();
    first.observe(assistant("one", "m", { input_tokens: 10, output_tokens: 2 }));
    assert.equal(first.finish(result({ input_tokens: 10, output_tokens: 2 }, 0.01), handle, "m").inputTokens, 10);
    const next = createClaudeUsage();
    next.observe(assistant("two", "m", { input_tokens: 4, output_tokens: 1 }));
    const batch = next.finish(result({ input_tokens: 4, output_tokens: 1 }, 0.03, { m: { inputTokens: 14, outputTokens: 3, costUSD: 0.03 } }), handle, "m");
    assert.equal(batch.inputTokens, 4);
    assert.ok(Math.abs(batch.costUsd - 0.02) < 1e-9);
    assert.ok(Math.abs(batch.rows[0].costUsd - 0.02) < 1e-9);
  });

  it("repeated cumulative model summaries do not count cache-only growth twice", () => {
    const handle = {};
    const first = createClaudeUsage().finish(result({}, 0.01, { m: { cacheReadInputTokens: 20, costUSD: 0.01 } }), handle, null);
    assert.equal(first.cachedInputTokens, 20);
    const repeated = createClaudeUsage().finish(result({}, 0.01, { m: { cacheReadInputTokens: 20, costUSD: 0.01 } }), handle, null);
    assert.equal(repeated.cachedInputTokens, 0);
    assert.equal(repeated.costUsd, 0);
  });

  it("keeps authoritative process dollars when model costs disagree", () => {
    const batch = createClaudeUsage().finish(result({ input_tokens: 10 }, 0.03, { a: { inputTokens: 4, costUSD: 1 }, b: { inputTokens: 6, costUSD: 2 } }), {}, "a");
    assert.equal(batch.costUsd, 0.03);
    assert.equal(batch.rows.reduce((sum, row) => sum + (row.costUsd || 0), 0), 0.03);
    assert.equal(batch.rows.find(row => row.costUsd > 0).model, null);
  });

  it("uses reported model dollars when the process total is absent", () => {
    const batch = createClaudeUsage().finish(result({}, undefined, { a: { inputTokens: 4, costUSD: 0.01 }, b: { inputTokens: 6, costUSD: 0.02 } }), {}, null);
    assert.equal(batch.costUsd, 0.03);
    assert.ok(!batch.accounting.unavailableFields.includes("costUsd"));
  });

  it("keeps unmodeled advisor usage unknown and ignores executor iterations", () => {
    const tracker = createClaudeUsage();
    const ev = assistant("m", "root", { input_tokens: 2, iterations: [{ type: "message", input_tokens: 2 }, { type: "advisor_message", input_tokens: 3 }] });
    tracker.observe(ev); tracker.observe(ev);
    const batch = tracker.finish(null, {}, "root");
    assert.equal(batch.inputTokens, 5);
    assert.equal(batch.rows.find(row => row.model === null).inputTokens, 3);
  });
});

it("keeps prior unknown model usage unknown when a later process summary supplies model identities", () => {
  const handle = {};
  const first = createClaudeUsage();
  first.observe(assistant("one", null, { input_tokens: 10, output_tokens: 2 }));
  const initial = first.finish(result({ input_tokens: 10, output_tokens: 2 }, 0.01), handle, null);
  assert.equal(initial.rows[0].model, null);
  const next = createClaudeUsage();
  next.observe(assistant("two", "m", { input_tokens: 4, output_tokens: 1 }));
  const batch = next.finish(result({ input_tokens: 4, output_tokens: 1 }, 0.03, { m: { inputTokens: 14, outputTokens: 3, costUSD: 0.03 } }), handle, "m");
  assert.equal(batch.inputTokens, 4);
  assert.equal(batch.rows.find(row => row.model === "m").inputTokens, 4);
  assert.ok(Math.abs(batch.costUsd - 0.02) < 1e-9);
  const final = createClaudeUsage().finish(result({ input_tokens: 1, output_tokens: 1 }, 0.04, { m: { inputTokens: 15, outputTokens: 4, costUSD: 0.04 } }), handle, "m");
  assert.equal(final.inputTokens, 1);
});

it("does not add unknown message snapshots again beside confirmed process model totals", () => {
  const tracker = createClaudeUsage();
  tracker.observe(assistant("one", null, { input_tokens: 10 }));
  const batch = tracker.finish(result({ input_tokens: 10 }, 0.01, { m: { inputTokens: 10, costUSD: 0.01 } }), {}, null);
  assert.equal(batch.inputTokens, 10);
  assert.equal(batch.accounting.sources[0].model, null, "message identity remains unknown");
  assert.equal(batch.rows.find(row => row.model === "m").inputTokens, 10, "process summary has its own confirmed model identity");
});

it("keeps sparse starts and resolves a model only when a later message actually reports it", () => {
  const tracker = createClaudeUsage();
  tracker.observe({}, { type: "message_start", message: { id: "sparse" } });
  tracker.observe({}, { type: "message_delta", usage: { output_tokens: 5 } });
  tracker.observe(assistant("sparse", "confirmed", { input_tokens: 10 }));
  const batch = tracker.finish(null, {}, "do-not-guess");
  assert.equal(batch.inputTokens, 10);
  assert.equal(batch.outputTokens, 5);
  assert.equal(batch.rows[0].model, "confirmed");
  assert.ok(batch.accounting.unavailableFields.includes("reasoningTokens"));
});
