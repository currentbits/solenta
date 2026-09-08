/**
 * prList grouping / matching helpers.
 * Run: node --experimental-strip-types --test test/prList.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allPrsEmpty,
  filterPrGroups,
  formatPrDiff,
  groupPrsByProject,
  matchThreadForPr,
  prMatchesQuery,
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

  it("matches prNumber even when the thread is detached (fork checkout)", () => {
    const threads = [
      thread({ id: "miss", projectId: "p1", branch: "feat/other", prNumber: 2 }),
      thread({ id: "hit", projectId: "p1", branch: null, prNumber: 9 }),
    ];
    const hit = matchThreadForPr(
      pr({ number: 9, headRefName: "feat/9" }),
      threads,
      "p1",
    );
    assert.equal(hit?.id, "hit");
  });

  it("prefers prNumber over a colliding branch name", () => {
    const threads = [
      thread({ id: "branch-only", projectId: "p1", branch: "feat/1" }),
      thread({ id: "numbered", projectId: "p1", branch: "review/pr-1", prNumber: 1 }),
    ];
    const hit = matchThreadForPr(
      pr({ number: 1, headRefName: "feat/1" }),
      threads,
      "p1",
    );
    assert.equal(hit?.id, "numbered");
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

describe("prMatchesQuery", () => {
  it("matches #number, title substring, and branch", () => {
    const row = pr({
      number: 1134,
      title: "Make the PR view searchable",
      headRefName: "coder/pr-search",
    });
    assert.equal(prMatchesQuery(row, "#1134"), true);
    assert.equal(prMatchesQuery(row, "1134"), true);
    assert.equal(prMatchesQuery(row, "searchable"), true);
    assert.equal(prMatchesQuery(row, "PR-SEARCH"), true);
    assert.equal(prMatchesQuery(row, "  coder/pr-search  "), true);
    assert.equal(prMatchesQuery(row, "billing"), false);
  });

  it("treats a blank query as a match", () => {
    assert.equal(prMatchesQuery(pr({ number: 1 }), ""), true);
    assert.equal(prMatchesQuery(pr({ number: 1 }), "   "), true);
  });
});

describe("filterPrGroups", () => {
  const groups = groupPrsByProject(
    [p1, p2],
    new Map([
      [
        "p1",
        {
          ok: true,
          prs: [
            pr({ number: 11, title: "Ledger search", headRefName: "feat/ledger" }),
            pr({ number: 99, title: "Unrelated row", headRefName: "feat/old" }),
          ],
        },
      ],
      [
        "p2",
        {
          ok: true,
          prs: [pr({ number: 22, title: "Billing fix", headRefName: "feat/bill" })],
        },
      ],
    ]),
  );

  it("narrows to one project and the matching rows", () => {
    const filtered = filterPrGroups(groups, { query: "ledger", projectId: "p1" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].project.id, "p1");
    assert.equal(filtered[0].ok, true);
    if (filtered[0].ok) {
      assert.deepEqual(
        filtered[0].prs.map((row) => row.number),
        [11],
      );
    }
  });

  it("keeps a failed repository visible when it is in scope", () => {
    const mixed = groupPrsByProject(
      [p1, p2],
      new Map([
        ["p1", { ok: false, reason: "auth" }],
        ["p2", { ok: true, prs: [pr({ number: 22 })] }],
      ]),
    );
    const filtered = filterPrGroups(mixed, { query: "22" });
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].ok, false);
    assert.equal(filtered[1].ok, true);
    if (filtered[1].ok) assert.equal(filtered[1].prs[0].number, 22);
  });
});

describe("groupPrsByProject completeness", () => {
  it("forwards complete/limit and treats missing complete as true", () => {
    const groups = groupPrsByProject(
      [p1, p2],
      new Map([
        ["p1", { ok: true, prs: [pr({ number: 1 })], complete: false, limit: 50 }],
        ["p2", { ok: true, prs: [pr({ number: 2 })] }],
      ]),
    );
    assert.equal(groups[0].ok, true);
    if (groups[0].ok) {
      assert.equal(groups[0].complete, false);
      assert.equal(groups[0].limit, 50);
    }
    assert.equal(groups[1].ok, true);
    if (groups[1].ok) {
      assert.equal(groups[1].complete, true);
      assert.equal(groups[1].limit, 1);
    }
  });
});
