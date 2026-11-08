"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { extractUsage } = require("../codex.js");
const { notificationToJsonl } = require("../codex-appserver.js");
const { reconcileCodexUsage } = require("../codex-usage.js");

const sample = (turnId, inputTokens, outputTokens = inputTokens / 10) => ({
  inputTokens, outputTokens, totalUsage: { inputTokens, outputTokens }, turnId,
});
const options = { sessionId: "session-a", previous: { inputTokens: 0, outputTokens: 0 } };

describe("Codex live usage reconciliation", () => {
  it("keeps nested rollout request records outside the live/import accounting path", () => {
    assert.equal(extractUsage({ type: "token_usage_record", payload: { usage: { input_tokens: 160 } } }), null);
    assert.equal(notificationToJsonl({ method: "token_usage_record", params: { usage: { input_tokens: 160 } } }), null);
    const { parseCodexRollout } = require("../cli-sessions-codex.js");
    assert.deepEqual(parseCodexRollout(JSON.stringify({ type: "token_usage_record", payload: { usage: { input_tokens: 160 } } })), []);
    assert.equal(extractUsage({ type: "turn.completed", usage: { input_tokens: 160 } }).inputTokens, 160);
  });

  it("preserves inclusive cache/reasoning subsets without increasing context or output", () => {
    const info = extractUsage(notificationToJsonl({ method: "thread/tokenUsage/updated", params: {
      turnId: "request", tokenUsage: {
        last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 4 },
        total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 4 },
      },
    } }));
    assert.equal(info.cachedInputTokens, 80);
    assert.equal(info.reasoningTokens, 4);
    assert.equal(info.inputTokens, 100);
    assert.equal(info.outputTokens, 10);
    assert.equal(info.contextTokens, 110);
    assert.equal(info.turnId, "request");
    const { delta } = reconcileCodexUsage(info, null, options);
    assert.equal(delta.cachedInputTokens, 80);
    assert.equal(delta.reasoningTokens, 4);
  });

  it("does not turn cumulative-only spending into context occupancy", () => {
    const info = extractUsage({ type: "token_count", info: {
      total_token_usage: { input_tokens: 90000, output_tokens: 10000 }, model_context_window: 200000,
    } });
    assert.equal(info.inputTokens, 90000);
    assert.equal(info.contextTokens, undefined);
    assert.equal(info.contextWindow, 200000);
  });

  it("keeps replay and ambiguous same-session resets below the high-water baseline", () => {
    let r = reconcileCodexUsage(sample("turn-1", 100), null, options);
    r = reconcileCodexUsage(sample("turn-2", 300), r.cursor, options);
    assert.equal(r.delta.inputTokens, 200);
    const replay = reconcileCodexUsage(sample("turn-1", 100), r.cursor, options);
    assert.equal(replay.delta, null);
    assert.equal(replay.cursor.inconsistent, true);
    assert.deepEqual(replay.cursor.total, r.cursor.total);
    const zero = reconcileCodexUsage(sample("compact", 0), r.cursor, options);
    assert.equal(zero.delta, null);
    assert.deepEqual(zero.cursor, r.cursor);
    const reset = reconcileCodexUsage(sample("new-turn", 100), r.cursor, options);
    assert.equal(reset.delta, null, "new turn identity alone cannot prove a reset");
    assert.equal(reset.cursor.inconsistent, true);
    const fresh = reconcileCodexUsage(sample("new-turn", 100), r.cursor, { ...options, sessionId: "new-session" });
    assert.equal(fresh.delta.inputTokens, 100, "new provider session establishes a genuine reset");
  });

  it("does not use a parent session's cursor for a fresh fork", () => {
    const parent = reconcileCodexUsage(sample("parent-turn", 500), null, options);
    const fork = reconcileCodexUsage(sample("fork-turn", 100), parent.cursor, {
      ...options, sessionId: "session-fork", previous: { inputTokens: 500, outputTokens: 50 },
    });
    assert.equal(fork.delta.inputTokens, 100);
    assert.equal(fork.cursor.sessionId, "session-fork");
  });

  it("adopts only the current request when an older imported session has no application cursor", () => {
    const info = { ...sample("resumed-turn", 900), inputTokens: 100, outputTokens: 10 };
    const r = reconcileCodexUsage(info, null, { ...options, resuming: true });
    assert.equal(r.delta.inputTokens, 100);
    assert.equal(r.cursor.total.inputTokens, 900);
  });

  it("keeps unidentified backwards or inconsistent snapshots from rewinding the baseline", () => {
    const r = reconcileCodexUsage(sample("known", 300), null, options);
    assert.equal(reconcileCodexUsage(sample(null, 100), r.cursor, options).delta, null);
    assert.equal(reconcileCodexUsage(sample("unknown", 400, 1), r.cursor, options).delta, null);
    assert.equal(reconcileCodexUsage(sample("next", 400), r.cursor, options).delta.inputTokens, 100);
  });

  it("does not mistake a replay older than a bounded identity cache for a new request", () => {
    let cursor;
    for (let i = 1; i <= 300; i++) cursor = reconcileCodexUsage(sample(`turn-${i}`, i * 100), cursor, options).cursor;
    const replay = reconcileCodexUsage(sample("turn-1", 100), cursor, options);
    assert.equal(replay.delta, null);
    assert.equal(replay.cursor.total.inputTokens, 30000);
    assert.equal(reconcileCodexUsage(sample("next", 30100), replay.cursor, options).delta.inputTokens, 100);
  });
});
