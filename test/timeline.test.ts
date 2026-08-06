/**
 * Timeline merge tests for ThreadView.
 * Run: node --experimental-strip-types --test test/timeline.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTimeline,
  workLogDurationLabel,
} from "../src/timeline.ts";
import type { ChatMessage, WorkLogItem } from "../src/shared/ipc.ts";

function msg(
  partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "createdAt">,
): ChatMessage {
  return { text: partial.text ?? partial.id, ...partial };
}

function wl(
  partial: Partial<WorkLogItem> &
    Pick<WorkLogItem, "id" | "runId" | "label" | "timestamp">,
): WorkLogItem {
  return { done: partial.done ?? false, ...partial };
}

describe("buildTimeline", () => {
  it("merges messages and one work-log group per runId, sorted by timestamp", () => {
    const messages: ChatMessage[] = [
      msg({ id: "u1", role: "user", text: "do it", createdAt: 1000, runId: "r1" }),
      msg({
        id: "a1",
        role: "assistant",
        text: "ok",
        createdAt: 3000,
        runId: "r1",
      }),
      msg({ id: "u2", role: "user", text: "again", createdAt: 5000, runId: "r2" }),
    ];
    const workLog: WorkLogItem[] = [
      wl({ id: "w1", runId: "r1", label: "Seed", done: true, timestamp: 2000 }),
      wl({
        id: "w2",
        runId: "r1",
        label: "Analyze",
        done: false,
        timestamp: 2500,
      }),
      wl({ id: "w3", runId: "r2", label: "Seed", done: false, timestamp: 6000 }),
    ];

    const timeline = buildTimeline(messages, workLog);

    assert.equal(timeline.length, 5);
    assert.deepEqual(
      timeline.map((e) => e.kind + ":" + ("runId" in e && e.kind === "worklog" ? e.runId : e.kind === "message" ? e.message.id : "")),
      [
        "message:u1",
        "worklog:r1",
        "message:a1",
        "message:u2",
        "worklog:r2",
      ],
    );
  });

  it("places user prompt before the work log of the run it triggered when timestamps equal", () => {
    const messages: ChatMessage[] = [
      msg({ id: "u1", role: "user", text: "build", createdAt: 1000, runId: "r1" }),
    ];
    const workLog: WorkLogItem[] = [
      wl({ id: "w1", runId: "r1", label: "Seed", done: false, timestamp: 1000 }),
    ];

    const timeline = buildTimeline(messages, workLog);
    assert.equal(timeline[0]?.kind, "message");
    assert.equal(timeline[1]?.kind, "worklog");
  });

  it("groups all items for a run into one card using earliest timestamp", () => {
    const workLog: WorkLogItem[] = [
      wl({ id: "w2", runId: "r1", label: "Analyze", done: true, timestamp: 3000 }),
      wl({ id: "w1", runId: "r1", label: "Seed", done: true, timestamp: 1000 }),
    ];

    const timeline = buildTimeline([], workLog);
    assert.equal(timeline.length, 1);
    const g = timeline[0];
    assert.ok(g && g.kind === "worklog");
    assert.equal(g.timestamp, 1000);
    assert.deepEqual(
      g.items.map((i) => i.label),
      ["Seed", "Analyze"],
    );
  });

  it("never emits an empty work log group", () => {
    const messages: ChatMessage[] = [
      msg({ id: "u1", role: "user", text: "hi", createdAt: 1 }),
    ];
    const timeline = buildTimeline(messages, []);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]?.kind, "message");
  });

  it("keeps messages without runId in chronological order", () => {
    const messages: ChatMessage[] = [
      msg({ id: "m1", role: "assistant", text: "a", createdAt: 100 }),
      msg({ id: "m2", role: "event", text: "evt", createdAt: 200 }),
    ];
    const timeline = buildTimeline(messages, []);
    assert.deepEqual(
      timeline.map((e) => (e.kind === "message" ? e.message.id : e.runId)),
      ["m1", "m2"],
    );
  });

  it("preserves messages-array order when two messages share createdAt", () => {
    // Ids deliberately reverse alphabetically so localeCompare would reorder them.
    const messages: ChatMessage[] = [
      msg({
        id: "zzz-prompt",
        role: "user",
        text: "do it",
        createdAt: 1000,
        runId: "r1",
      }),
      msg({
        id: "aaa-event",
        role: "event",
        text: "Kicked off 5 subagents",
        createdAt: 1000,
        runId: "r1",
      }),
    ];
    const timeline = buildTimeline(messages, []);
    assert.deepEqual(
      timeline.map((e) => (e.kind === "message" ? e.message.id : e.runId)),
      ["zzz-prompt", "aaa-event"],
    );
  });

  it("treats role tool messages as ordinary timeline messages (carry runId)", () => {
    const messages: ChatMessage[] = [
      msg({ id: "u1", role: "user", text: "fix it", createdAt: 1000, runId: "r1" }),
      msg({
        id: "t1",
        role: "tool",
        text: "Bash: npm test",
        createdAt: 2000,
        runId: "r1",
        tool: {
          id: "tool-1",
          name: "Bash",
          input: '{"command":"npm test"}',
          output: "ok",
          isError: false,
          done: true,
        },
      }),
      msg({
        id: "a1",
        role: "assistant",
        text: "done",
        createdAt: 3000,
        runId: "r1",
      }),
    ];
    const workLog: WorkLogItem[] = [
      wl({ id: "w1", runId: "r1", label: "Seed", done: true, timestamp: 1500 }),
    ];
    const timeline = buildTimeline(messages, workLog);
    assert.deepEqual(
      timeline.map((e) =>
        e.kind === "message" ? `message:${e.message.id}:${e.message.role}` : `worklog:${e.runId}`,
      ),
      [
        "message:u1:user",
        "worklog:r1",
        "message:t1:tool",
        "message:a1:assistant",
      ],
    );
  });
});

describe("workLogDurationLabel", () => {
  it("formats span between earliest and latest item timestamps", () => {
    const items = [
      wl({ id: "a", runId: "r", label: "Seed", timestamp: 0 }),
      wl({ id: "b", runId: "r", label: "Analyze", timestamp: 105_000 }),
    ];
    assert.equal(workLogDurationLabel(items), "Worked for 1m 45s");
  });

  it("returns null for empty group", () => {
    assert.equal(workLogDurationLabel([]), null);
  });
});
