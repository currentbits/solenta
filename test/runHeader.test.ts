/**
 * Per-run "Worked for" headers: duration formatting, header mapping, and the
 * collapsed-set helper.
 *
 * Run: node --experimental-strip-types --test test/runHeader.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/shared/ipc.ts";
import {
  formatRunDuration,
  isRunCollapsed,
  mapRunHeaders,
  toggleRunCollapsed,
} from "../src/runHeader.ts";

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

describe("formatRunDuration", () => {
  it("renders sub-second spans as under a second", () => {
    assert.equal(formatRunDuration(0), "Worked for <1s");
    assert.equal(formatRunDuration(999), "Worked for <1s");
    assert.equal(formatRunDuration(-500), "Worked for <1s");
  });

  it("renders whole seconds under a minute", () => {
    assert.equal(formatRunDuration(1000), "Worked for 1s");
    assert.equal(formatRunDuration(59_999), "Worked for 59s");
  });

  it("renders minutes, keeping non-zero seconds", () => {
    assert.equal(formatRunDuration(60_000), "Worked for 1m");
    assert.equal(formatRunDuration(125_000), "Worked for 2m 5s");
    assert.equal(formatRunDuration(3_600_000), "Worked for 60m");
  });
});

describe("mapRunHeaders", () => {
  it("anchors each completed run above its first message with a duration", () => {
    const headers = mapRunHeaders(
      [
        msg({ id: "u1", role: "user", text: "one", runId: "r1", createdAt: 1_000 }),
        msg({ id: "a1", role: "assistant", text: "done", runId: "r1", createdAt: 126_000 }),
        msg({ id: "u2", role: "user", text: "two", runId: "r2", createdAt: 200_000 }),
        msg({ id: "a2", role: "assistant", text: "done", runId: "r2", createdAt: 210_000 }),
      ],
      "idle",
    );
    assert.equal(headers.length, 2);
    assert.deepEqual(headers[0], {
      runId: "r1",
      firstMessageId: "u1",
      label: "Worked for 2m 5s",
    });
    assert.deepEqual(headers[1], {
      runId: "r2",
      firstMessageId: "u2",
      label: "Worked for 10s",
    });
  });

  it("drops the in-progress last run while the thread is working", () => {
    const headers = mapRunHeaders(
      [
        msg({ id: "a1", role: "assistant", text: "old", runId: "r1", createdAt: 1 }),
        msg({ id: "a2", role: "assistant", text: "live", runId: "r2", createdAt: 2 }),
      ],
      "working",
    );
    assert.equal(headers.length, 1);
    assert.equal(headers[0]!.runId, "r1");
  });

  it("ignores messages without a runId and single-message runs read <1s", () => {
    const headers = mapRunHeaders(
      [
        msg({ id: "u0", role: "user", text: "hi", runId: null, createdAt: 1 }),
        msg({ id: "a1", role: "assistant", text: "only", runId: "r1", createdAt: 5_000 }),
      ],
      "idle",
    );
    assert.deepEqual(headers, [
      { runId: "r1", firstMessageId: "a1", label: "Worked for <1s" },
    ]);
  });

  it("spans out-of-order createdAt values within a run", () => {
    const headers = mapRunHeaders(
      [
        msg({ id: "late", role: "assistant", text: "b", runId: "r1", createdAt: 30_000 }),
        msg({ id: "early", role: "user", text: "a", runId: "r1", createdAt: 10_000 }),
      ],
      "idle",
    );
    assert.deepEqual(headers, [
      { runId: "r1", firstMessageId: "early", label: "Worked for 20s" },
    ]);
  });

  it("returns nothing when there are no runs", () => {
    assert.deepEqual(
      mapRunHeaders([msg({ role: "user", text: "hi", createdAt: 1 })], "idle"),
      [],
    );
  });
});

describe("run collapse state", () => {
  it("runs are open by default and toggle closed and back open", () => {
    const empty = new Set<string>();
    assert.equal(isRunCollapsed(empty, "r1"), false);
    const closed = toggleRunCollapsed(empty, "r1");
    assert.equal(isRunCollapsed(closed, "r1"), true);
    assert.equal(isRunCollapsed(closed, "r2"), false);
    const reopened = toggleRunCollapsed(closed, "r1");
    assert.equal(isRunCollapsed(reopened, "r1"), false);
  });

  it("does not mutate the input set", () => {
    const original = new Set<string>(["r2"]);
    const next = toggleRunCollapsed(original, "r1");
    assert.deepEqual([...original], ["r2"]);
    assert.deepEqual([...next].sort(), ["r1", "r2"]);
  });
});
