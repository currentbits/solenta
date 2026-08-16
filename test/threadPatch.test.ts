/**
 * Streamed thread tails (thread:updated is a ThreadPatch, not a full detail).
 * Run: node --experimental-strip-types --test test/threadPatch.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeThreadPatch, patchThreadList } from "../src/threadPatch.ts";
import type {
  ChatMessage,
  ThreadDetail,
  ThreadInfo,
  ThreadPatch,
} from "../src/shared/ipc.ts";

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

  // The panes are memo'd on these, so a rebuilt-but-equal object is a
  // full re-render of the Agents pane every 700ms (issue #91).
  it("keeps the previous thread and usage identity when they did not move", () => {
    const prev = detail([msg("a")]);
    prev.usage = { model: "m", inputTokens: 1, outputTokens: 2, costUsd: 0, turns: 1 };
    const next = mergeThreadPatch(prev, {
      ...patch([msg("b")], 1),
      thread: { ...prev.thread },
      usage: { ...prev.usage },
    });
    assert.equal(next?.thread, prev.thread, "equal summary must not churn");
    assert.equal(next?.usage, prev.usage, "equal usage must not churn");
  });

  it("takes the new thread and usage when they did move", () => {
    const prev = detail([msg("a")]);
    const moved = { ...prev.thread, status: "done" } as ThreadDetail["thread"];
    const next = mergeThreadPatch(prev, { ...patch([msg("b")], 1), thread: moved });
    assert.equal(next?.thread, moved);
  });
});

describe("patchThreadList", () => {
  const row = (over: Partial<ThreadInfo> = {}): ThreadInfo =>
    ({ id: "t1", status: "working", updatedAt: 5, ...over }) as ThreadInfo;

  it("keeps the array identity when the pushed row is unchanged", () => {
    const list = [row(), row({ id: "t2" })];
    assert.equal(patchThreadList(list, row()), list);
  });

  it("keeps the array identity when the thread is not in the list", () => {
    const list = [row()];
    assert.equal(patchThreadList(list, row({ id: "gone" })), list);
  });

  it("replaces only the moved row", () => {
    const list = [row(), row({ id: "t2" })];
    const next = patchThreadList(list, row({ updatedAt: 6 }));
    assert.notEqual(next, list);
    assert.equal(next[0].updatedAt, 6);
    assert.equal(next[1], list[1], "untouched rows keep their identity");
  });
});
