/**
 * prList grouping / matching helpers.
 * Run: node --experimental-strip-types --test test/prList.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allPrsEmpty,
  formatPrDiff,
  groupPrsByProject,
  matchThreadForPr,
  prUpdatedMs,
} from "../src/prList.ts";
import type {
  ListPrsResult,
  PrListItem,
  ProjectInfo,
  ThreadInfo,
} from "../src/shared/ipc.ts";

const p1: ProjectInfo = {
  id: "p1",
  slug: "acme/ledger",
  name: "ledger",
  path: "/tmp/ledger",
};
const p2: ProjectInfo = {
  id: "p2",
  slug: "acme/billing",
  name: "billing",
  path: "/tmp/billing",
};

const pr = (over: Partial<PrListItem> & Pick<PrListItem, "number">): PrListItem => ({
  title: `PR ${over.number}`,
  url: `https://github.com/acme/ledger/pull/${over.number}`,
  state: "OPEN",
  headRefName: `feat/${over.number}`,
  ...over,
});

function thread(over: Partial<ThreadInfo> & Pick<ThreadInfo, "id">): ThreadInfo {
  return {
    projectId: "p1",
    title: over.id,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    runStartedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: 1,
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

describe("groupPrsByProject", () => {
  it("groups successful rows under each project slug order", () => {
    const results = new Map<string, ListPrsResult>([
      ["p1", { ok: true, prs: [pr({ number: 1 })] }],
      ["p2", { ok: true, prs: [pr({ number: 2 }), pr({ number: 3 })] }],
    ]);
    const groups = groupPrsByProject([p1, p2], results);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].project.slug, "acme/ledger");
    assert.equal(groups[0].ok, true);
    if (groups[0].ok) assert.equal(groups[0].prs.length, 1);
    assert.equal(groups[1].project.slug, "acme/billing");
    assert.equal(groups[1].ok, true);
    if (groups[1].ok) assert.equal(groups[1].prs.length, 2);
  });

  it("keeps a per-project error instead of throwing", () => {
    const results = new Map<string, ListPrsResult>([
      ["p1", { ok: false, reason: "auth" }],
      ["p2", { ok: true, prs: [] }],
    ]);
    const groups = groupPrsByProject([p1, p2], results);
    assert.equal(groups[0].ok, false);
    if (!groups[0].ok) assert.equal(groups[0].reason, "auth");
    assert.equal(groups[1].ok, true);
  });
});

describe("allPrsEmpty", () => {
  it("is true only when every project loaded with zero PRs", () => {
    const empty = groupPrsByProject(
      [p1, p2],
      new Map([
        ["p1", { ok: true, prs: [] }],
        ["p2", { ok: true, prs: [] }],
      ]),
    );
    assert.equal(allPrsEmpty(empty), true);

    const mixed = groupPrsByProject(
      [p1, p2],
      new Map([
        ["p1", { ok: false, reason: "gh missing" }],
        ["p2", { ok: true, prs: [] }],
      ]),
    );
    assert.equal(allPrsEmpty(mixed), false);
  });
});

describe("matchThreadForPr", () => {
  it("matches headRefName to a thread branch in the same project", () => {
    const threads = [
      thread({ id: "other", projectId: "p2", branch: "feat/1" }),
      thread({ id: "hit", projectId: "p1", branch: "feat/1" }),
    ];
    const hit = matchThreadForPr(pr({ number: 1, headRefName: "feat/1" }), threads, "p1");
    assert.equal(hit?.id, "hit");
  });

  it("returns null when the branch belongs to another project or is empty", () => {
    const threads = [thread({ id: "t", projectId: "p1", branch: "feat/1" })];
    assert.equal(
      matchThreadForPr(pr({ number: 1, headRefName: "feat/1" }), threads, "p2"),
      null,
    );
    assert.equal(
      matchThreadForPr(pr({ number: 1, headRefName: "" }), threads, "p1"),
      null,
    );
  });
});

describe("formatPrDiff / prUpdatedMs", () => {
  it("formats +additions -deletions only when both are known", () => {
    assert.equal(formatPrDiff(pr({ number: 1, additions: 4, deletions: 2 })), "+4 -2");
    assert.equal(formatPrDiff(pr({ number: 1, additions: 4 })), null);
    assert.equal(formatPrDiff(pr({ number: 1 })), null);
  });

  it("parses ISO updatedAt and rejects junk", () => {
    const ms = prUpdatedMs(pr({ number: 1, updatedAt: "2026-08-12T18:00:00Z" }));
    assert.equal(ms, Date.parse("2026-08-12T18:00:00Z"));
    assert.equal(prUpdatedMs(pr({ number: 1 })), null);
    assert.equal(prUpdatedMs(pr({ number: 1, updatedAt: "nope" })), null);
  });
});
