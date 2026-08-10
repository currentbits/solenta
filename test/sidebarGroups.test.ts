/**
 * Sidebar project grouping / ordering + settle split (round 39).
 * Run: node --experimental-strip-types --test test/sidebarGroups.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSidebarGroups,
  groupHeaderSummary,
  splitSettled,
} from "../src/sidebarGroups.ts";
import { AUTO_SETTLE_AFTER_DAYS } from "../src/threadSettle.ts";
import type { ProjectInfo, ThreadInfo } from "../src/shared/ipc.ts";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const settleOpts = {
  now: NOW,
  autoSettleAfterDays: AUTO_SETTLE_AFTER_DAYS,
};

function project(partial: Partial<ProjectInfo> & Pick<ProjectInfo, "id" | "slug">): ProjectInfo {
  return {
    name: partial.name ?? partial.slug,
    path: partial.path ?? `/demo/${partial.slug}`,
    ...partial,
  };
}

function thread(
  partial: Partial<ThreadInfo> & Pick<ThreadInfo, "id" | "projectId" | "updatedAt">,
): ThreadInfo {
  return {
    title: partial.title ?? partial.id,
    branch: partial.branch ?? null,
    prNumber: partial.prNumber ?? null,
    prUrl: partial.prUrl ?? null,
    status: partial.status ?? "idle",
    createdAt: partial.createdAt ?? partial.updatedAt,
    runStartedAt: partial.runStartedAt ?? null,
    archived: partial.archived ?? false,
    settledOverride: partial.settledOverride ?? null,
    settledAt: partial.settledAt ?? null,
    prState: partial.prState ?? null,
    provider: partial.provider ?? "claude",
    model: partial.model ?? null,
    sessionId: partial.sessionId ?? null,
    permissionMode: partial.permissionMode ?? "default",
    reasoningEffort: partial.reasoningEffort ?? null,
    worktreePath: partial.worktreePath ?? null,
    ...partial,
  };
}

describe("buildSidebarGroups", () => {
  const pA = project({ id: "a", slug: "org/alpha" });
  const pB = project({ id: "b", slug: "org/beta" });
  const pEmpty = project({ id: "c", slug: "org/empty" });

  it("includes every project, empty ones last with zero threads", () => {
    const threads = [
      thread({ id: "t1", projectId: "a", updatedAt: 100 }),
      thread({ id: "t2", projectId: "b", updatedAt: 300 }),
      thread({ id: "t3", projectId: "a", updatedAt: 200 }),
    ];
    const groups = buildSidebarGroups([pA, pB, pEmpty], threads);
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups.map((g) => g.project?.id),
      ["b", "a", "c"],
    );
    assert.deepEqual(
      groups[0]!.threads.map((t) => t.id),
      ["t2"],
    );
    assert.deepEqual(
      groups[1]!.threads.map((t) => t.id),
      ["t3", "t1"],
    );
    assert.deepEqual(groups[2]!.threads, []);
  });

  it("orders threads newest-first by updatedAt inside a group", () => {
    const threads = [
      thread({ id: "old", projectId: "a", updatedAt: 10 }),
      thread({ id: "new", projectId: "a", updatedAt: 99 }),
      thread({ id: "mid", projectId: "a", updatedAt: 50 }),
    ];
    const groups = buildSidebarGroups([pA], threads);
    assert.deepEqual(
      groups[0]!.threads.map((t) => t.id),
      ["new", "mid", "old"],
    );
  });

  it("keeps orphan threads (missing project) in a trailing group", () => {
    const threads = [
      thread({ id: "orphan", projectId: "gone", updatedAt: 500 }),
      thread({ id: "t1", projectId: "a", updatedAt: 100 }),
    ];
    const groups = buildSidebarGroups([pA], threads);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.project?.id, "a");
    assert.equal(groups[1]!.project, null);
    assert.equal(groups[1]!.threads[0]!.id, "orphan");
  });
});

describe("splitSettled (round 39 effectiveSettled)", () => {
  it("fresh done stays in attention; MERGED goes to settled", () => {
    // Interesting MERGED case is deliberately NOT index 0 (fixture discipline).
    const { attention, settled } = splitSettled(
      [
        thread({
          id: "w",
          projectId: "a",
          updatedAt: NOW,
          status: "working",
          runStartedAt: NOW,
        }),
        thread({
          id: "fresh",
          projectId: "a",
          updatedAt: NOW,
          status: "done",
        }),
        thread({
          id: "merged",
          projectId: "a",
          updatedAt: NOW - 1,
          status: "done",
          prState: "MERGED",
        }),
        thread({
          id: "f",
          projectId: "a",
          updatedAt: NOW - 2,
          status: "failed",
        }),
      ],
      settleOpts,
    );
    assert.deepEqual(
      attention.map((t) => t.id),
      ["w", "fresh", "f"],
      "working, fresh-done, and failed need attention; done alone does not settle",
    );
    assert.deepEqual(
      settled.map((t) => t.id),
      ["merged"],
      "MERGED prState is the settled signal, not status===done",
    );
  });

  it("override active keeps a MERGED thread out of the fold", () => {
    const { attention, settled } = splitSettled(
      [
        thread({
          id: "noise",
          projectId: "a",
          updatedAt: NOW,
          status: "idle",
        }),
        thread({
          id: "pinned-out",
          projectId: "a",
          updatedAt: NOW - 1,
          status: "done",
          prState: "MERGED",
          settledOverride: "active",
        }),
      ],
      settleOpts,
    );
    assert.ok(
      attention.some((t) => t.id === "pinned-out"),
      "active override beats MERGED",
    );
    assert.equal(settled.length, 0);
  });

  it("preserves the incoming order within each side", () => {
    const { settled } = splitSettled(
      [
        thread({
          id: "m2",
          projectId: "a",
          updatedAt: 9,
          status: "done",
          prState: "MERGED",
        }),
        thread({ id: "w", projectId: "a", updatedAt: 8, status: "working" }),
        thread({
          id: "m1",
          projectId: "a",
          updatedAt: 7,
          status: "done",
          prState: "CLOSED",
        }),
      ],
      settleOpts,
    );
    assert.deepEqual(
      settled.map((t) => t.id),
      ["m2", "m1"],
      "the group's newest-first sort must survive the split",
    );
  });

  it("inactivity path can settle an idle thread", () => {
    const { settled } = splitSettled(
      [
        thread({
          id: "quiet",
          projectId: "a",
          updatedAt: NOW - (AUTO_SETTLE_AFTER_DAYS + 2) * DAY_MS,
          status: "idle",
        }),
      ],
      settleOpts,
    );
    assert.deepEqual(settled.map((t) => t.id), ["quiet"]);
  });
});

describe("groupHeaderSummary", () => {
  it("counts working and settled via effectiveSettled", () => {
    assert.equal(
      groupHeaderSummary(
        [
          thread({
            id: "w1",
            projectId: "a",
            updatedAt: 3,
            status: "working",
          }),
          thread({
            id: "w2",
            projectId: "a",
            updatedAt: 2,
            status: "working",
          }),
          thread({
            id: "d",
            projectId: "a",
            updatedAt: 1,
            status: "done",
            prState: "MERGED",
          }),
        ],
        settleOpts,
      ),
      "2 working · 1 settled",
    );
    assert.equal(
      groupHeaderSummary(
        [
          thread({
            id: "fresh",
            projectId: "a",
            updatedAt: NOW,
            status: "done",
          }),
        ],
        settleOpts,
      ),
      null,
      "fresh done alone is not settled, so no summary parts",
    );
    assert.equal(
      groupHeaderSummary(
        [
          thread({
            id: "w",
            projectId: "a",
            updatedAt: 1,
            status: "working",
          }),
        ],
        settleOpts,
      ),
      "1 working",
    );
  });

  it("says nothing for empty or all-idle-in-window groups", () => {
    assert.equal(groupHeaderSummary([], settleOpts), null);
    assert.equal(
      groupHeaderSummary(
        [
          thread({
            id: "i",
            projectId: "a",
            updatedAt: NOW,
            status: "idle",
          }),
        ],
        settleOpts,
      ),
      null,
      "an all-idle-recent group has no counts worth a summary line",
    );
  });
});
