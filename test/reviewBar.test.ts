/**
 * Per-run review bar mapping: completed runs 1:1 with checkpoint turns.
 *
 * Run: node --experimental-strip-types --test test/reviewBar.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage, RunStatInfo } from "../src/shared/ipc.ts";
import {
  completedRunIds,
  formatReviewBarText,
  mapReviewBars,
} from "../src/reviewBar.ts";

function msg(
  over: Partial<ChatMessage> & Pick<ChatMessage, "role" | "text">,
): ChatMessage {
  return {
    id: over.id ?? `m-${over.role}-${over.createdAt ?? 1}`,
    role: over.role,
    text: over.text,
    createdAt: over.createdAt ?? 1,
    runId: over.runId ?? null,
  };
}

const stat = (over: Partial<RunStatInfo> & Pick<RunStatInfo, "turn">): RunStatInfo => ({
  sha: over.sha ?? `sha${over.turn}`,
  turn: over.turn,
  files: over.files ?? 2,
  additions: over.additions ?? 4,
  deletions: over.deletions ?? 1,
});

describe("formatReviewBarText", () => {
  it("pluralizes files and joins deltas", () => {
    assert.equal(formatReviewBarText(7, 24, 9), "Edited 7 files · +24 -9");
    assert.equal(formatReviewBarText(1, 1, 0), "Edited 1 file · +1 -0");
  });
});

describe("completedRunIds", () => {
  it("returns unique runIds in first-seen order", () => {
    const ids = completedRunIds(
      [
        msg({ role: "user", text: "a", runId: "r1", createdAt: 1 }),
        msg({ role: "assistant", text: "b", runId: "r1", createdAt: 2 }),
        msg({ role: "user", text: "c", runId: "r2", createdAt: 3 }),
        msg({ role: "assistant", text: "d", runId: "r2", createdAt: 4 }),
      ],
      "idle",
    );
    assert.deepEqual(ids, ["r1", "r2"]);
  });

  it("drops the latest run while the thread is working", () => {
    const ids = completedRunIds(
      [
        msg({ role: "assistant", text: "old", runId: "r1", createdAt: 1 }),
        msg({ role: "assistant", text: "live", runId: "r2", createdAt: 2 }),
      ],
      "working",
    );
    assert.deepEqual(ids, ["r1"]);
  });

  it("ignores messages without a runId", () => {
    const ids = completedRunIds(
      [
        msg({ role: "user", text: "hi", runId: null, createdAt: 1 }),
        msg({ role: "assistant", text: "ok", runId: "r1", createdAt: 2 }),
      ],
      "done",
    );
    assert.deepEqual(ids, ["r1"]);
  });
});

describe("mapReviewBars", () => {
  it("maps run ordinal to checkpoint turn and anchors the last assistant", () => {
    const bars = mapReviewBars({
      messages: [
        msg({ id: "u1", role: "user", text: "one", runId: "r1", createdAt: 1 }),
        msg({
          id: "a1",
          role: "assistant",
          text: "first",
          runId: "r1",
          createdAt: 2,
        }),
        msg({
          id: "a1b",
          role: "assistant",
          text: "first-last",
          runId: "r1",
          createdAt: 3,
        }),
        msg({ id: "u2", role: "user", text: "two", runId: "r2", createdAt: 4 }),
        msg({
          id: "a2",
          role: "assistant",
          text: "second",
          runId: "r2",
          createdAt: 5,
        }),
      ],
      stats: [
        stat({ sha: "sha1", turn: 1, files: 3, additions: 24, deletions: 9 }),
        stat({ sha: "sha2", turn: 2, files: 1, additions: 2, deletions: 0 }),
      ],
      threadStatus: "idle",
    });
    assert.equal(bars.length, 2);
    assert.equal(bars[0]!.runId, "r1");
    assert.equal(bars[0]!.messageId, "a1b");
    assert.equal(bars[0]!.undoSha, null);
    assert.equal(bars[0]!.files, 3);
    assert.equal(bars[1]!.runId, "r2");
    assert.equal(bars[1]!.messageId, "a2");
    assert.equal(bars[1]!.undoSha, "sha1");
    assert.equal(bars[1]!.undoTurn, 1);
    assert.equal(bars[1]!.sha, "sha2");
  });

  it("omits a run with no matching checkpoint", () => {
    const bars = mapReviewBars({
      messages: [
        msg({ role: "assistant", text: "a", runId: "r1", createdAt: 1 }),
        msg({ role: "assistant", text: "b", runId: "r2", createdAt: 2 }),
      ],
      stats: [stat({ sha: "sha1", turn: 1 })],
      threadStatus: "idle",
    });
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.runId, "r1");
  });

  it("omits a completed run that has no assistant message", () => {
    const bars = mapReviewBars({
      messages: [
        msg({ role: "user", text: "only user", runId: "r1", createdAt: 1 }),
        msg({ role: "event", text: "done", runId: "r1", createdAt: 2 }),
      ],
      stats: [stat({ turn: 1 })],
      threadStatus: "idle",
    });
    assert.deepEqual(bars, []);
  });

  it("hides the in-progress run while status is working", () => {
    const bars = mapReviewBars({
      messages: [
        msg({ role: "assistant", text: "done", runId: "r1", createdAt: 1 }),
        msg({ role: "assistant", text: "live", runId: "r2", createdAt: 2 }),
      ],
      stats: [stat({ sha: "sha1", turn: 1 }), stat({ sha: "sha2", turn: 2 })],
      threadStatus: "working",
    });
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.runId, "r1");
  });
});
