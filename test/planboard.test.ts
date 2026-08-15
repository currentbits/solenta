/**
 * planColumns: label mapping, ordering, badges.
 * Run: node --experimental-strip-types --test test/planboard.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  badgeLabels,
  isPlanEmpty,
  issueUpdatedMs,
  planColumns,
} from "../src/planboard.ts";
import type { PlanIssue } from "../src/shared/ipc.ts";

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
