/**
 * planColumns: label mapping, ordering, badges.
 * Run: node --experimental-strip-types --test test/planboard.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  badgeLabels,
  formatLineCount,
  isPlanEmpty,
  issueUpdatedMs,
  planColumns,
  reviewLoad,
} from "../src/planboard.ts";
import type { PlanIssue, PrListItem } from "../src/shared/ipc.ts";

function issue(over: Partial<PlanIssue> & Pick<PlanIssue, "number">): PlanIssue {
  return {
    title: `Issue ${over.number}`,
    url: `https://github.com/acme/demo/issues/${over.number}`,
    state: "OPEN",
    labels: [],
    ...over,
  };
}

describe("planColumns", () => {
  it("maps plan labels and closed state to columns", () => {
    const cols = planColumns([
      issue({ number: 1 }),
      issue({ number: 2, labels: ["plan:todo"] }),
      issue({ number: 3, labels: ["plan:doing"] }),
      issue({ number: 4, labels: ["plan:done"] }),
      issue({ number: 5, state: "CLOSED" }),
    ]);
    assert.deepEqual(
      cols.map((c) => ({ id: c.id, n: c.issues.map((i) => i.number) })),
      [
        { id: "todo", n: [1, 2] },
        { id: "doing", n: [3] },
        { id: "done", n: [4, 5] },
      ],
    );
  });

  it("closed wins over plan:doing", () => {
    const cols = planColumns([
      issue({ number: 1, state: "CLOSED", labels: ["plan:doing"] }),
    ]);
    assert.equal(cols[2].issues.length, 1);
    assert.equal(cols[1].issues.length, 0);
  });

  it("sorts each column newest-updated first, missing dates last", () => {
    const cols = planColumns([
      issue({ number: 1, updatedAt: "2026-01-01T00:00:00Z" }),
      issue({ number: 2, updatedAt: "2026-02-01T00:00:00Z" }),
      issue({ number: 3 }),
    ]);
    assert.deepEqual(
      cols[0].issues.map((i) => i.number),
      [2, 1, 3],
    );
  });

  it("column order and titles are Todo / In progress / Done", () => {
    assert.deepEqual(
      planColumns([]).map((c) => c.title),
      ["Todo", "In progress", "Done"],
    );
  });
});

describe("helpers", () => {
  it("badgeLabels drops plan:* labels only", () => {
    assert.deepEqual(
      badgeLabels(issue({ number: 1, labels: ["plan:doing", "roadmap", "bug"] })),
      ["roadmap", "bug"],
    );
  });

  it("issueUpdatedMs parses ISO and rejects junk", () => {
    assert.equal(
      issueUpdatedMs(issue({ number: 1, updatedAt: "2026-01-01T00:00:00Z" })),
      Date.parse("2026-01-01T00:00:00Z"),
    );
    assert.equal(issueUpdatedMs(issue({ number: 1, updatedAt: "nope" })), null);
    assert.equal(issueUpdatedMs(issue({ number: 1 })), null);
  });

  it("isPlanEmpty", () => {
    assert.equal(isPlanEmpty(planColumns([])), true);
    assert.equal(isPlanEmpty(planColumns([issue({ number: 1 })])), false);
  });
});

function pr(over: Partial<PrListItem> & Pick<PrListItem, "number">): PrListItem {
  return {
    title: `PR ${over.number}`,
    url: `https://github.com/acme/demo/pull/${over.number}`,
    state: "OPEN",
    headRefName: `coder/pr-${over.number}`,
    ...over,
  };
}

describe("reviewLoad (#402)", () => {
  it("counts only open, non-draft PRs and sums their lines", () => {
    const load = reviewLoad([
      pr({ number: 1, additions: 300, deletions: 50 }),
      pr({ number: 2, additions: 200, deletions: 100 }),
      pr({ number: 3, state: "MERGED", additions: 5000, deletions: 5000 }),
      pr({ number: 4, isDraft: true, additions: 5000 }),
      pr({ number: 5, state: "CLOSED" }),
    ]);
    assert.equal(load.openPrs, 2);
    assert.equal(load.totalLines, 650);
    assert.equal(load.level, "ok");
  });

  it("treats missing line counts as zero", () => {
    const load = reviewLoad([pr({ number: 1 }), pr({ number: 2 })]);
    assert.deepEqual(load, { openPrs: 2, totalLines: 0, level: "ok" });
  });

  it("goes busy at four open PRs or past 1200 lines", () => {
    assert.equal(
      reviewLoad([1, 2, 3, 4].map((n) => pr({ number: n }))).level,
      "busy",
    );
    assert.equal(
      reviewLoad([pr({ number: 1, additions: 1000, deletions: 201 })]).level,
      "busy",
    );
    assert.equal(
      reviewLoad([1, 2, 3].map((n) => pr({ number: n }))).level,
      "ok",
    );
  });

  it("goes overloaded at seven open PRs or past 2400 lines", () => {
    assert.equal(
      reviewLoad([1, 2, 3, 4, 5, 6, 7].map((n) => pr({ number: n }))).level,
      "overloaded",
    );
    assert.equal(
      reviewLoad([pr({ number: 1, additions: 2401 })]).level,
      "overloaded",
    );
  });
});

describe("formatLineCount", () => {
  it("keeps small counts literal and compacts thousands", () => {
    assert.equal(formatLineCount(0), "0");
    assert.equal(formatLineCount(950), "950");
    assert.equal(formatLineCount(1600), "1.6k");
    assert.equal(formatLineCount(12000), "12k");
  });
});

describe("planboard backlog window", () => {
  it("never truncates todo or doing, caps done", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      issue({ number: i + 1, labels: i % 2 ? ["plan:doing"] : [] }),
    );
    const closed = Array.from({ length: 200 }, (_, i) =>
      issue({ number: 1000 + i, state: "CLOSED" as const }),
    );
    const cols = planColumns([...many, ...closed]);
    const by = (id: string) => cols.find((c) => c.id === id)!.issues.length;
    assert.equal(by("todo"), 100);
    assert.equal(by("doing"), 100);
    assert.equal(by("done"), 25);
  });
});
