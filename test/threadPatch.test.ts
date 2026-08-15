/**
 * Streamed thread tails (thread:updated is a ThreadPatch, not a full detail).
 * Run: node --experimental-strip-types --test test/threadPatch.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeThreadPatch } from "../src/threadPatch.ts";
import type { ChatMessage, ThreadDetail, ThreadPatch } from "../src/shared/ipc.ts";

function msg(id: string, text = id): ChatMessage {
  return { id, role: "assistant", text, createdAt: 1, runId: "r1" };
}

function detail(messages: ChatMessage[]): ThreadDetail {
  return {
    thread: { id: "t1" } as ThreadDetail["thread"],
    messages,
    workLog: [],
    workflow: null,
    usage: null,
  };
}

function patch(messages: ChatMessage[], messagesFrom: number): ThreadPatch {
  return { ...detail(messages), messagesFrom, workLogFrom: 0 };
}

describe("mergeThreadPatch", () => {
  it("appends a tail onto the untouched prefix", () => {
    const prev = detail([msg("a"), msg("b")]);
    const next = mergeThreadPatch(prev, patch([msg("c")], 2));
    assert.deepEqual(next?.messages.map((m) => m.id), ["a", "b", "c"]);
  });

  it("replaces from the tail index (growing assistant text)", () => {
    const prev = detail([msg("a"), msg("b", "par")]);
    const next = mergeThreadPatch(prev, patch([msg("b", "partial")], 1));
    assert.deepEqual(next?.messages.map((m) => m.text), ["a", "partial"]);
  });

  it("shrinks when the tail is shorter (checkpoint restore)", () => {
    const prev = detail([msg("a"), msg("b"), msg("c")]);
    const next = mergeThreadPatch(prev, patch([], 1));
    assert.deepEqual(next?.messages.map((m) => m.id), ["a"]);
  });

  it("takes a full push as-is (index 0 / absent)", () => {
    const prev = detail([msg("a"), msg("b")]);
    const full: ThreadPatch = detail([msg("z")]);
    assert.deepEqual(
      mergeThreadPatch(prev, full)?.messages.map((m) => m.id),
      ["z"],
    );
  });

  it("returns null on a hole so the caller refetches", () => {
    const prev = detail([msg("a")]);
    assert.equal(mergeThreadPatch(prev, patch([msg("d")], 3)), null);
  });
});
