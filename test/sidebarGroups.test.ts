/**
 * Sidebar grouping + global settle partition (round 40).
 * Run: node --experimental-strip-types --test test/sidebarGroups.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GROUP_ATTENTION_CAP,
  buildSidebarGroups,
  buildSidebarSections,
  groupHeaderSummary,
  partitionSidebar,
  splitSettled,
  visibleAttentionCount,
} from "../src/sidebarGroups.ts";
import { AUTO_SETTLE_AFTER_DAYS } from "../src/threadSettle.ts";
import type { ProjectInfo, SpaceInfo, ThreadInfo } from "../src/shared/ipc.ts";

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
    pinnedAt: partial.pinnedAt ?? null,
    snoozedUntil: partial.snoozedUntil ?? null,
    snoozedAt: partial.snoozedAt ?? null,
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

  it("orders threads newest-first by createdAt inside a group (t3 static order)", () => {
    // updatedAt deliberately disagrees with createdAt: activity must not win.
    const threads = [
      thread({ id: "old", projectId: "a", createdAt: 10, updatedAt: 900 }),
      thread({ id: "new", projectId: "a", createdAt: 99, updatedAt: 100 }),
      thread({ id: "mid", projectId: "a", createdAt: 50, updatedAt: 500 }),
    ];
    const groups = buildSidebarGroups([pA], threads);
    assert.deepEqual(
      groups[0]!.threads.map((t) => t.id),
      ["new", "mid", "old"],
      "creation order, not activity order",
    );
  });

  it("an updatedAt bump never reorders threads within a group or the groups", () => {
    // Regression pin for the t3 rule: streamed activity bumps updatedAt on
    // every message; the sidebar must not move rows for it.
    const before = [
      thread({ id: "t1", projectId: "a", createdAt: 100, updatedAt: 100 }),
      thread({ id: "t2", projectId: "a", createdAt: 200, updatedAt: 200 }),
      thread({ id: "t3", projectId: "b", createdAt: 300, updatedAt: 300 }),
    ];
    const after = [
      { ...before[0]!, updatedAt: 9999 },
      before[1]!,
      before[2]!,
    ];
    const shape = (groups: ReturnType<typeof buildSidebarGroups>) =>
      groups.map((g) => [g.project?.id ?? null, g.threads.map((t) => t.id)]);
    assert.deepEqual(shape(buildSidebarGroups([pA, pB], after)), [
      ["b", ["t3"]],
      ["a", ["t2", "t1"]],
    ]);
    assert.deepEqual(
      shape(buildSidebarGroups([pA, pB], after)),
      shape(buildSidebarGroups([pA, pB], before)),
      "bumping updatedAt must leave every position untouched",
    );
  });

  it("falls back to updatedAt when createdAt is missing/NaN (legacy rows)", () => {
    const threads = [
      thread({ id: "legacy", projectId: "a", createdAt: NaN, updatedAt: 500 }),
      thread({ id: "normal", projectId: "a", createdAt: 100, updatedAt: 100 }),
    ];
    const groups = buildSidebarGroups([pA], threads);
    assert.deepEqual(
      groups[0]!.threads.map((t) => t.id),
      ["legacy", "normal"],
      "legacy row sorts by its updatedAt fallback",
    );
  });

  it("attaches forked threads directly under their source thread", () => {
    const threads = [
      thread({ id: "orch", projectId: "a", updatedAt: 100 }),
      thread({ id: "other", projectId: "a", updatedAt: 150 }),
      thread({ id: "w1", projectId: "a", updatedAt: 200, handoffFrom: "orch" }),
      thread({ id: "w2", projectId: "a", updatedAt: 300, handoffFrom: "orch" }),
      thread({
        id: "stray",
        projectId: "a",
        updatedAt: 400,
        handoffFrom: "gone",
      }),
    ];
    const groups = buildSidebarGroups([pA], threads);
    assert.deepEqual(
      groups[0]!.threads.map((t) => t.id),
      ["stray", "other", "orch", "w2", "w1"],
      "workers follow their orchestrator; a fork with a missing source keeps sort order",
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

describe("buildSidebarSections", () => {
  const pA = project({ id: "a", slug: "org/alpha" });
  const pB = project({ id: "b", slug: "org/beta" });
  const pEmpty = project({ id: "c", slug: "org/empty" });
  const s1: SpaceInfo = { id: "s1", name: "Client work" };
  const s2: SpaceInfo = { id: "s2", name: "Experiments" };

  const shape = (sections: ReturnType<typeof buildSidebarSections>) =>
    sections.map((s) => [
      s.space?.id ?? null,
      s.groups.map((g) => [g.project?.id ?? null, g.threads.map((t) => t.id)]),
    ]);

  it("zero spaces is identical to buildSidebarGroups", () => {
    const threads = [
      thread({ id: "t1", projectId: "a", updatedAt: 100 }),
      thread({ id: "t2", projectId: "b", updatedAt: 300 }),
      thread({ id: "orphan", projectId: "gone", updatedAt: 500 }),
    ];
    const projects = [pA, pB, pEmpty];
    const sections = buildSidebarSections([], projects, threads);
    assert.equal(sections.length, 1, "exactly one Unassigned section");
    assert.equal(sections[0]!.space, null);
    assert.deepEqual(
      sections[0]!.groups,
      buildSidebarGroups(projects, threads),
      "groups equal today's flat list",
    );
  });

  it("projects land under their space; empty spaces still emit a section", () => {
    const client = { ...pA, spaceId: "s1" };
    const experiment = { ...pB, spaceId: "s2" };
    const threads = [
      thread({ id: "t1", projectId: "a", createdAt: 100, updatedAt: 100 }),
      thread({ id: "t2", projectId: "b", createdAt: 300, updatedAt: 300 }),
    ];
    const sections = buildSidebarSections(
      [s1, s2, { id: "s3", name: "Empty" }],
      [client, experiment],
      threads,
    );
    assert.deepEqual(shape(sections), [
      ["s1", [["a", ["t1"]]]],
      ["s2", [["b", ["t2"]]]],
      ["s3", []],
      [null, []],
    ]);
  });

  it("a dangling spaceId falls into Unassigned rather than disappearing", () => {
    const dangling = { ...pA, spaceId: "missing" };
    const assigned = { ...pB, spaceId: "s1" };
    const threads = [
      thread({ id: "t1", projectId: "a", updatedAt: 100 }),
      thread({ id: "t2", projectId: "b", updatedAt: 200 }),
    ];
    const sections = buildSidebarSections(
      [s1],
      [dangling, assigned],
      threads,
    );
    assert.deepEqual(shape(sections), [
      ["s1", [["b", ["t2"]]]],
      [null, [["a", ["t1"]]]],
    ]);
  });

  it("ordering within a section matches buildSidebarGroups", () => {
    const a = { ...pA, spaceId: "s1" };
    const b = { ...pB, spaceId: "s1" };
    const empty = { ...pEmpty, spaceId: "s1" };
    const threads = [
      thread({ id: "t1", projectId: "a", createdAt: 100, updatedAt: 900 }),
      thread({ id: "t2", projectId: "b", createdAt: 300, updatedAt: 300 }),
      thread({ id: "t3", projectId: "a", createdAt: 200, updatedAt: 200 }),
    ];
    const section = buildSidebarSections([s1], [a, b, empty], threads)[0]!;
    assert.deepEqual(
      section.groups,
      buildSidebarGroups([a, b, empty], threads),
      "section order is the existing group order, not a new sort",
    );
  });

  it("orphans stay in Unassigned, not in a named space", () => {
    const assigned = { ...pA, spaceId: "s1" };
    const threads = [
      thread({ id: "t1", projectId: "a", updatedAt: 100 }),
      thread({ id: "orphan", projectId: "gone", updatedAt: 500 }),
    ];
    const sections = buildSidebarSections([s1], [assigned], threads);
    assert.deepEqual(shape(sections), [
      ["s1", [["a", ["t1"]]]],
      [null, [[null, ["orphan"]]]],
    ]);
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

describe("GROUP_ATTENTION_CAP + visibleAttentionCount (issue #70)", () => {
  it("cap is the fixed fact 8 (pinned like the 10/25 tail constants)", () => {
    assert.equal(GROUP_ATTENTION_CAP, 8);
  });

  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      thread({ id: `t${i}`, projectId: "p1", updatedAt: NOW - i }),
    );

  it("uncapped returns the full length", () => {
    assert.equal(
      visibleAttentionCount(many(20), { capped: false }),
      20,
    );
  });

  it("at or under the cap nothing is hidden, even when capped", () => {
    assert.equal(visibleAttentionCount(many(8), { capped: true }), 8);
    assert.equal(visibleAttentionCount(many(3), { capped: true }), 3);
  });

  it("capped hides everything past the cap", () => {
    assert.equal(visibleAttentionCount(many(12), { capped: true }), 8);
  });

  it("keepIds carve-out extends the slice to include the open thread", () => {
    const list = many(12);
    assert.equal(
      visibleAttentionCount(list, { capped: true, keepIds: ["t10"] }),
      11,
    );
    // Inside the cap: no extension.
    assert.equal(
      visibleAttentionCount(list, { capped: true, keepIds: ["t3"] }),
      8,
    );
    // Unknown / null ids are ignored.
    assert.equal(
      visibleAttentionCount(list, { capped: true, keepIds: [null, "nope"] }),
      8,
    );
  });
});
