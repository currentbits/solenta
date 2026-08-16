/**
 * kanbanColumns: assignment, exclusion, ordering.
 * Run: node --experimental-strip-types --test test/kanban.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isKanbanEmpty, kanbanColumns } from "../src/kanban.ts";
import { AUTO_SETTLE_AFTER_DAYS } from "../src/threadSettle.ts";
import type { ThreadInfo } from "../src/shared/ipc.ts";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const settleOpts = {
  now: NOW,
  autoSettleAfterDays: AUTO_SETTLE_AFTER_DAYS,
};

function thread(
  over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">,
): ThreadInfo {
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: NOW,
    prState: null,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    worktreePath: null,
    ...over,
  };
}

describe("kanbanColumns", () => {
  it("assigns threads to Working, Idle, Done, Failed in that order", () => {
    const columns = kanbanColumns(
      [
        thread({ id: "idle-1", status: "idle" }),
        thread({ id: "work-1", status: "working" }),
        thread({ id: "fail-1", status: "failed" }),
        thread({ id: "done-1", status: "done" }),
      ],
      settleOpts,
    );
    assert.deepEqual(
      columns.map((c) => c.title),
      ["Working", "Idle", "Done", "Failed"],
    );
    assert.deepEqual(
      columns.map((c) => c.threads.map((t) => t.id)),
      [["work-1"], ["idle-1"], ["done-1"], ["fail-1"]],
    );
  });

  it("keeps a delegating orchestrator out of Done", () => {
    const columns = kanbanColumns(
      [
        thread({ id: "orch", status: "done" }),
        thread({ id: "w1", status: "working", handoffFrom: "orch" }),
      ],
      settleOpts,
    );
    assert.deepEqual(
      columns.map((c) => c.threads.map((t) => t.id)),
      [["orch", "w1"], [], [], []],
    );
  });

  it("excludes archived threads and threads shelved as settled", () => {
    const columns = kanbanColumns(
      [
        thread({ id: "live", status: "idle" }),
        thread({ id: "archived", status: "idle", archived: true }),
        thread({
          id: "settled",
          status: "done",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        thread({
          id: "quiet",
          status: "idle",
          updatedAt: NOW - 10 * DAY_MS,
        }),
      ],
      settleOpts,
    );
    const ids = columns.flatMap((c) => c.threads.map((t) => t.id));
    assert.deepEqual(ids, ["live"]);
  });

  it("sorts each column by updatedAt descending", () => {
    const columns = kanbanColumns(
      [
        thread({ id: "old", status: "idle", updatedAt: NOW - 5000 }),
        thread({ id: "new", status: "idle", updatedAt: NOW }),
        thread({ id: "mid", status: "idle", updatedAt: NOW - 1000 }),
      ],
      settleOpts,
    );
    const idle = columns.find((c) => c.id === "idle");
    assert.deepEqual(
      idle?.threads.map((t) => t.id),
      ["new", "mid", "old"],
    );
  });

  it("keeps a working thread even with a settled override", () => {
    const columns = kanbanColumns(
      [
        thread({
          id: "live",
          status: "working",
          settledOverride: "settled",
        }),
      ],
      settleOpts,
    );
    assert.equal(columns[0].threads[0]?.id, "live");
  });
});

describe("isKanbanEmpty", () => {
  it("is true when every column is empty", () => {
    assert.equal(isKanbanEmpty(kanbanColumns([], settleOpts)), true);
    assert.equal(
      isKanbanEmpty(kanbanColumns([thread({ id: "t", status: "idle" })], settleOpts)),
      false,
    );
  });
});
