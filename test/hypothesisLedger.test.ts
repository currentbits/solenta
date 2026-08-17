/**
 * Pure helpers for the Agents-tab hypothesis ledger (issue #303).
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hypothesis } from "../src/shared/ipc.ts";
import {
  formatHypothesisAge,
  formatHypothesisSummary,
  groupHypotheses,
  hypothesisStatusLabel,
} from "../src/hypothesisLedger.ts";

const NOW = 1_700_000_000_000;

function h(over: Partial<Hypothesis> & Pick<Hypothesis, "id" | "status">): Hypothesis {
  return {
    claim: over.claim ?? over.id,
    reason: over.reason ?? "",
    at: over.at ?? NOW,
    ...over,
  };
}

describe("groupHypotheses", () => {
  it("orders groups invalidated, validated, inconclusive and drops empties", () => {
    const groups = groupHypotheses([
      h({ id: "v", status: "validated", at: NOW - 2 }),
      h({ id: "i", status: "inconclusive", at: NOW - 1 }),
      h({ id: "x", status: "invalidated", at: NOW }),
    ]);
    assert.deepEqual(
      groups.map((g) => g.status),
      ["invalidated", "validated", "inconclusive"],
    );
    assert.deepEqual(
      groups.map((g) => g.label),
      ["Ruled out", "Worked", "Inconclusive"],
    );
  });

  it("sorts newest-first inside a group, not insertion order", () => {
    const groups = groupHypotheses([
      h({ id: "old", status: "invalidated", at: NOW - 10 }),
      h({ id: "mid", status: "validated", at: NOW - 5 }),
      h({ id: "new", status: "invalidated", at: NOW - 1 }),
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups[0]!.entries.map((e) => e.id),
      ["new", "old"],
    );
    assert.deepEqual(
      groups[1]!.entries.map((e) => e.id),
      ["mid"],
    );
  });

  it("returns nothing for an empty ledger", () => {
    assert.deepEqual(groupHypotheses([]), []);
  });
});

describe("formatHypothesisSummary", () => {
  it("counts each status and omits zero-count parts", () => {
    const list = [
      h({ id: "a", status: "invalidated" }),
      h({ id: "b", status: "invalidated" }),
      h({ id: "c", status: "invalidated" }),
      h({ id: "d", status: "validated" }),
      h({ id: "e", status: "inconclusive" }),
    ];
    assert.equal(formatHypothesisSummary(list), "3 ruled out · 1 worked · 1 inconclusive");
    assert.equal(
      formatHypothesisSummary(list.filter((x) => x.status === "invalidated")),
      "3 ruled out",
    );
    assert.equal(
      formatHypothesisSummary(list.filter((x) => x.status !== "invalidated")),
      "1 worked · 1 inconclusive",
    );
    assert.equal(formatHypothesisSummary([]), "");
  });
});

describe("hypothesisStatusLabel", () => {
  it("names each status for the card", () => {
    assert.equal(hypothesisStatusLabel("invalidated"), "Ruled out");
    assert.equal(hypothesisStatusLabel("validated"), "Worked");
    assert.equal(hypothesisStatusLabel("inconclusive"), "Inconclusive");
  });
});

describe("formatHypothesisAge", () => {
  it("reuses formatRelativeAge and suffixes older spans", () => {
    assert.equal(formatHypothesisAge(NOW, NOW), "now");
    assert.equal(formatHypothesisAge(NOW - 3 * 60_000, NOW), "3m ago");
    assert.equal(formatHypothesisAge(NOW - 2 * 3_600_000, NOW), "2h ago");
  });
});
