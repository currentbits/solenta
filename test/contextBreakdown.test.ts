import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextBreakdown } from "../src/contextBreakdown.ts";
import type { ChatMessage, ToolCallInfo } from "../src/shared/ipc";

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    tool: over.tool,
  };
}

function tool(over: Partial<ToolCallInfo> & Pick<ToolCallInfo, "input">): ToolCallInfo {
  return {
    id: over.id ?? "t1",
    name: over.name ?? "Bash",
    input: over.input,
    output: over.output ?? null,
    isError: over.isError ?? false,
    done: over.done ?? true,
  };
}

function sum(segs: { tokens: number }[]): number {
  return segs.reduce((n, s) => n + s.tokens, 0);
}

describe("contextBreakdown", () => {
  it("hides without a measured total", () => {
    const messages = [msg({ role: "user", text: "hello".repeat(100) })];
    assert.deepEqual(contextBreakdown({ messages, measured: 0 }), []);
    assert.deepEqual(contextBreakdown({ messages, measured: -1 }), []);
    assert.deepEqual(contextBreakdown({ messages, measured: Number.NaN }), []);
  });

  it("never goes negative and never exceeds the measured total", () => {
    const messages = [
      msg({ role: "user", text: "u".repeat(400) }),
      msg({
        role: "tool",
        text: "Bash: x",
        tool: tool({ input: "i".repeat(400), output: "o".repeat(8_000) }),
      }),
      msg({ role: "assistant", text: "a".repeat(400) }),
    ];
    const segs = contextBreakdown({ messages, measured: 200 });
    assert.ok(segs.length > 0);
    for (const s of segs) {
      assert.ok(s.tokens > 0);
      assert.ok(s.fraction > 0);
      assert.ok(s.fraction <= 1);
    }
    assert.equal(sum(segs), 200);
    assert.ok(sum(segs) <= 200);
  });

  it("attributes a tool-output-heavy thread mostly to tool output", () => {
    const messages = [
      msg({ role: "user", text: "do it" }),
      msg({
        role: "tool",
        text: "Read: big.ts",
        tool: tool({
          input: '{"path":"big.ts"}',
          output: "x".repeat(4_000),
        }),
      }),
      msg({ role: "assistant", text: "done" }),
    ];
    const segs = contextBreakdown({ messages, measured: 2_000 });
    const tools = segs.find((s) => s.key === "tools");
    assert.ok(tools);
    assert.ok(tools.tokens > 900);
    assert.ok(tools.fraction > 0.5);
    const transcript = segs.find((s) => s.key === "transcript");
    assert.ok(!transcript || transcript.tokens < tools.tokens);
  });

  it("puts the unaccounted remainder in system prompt + tool defs", () => {
    const messages = [msg({ role: "user", text: "abcd" })]; // 1 token
    const segs = contextBreakdown({ messages, measured: 100 });
    assert.equal(sum(segs), 100);
    const system = segs.find((s) => s.key === "system");
    assert.ok(system);
    assert.equal(system.tokens, 99);
    assert.equal(system.label, "System prompt + tool defs");
  });

  it("ignores event messages", () => {
    const withEvent = contextBreakdown({
      messages: [
        msg({ role: "user", text: "abcd" }),
        msg({ role: "event", text: "x".repeat(4_000) }),
      ],
      measured: 50,
    });
    const without = contextBreakdown({
      messages: [msg({ role: "user", text: "abcd" })],
      measured: 50,
    });
    assert.deepEqual(withEvent, without);
  });

  it("with no stored messages the whole total is the remainder", () => {
    const segs = contextBreakdown({ messages: [], measured: 80 });
    assert.equal(segs.length, 1);
    assert.equal(segs[0].key, "system");
    assert.equal(segs[0].tokens, 80);
    assert.equal(segs[0].fraction, 1);
  });
});
