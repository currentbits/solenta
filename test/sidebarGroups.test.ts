/**
 * Sidebar grouping + global settle partition (round 40).
 * Run: node --experimental-strip-types --test test/sidebarGroups.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSidebarGroups,
  groupHeaderSummary,
  partitionSidebar,
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
  const createdAt = partial.createdAt ?? partial.updatedAt;
  const updatedAt = partial.updatedAt;
  return {
    title: partial.title ?? partial.id,
    branch: partial.branch ?? null,
    prNumber: partial.prNumber ?? null,
    prUrl: partial.prUrl ?? null,
    status: partial.status ?? "idle",
    createdAt,
    runStartedAt: partial.runStartedAt ?? null,
    archived: partial.archived ?? false,
    settledOverride: partial.settledOverride ?? null,
    settledAt: partial.settledAt ?? null,
    lastVisitedAt:
      partial.lastVisitedAt !== undefined ? partial.lastVisitedAt : updatedAt,
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
    assert.equal(groups[1]!.project, null);
    assert.equal(groups[1]!.threads[0]!.id, "orphan");
  });
});

describe("partitionSidebar (round 40 global settled)", () => {
  const pA = project({ id: "a", slug: "org/alpha" });
  const pB = project({ id: "b", slug: "org/beta" });

  it("collects settled across two projects into one newest-first list", () => {
    // Settled threads deliberately span projects; interesting case not index 0.
    const threads = [
      thread({
        id: "a-work",
        projectId: "a",
        updatedAt: NOW,
        status: "working",
        runStartedAt: NOW,
      }),
      thread({
        id: "b-merged",
        projectId: "b",
        updatedAt: NOW - 10,
        status: "done",
        prState: "MERGED",
        settledAt: NOW - 5,
      }),
      thread({
        id: "a-merged",
        projectId: "a",
        updatedAt: NOW - 20,
        status: "done",
        prState: "MERGED",
        settledAt: NOW - 1,
      }),
      thread({
        id: "b-fresh",
        projectId: "b",
        updatedAt: NOW,
        status: "done",
      }),
    ];
    const { attentionThreads, settled } = partitionSidebar(threads, settleOpts);
    assert.deepEqual(
      attentionThreads.map((t) => t.id).sort(),
      ["a-work", "b-fresh"].sort(),
      "fresh done and working stay in attention",
    );
    assert.deepEqual(
      settled.map((t) => t.id),
      ["a-merged", "b-merged"],
      "one flat settled list, newest settledAt first, spanning both projects",
    );
  });

  it("excludes archived from the global settled list", () => {
    const { settled } = partitionSidebar(
      [
        thread({
          id: "gone",
          projectId: "a",
          updatedAt: NOW,
          status: "done",
          prState: "MERGED",
          archived: true,
        }),
        thread({
          id: "kept",
          projectId: "a",
          updatedAt: NOW - 1,
          status: "done",
          prState: "MERGED",
        }),
      ],
      settleOpts,
    );
    assert.deepEqual(settled.map((t) => t.id), ["kept"]);
  });
});

describe("splitSettled (round 39 effectiveSettled)", () => {
  it("fresh done stays in attention; MERGED goes to settled", () => {
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
      ],
      settleOpts,
    );
    assert.deepEqual(
      attention.map((t) => t.id),
      ["w", "fresh"],
    );
    assert.deepEqual(settled.map((t) => t.id), ["merged"]);
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

describe("groupHeaderSummary (round 40 working + round 43 unread)", () => {
  it("counts working and omits settled (settled moved to the global tail)", () => {
    assert.equal(
      groupHeaderSummary([
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
      ]),
      "2 working",
      "no settled half on project headers after round 40",
    );
    assert.equal(
      groupHeaderSummary([
        thread({
          id: "fresh",
          projectId: "a",
          updatedAt: NOW,
          status: "done",
        }),
      ]),
      null,
      "no working threads → no summary",
    );
  });

  it("appends unread count when any attention thread is unread", () => {
    assert.equal(
      groupHeaderSummary([
        thread({
          id: "w1",
          projectId: "a",
          updatedAt: 30,
          status: "working",
          lastVisitedAt: 10,
        }),
        thread({
          id: "read",
          projectId: "a",
          updatedAt: 20,
          status: "idle",
          lastVisitedAt: 20,
        }),
        thread({
          id: "newmsg",
          projectId: "a",
          updatedAt: 40,
          status: "done",
          lastVisitedAt: 5,
        }),
      ]),
      "1 working · 2 unread",
    );
    assert.equal(
      groupHeaderSummary([
        thread({
          id: "only-unread",
          projectId: "a",
          updatedAt: 50,
          status: "idle",
          lastVisitedAt: 1,
        }),
      ]),
      "1 unread",
      "unread alone is enough for a summary",
    );
    assert.equal(
      groupHeaderSummary([
        thread({
          id: "legacy",
          projectId: "a",
          updatedAt: 99,
          status: "idle",
          lastVisitedAt: null,
        }),
      ]),
      null,
      "legacy null lastVisitedAt is not unread",
    );
  });

  it("says nothing for empty groups", () => {
    assert.equal(groupHeaderSummary([]), null);
  });
});
