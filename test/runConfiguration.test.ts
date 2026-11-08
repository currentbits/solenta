import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, RunConfiguration } from "../src/shared/ipc";
import { transcriptConfigurations, runConfigurationLabel } from "../src/runConfiguration";

const first: RunConfiguration = { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" };
const low = { ...first, reasoningEffort: "low" };
const handoff = { provider: "claude", model: "claude-opus-5-5", reasoningEffort: null };
function row(id: string, runId: string | null, configuration?: RunConfiguration, role: ChatMessage["role"] = "event"): ChatMessage {
  return { id, role, runId, createdAt: Number(id.replace(/\D/g, "")) || 1, text: id, ...(configuration ? { runConfiguration: configuration } : {}) };
}

describe("transcript configuration history", () => {
  it("deduplicates identical turns, records effort-only changes and preserves a provider handoff after reload", () => {
    const messages = [row("u1", "r1", undefined, "user"), row("b1", "r1", first), row("a1", "r1", undefined, "assistant"),
      row("b2", "r2", first), row("b3", "r3", low), row("a3", "r3", undefined, "assistant"),
      row("b4", "r4", handoff), row("a4", "r4", undefined, "assistant")];
    const result = transcriptConfigurations(JSON.parse(JSON.stringify(messages)));
    assert.deepEqual([...result.boundaryByMessageId.keys()], ["b1", "b3", "b4"]);
    assert.deepEqual(result.byMessageId.get("u1"), first);
    assert.deepEqual(result.byMessageId.get("a1"), first);
    assert.deepEqual(result.byMessageId.get("a3"), low);
    assert.deepEqual(result.byMessageId.get("a4"), handoff);
  });

  it("leaves legacy and unstarted queued rows unattributed and never carries the current picker backward", () => {
    const result = transcriptConfigurations([row("old", "legacy", undefined, "assistant"), row("queue", null, undefined, "user"), row("b1", "r1", first)]);
    assert.equal(result.byMessageId.has("old"), false);
    assert.equal(result.byMessageId.has("queue"), false);
    assert.equal(result.boundaryByMessageId.size, 1);
  });

  it("in-session model changes affect only later portions of that run", () => {
    const next = { ...first, model: "gpt-6-astra" };
    const result = transcriptConfigurations([row("b1", "r1", first), row("a1", "r1", undefined, "assistant"), row("b2", "r1", next), row("a2", "r1", undefined, "assistant")]);
    assert.deepEqual(result.byMessageId.get("a1"), first);
    assert.deepEqual(result.byMessageId.get("a2"), next);
    assert.equal(result.boundaryByMessageId.size, 2);
  });

  it("attributes a paged tail from the snapshot on assistant output", () => {
    const result = transcriptConfigurations([row("a1", "r1", first, "assistant"), row("a2", "r1", first, "assistant")]);
    assert.deepEqual(result.byMessageId.get("a1"), first);
    assert.deepEqual([...result.boundaryByMessageId.keys()], ["a1"]);
  });

  it("names unknown provider defaults without inventing model or effort values", () => {
    assert.equal(runConfigurationLabel(handoff), "claude · opus 5.5 · default effort");
    assert.equal(runConfigurationLabel({ provider: "codex", model: null, reasoningEffort: null }), "codex · default model · default effort");
  });
});
