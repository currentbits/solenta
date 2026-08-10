/**
 * Sidebar project grouping / ordering.
 * Run: node --experimental-strip-types --test test/sidebarGroups.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSidebarGroups,
  groupHeaderSummary,
  splitSettled,
} from "../src/sidebarGroups.ts";
import type { ProjectInfo, ThreadInfo } from "../src/shared/ipc.ts";

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

describe("splitSettled", () => {
  it("settles exactly done; working, failed, and idle keep attention", () => {
    const { attention, settled } = splitSettled([
      thread({ id: "w", projectId: "a", updatedAt: 4, status: "working" }),
      thread({ id: "d", projectId: "a", updatedAt: 3, status: "done" }),
      thread({ id: "f", projectId: "a", updatedAt: 2, status: "failed" }),
      thread({ id: "i", projectId: "a", updatedAt: 1, status: "idle" }),
    ]);
    assert.deepEqual(
      attention.map((t) => t.id),
      ["w", "f", "i"],
      "failed needs the user and idle has not run; neither may be buried",
    );
    assert.deepEqual(
      settled.map((t) => t.id),
      ["d"],
    );
  });

  it("preserves the incoming order within each side", () => {
    const { settled } = splitSettled([
      thread({ id: "d2", projectId: "a", updatedAt: 9, status: "done" }),
      thread({ id: "w", projectId: "a", updatedAt: 8, status: "working" }),
      thread({ id: "d1", projectId: "a", updatedAt: 7, status: "done" }),
    ]);
    assert.deepEqual(
      settled.map((t) => t.id),
      ["d2", "d1"],
      "the group's newest-first sort must survive the split",
    );
  });
});

describe("groupHeaderSummary", () => {
  it("counts working and settled, omitting zero parts", () => {
    assert.equal(
      groupHeaderSummary([
        thread({ id: "w1", projectId: "a", updatedAt: 3, status: "working" }),
        thread({ id: "w2", projectId: "a", updatedAt: 2, status: "working" }),
        thread({ id: "d", projectId: "a", updatedAt: 1, status: "done" }),
      ]),
      "2 working · 1 settled",
    );
    assert.equal(
      groupHeaderSummary([
        thread({ id: "d", projectId: "a", updatedAt: 1, status: "done" }),
      ]),
      "1 settled",
    );
    assert.equal(
      groupHeaderSummary([
        thread({ id: "w", projectId: "a", updatedAt: 1, status: "working" }),
      ]),
      "1 working",
    );
  });

  it("says nothing for empty or all-idle groups", () => {
    assert.equal(groupHeaderSummary([]), null);
    assert.equal(
      groupHeaderSummary([
        thread({ id: "i", projectId: "a", updatedAt: 1, status: "idle" }),
      ]),
      null,
      "an all-idle group has no counts worth a summary line",
    );
  });
});
