/**
 * summarizeFleet: merge rate, review tax, durability, range, garbage.
 * Run: node --experimental-strip-types --test test/fleet.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeFleet } from "../src/fleet.ts";
import type { FleetEvidence, FleetPr, FleetThread } from "../src/shared/ipc.ts";

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function thread(over: Partial<FleetThread> & Pick<FleetThread, "threadId">): FleetThread {
  return {
    projectId: "p1",
    title: over.threadId,
    provider: "claude",
    model: "sonnet",
    createdAt: NOW - 2 * DAY,
    endedAt: NOW - DAY,
    activeMs: 3_600_000,
    costUsd: 1,
    inputTokens: 100,
    outputTokens: 50,
    turns: 2,
    linesAdded: null,
    linesSurviving: null,
    feltSavedMs: null,
    durabilityMeasurable: false,
    ...over,
  };
}

function pr(over: Partial<FleetPr> & Pick<FleetPr, "number">): FleetPr {
  return {
    projectId: "p1",
    url: `https://example.com/${over.number}`,
    title: `PR ${over.number}`,
    headRefName: `coder/t-${over.number}`,
    state: "OPEN",
    createdAt: NOW - 2 * DAY,
    mergedAt: null,
    closedAt: null,
    additions: 10,
    deletions: 2,
    firstReviewAt: null,
    threadId: "t1",
    ...over,
  };
}

function evidence(over: Partial<FleetEvidence> = {}): FleetEvidence {
  return {
    collectedAt: NOW,
    durabilityWindowDays: 14,
    threads: [],
    prs: [],
    notes: [],
    ...over,
  };
}

describe("summarizeFleet", () => {
  it("excludes open PRs from the merge-rate denominator", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [thread({ threadId: "t1", costUsd: 4 })],
        prs: [
          pr({ number: 1, state: "MERGED", threadId: "t1" }),
          pr({ number: 2, state: "MERGED", threadId: "t1" }),
          pr({ number: 3, state: "CLOSED", threadId: "t1" }),
          pr({ number: 4, state: "OPEN", threadId: "t1" }),
          pr({ number: 5, state: "OPEN", threadId: "t1" }),
        ],
      }),
      7,
      NOW,
    );
    const row = summary.providers[0];
    assert.equal(row.prsOpened, 5);
    assert.equal(row.prsMerged, 2);
    assert.equal(row.prsClosedUnmerged, 1);
    assert.equal(row.prsOpen, 2);
    assert.equal(row.mergeRate, 2 / 3);
    assert.equal(row.closeWithoutMergeRate, 1 / 3);
    assert.equal(summary.totals.mergeRate, 2 / 3);
    assert.equal(summary.totals.closeWithoutMergeRate, 1 / 3);
  });

  it("reports cost per merged PR as null when nothing merged", () => {
    const none = summarizeFleet(
      evidence({
        threads: [thread({ threadId: "t1", costUsd: 9 })],
        prs: [
          pr({ number: 1, state: "OPEN", threadId: "t1" }),
          pr({ number: 2, state: "CLOSED", threadId: "t1" }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(none.providers[0].costPerMergedPrUsd, null);
    assert.equal(none.totals.costPerMergedPrUsd, null);
    assert.equal(none.providers[0].costUsd, 9);

    const some = summarizeFleet(
      evidence({
        threads: [thread({ threadId: "t1", costUsd: 10 })],
        prs: [
          pr({ number: 1, state: "MERGED", threadId: "t1" }),
          pr({ number: 2, state: "MERGED", threadId: "t1" }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(some.providers[0].costPerMergedPrUsd, 5);
  });

  it("uses the median for review latency, even and odd counts", () => {
    const odd = summarizeFleet(
      evidence({
        threads: [thread({ threadId: "t1" })],
        prs: [
          pr({ number: 1, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 10 }),
          pr({ number: 2, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 30 }),
          pr({ number: 3, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 20 }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(odd.providers[0].reviewLatencyMs, 20);
    assert.equal(odd.totals.reviewLatencyMs, 20);

    const even = summarizeFleet(
      evidence({
        threads: [thread({ threadId: "t1" })],
        prs: [
          pr({ number: 1, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 10 }),
          pr({ number: 2, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 40 }),
          pr({ number: 3, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 20 }),
          pr({ number: 4, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 30 }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(even.providers[0].reviewLatencyMs, 25);
  });

  it("leaves reviewTax null when no human PR was reviewed", () => {
    const noHuman = summarizeFleet(
      evidence({
        threads: [thread({ threadId: "t1" })],
        prs: [
          pr({ number: 1, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 50 }),
          pr({ number: 2, threadId: null, firstReviewAt: null }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(noHuman.humanReviewLatencyMs, null);
    assert.equal(noHuman.reviewTax, null);
    assert.equal(noHuman.providers[0].reviewLatencyMs, 50);

    const both = summarizeFleet(
      evidence({
        threads: [thread({ threadId: "t1" })],
        prs: [
          pr({ number: 1, threadId: "t1", firstReviewAt: NOW - 2 * DAY + 40 }),
          pr({ number: 2, threadId: null, firstReviewAt: NOW - 2 * DAY + 10 }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(both.humanReviewLatencyMs, 10);
    assert.equal(both.reviewTax, 4);
  });

  it("treats durableShare as null until something is measurable", () => {
    const none = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "fresh",
            linesAdded: 80,
            linesSurviving: 80,
            durabilityMeasurable: false,
          }),
          thread({
            threadId: "blank",
            linesAdded: null,
            linesSurviving: null,
            durabilityMeasurable: true,
          }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(none.providers[0].durableShare, null);
    assert.equal(none.providers[0].reworkShare, null);
    assert.equal(none.providers[0].linesAdded, 0);
    assert.equal(none.providers[0].linesSurviving, 0);
    assert.equal(none.totals.durableShare, null);
    assert.equal(none.threads.find((t) => t.threadId === "fresh")?.durableShare, null);

    const some = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "old",
            linesAdded: 100,
            linesSurviving: 80,
            durabilityMeasurable: true,
          }),
          thread({
            threadId: "noise",
            linesAdded: 999,
            linesSurviving: 1,
            durabilityMeasurable: false,
          }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(some.providers[0].linesAdded, 100);
    assert.equal(some.providers[0].linesSurviving, 80);
    assert.equal(some.providers[0].durableShare, 0.8);
    assert.equal(some.providers[0].reworkShare, 1 - 0.8);
    assert.equal(some.threads.find((t) => t.threadId === "old")?.durableShare, 0.8);
    assert.equal(some.threads.find((t) => t.threadId === "noise")?.durableShare, null);
  });

  it("drops threads and PRs outside the range window", () => {
    const ev = evidence({
      threads: [
        thread({ threadId: "old", createdAt: NOW - 8 * DAY, endedAt: NOW - 8 * DAY + 1000, costUsd: 50 }),
        thread({ threadId: "in", createdAt: NOW - 3 * DAY, endedAt: NOW - 2 * DAY, costUsd: 2 }),
        thread({ threadId: "edge", createdAt: NOW - 7 * DAY, endedAt: NOW - 6 * DAY, costUsd: 3 }),
        thread({ threadId: "future", createdAt: NOW + 1, endedAt: NOW + 2, costUsd: 9 }),
      ],
      prs: [
        pr({ number: 1, threadId: "old", state: "MERGED", createdAt: NOW - 8 * DAY }),
        pr({ number: 2, threadId: "in", state: "MERGED", createdAt: NOW - 3 * DAY }),
      ],
    });
    const seven = summarizeFleet(ev, 7, NOW);
    assert.deepEqual(
      seven.threads.map((t) => t.threadId),
      ["in", "edge"],
    );
    assert.equal(seven.totals.threads, 2);
    assert.equal(seven.totals.costUsd, 5);
    assert.equal(seven.totals.prsMerged, 1);
    assert.equal(seven.totals.costPerMergedPrUsd, 5);

    const thirty = summarizeFleet(ev, 30, NOW);
    assert.equal(thirty.totals.threads, 3);
    assert.equal(thirty.totals.costUsd, 55);
    assert.equal(thirty.totals.prsMerged, 2);
  });

  it("recomputes totals from pooled counts rather than averaging rows", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "a1",
            provider: "claude",
            costUsd: 90,
            linesAdded: 100,
            linesSurviving: 80,
            durabilityMeasurable: true,
          }),
          thread({
            threadId: "b1",
            provider: "grok",
            costUsd: 10,
            linesAdded: 10,
            linesSurviving: 0,
            durabilityMeasurable: true,
          }),
        ],
        prs: [
          ...Array.from({ length: 9 }, (_, i) =>
            pr({ number: i + 1, threadId: "a1", state: "MERGED" }),
          ),
          pr({ number: 10, threadId: "a1", state: "CLOSED" }),
          pr({ number: 11, threadId: "b1", state: "CLOSED" }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(summary.providers[0].provider, "claude");
    assert.equal(summary.providers[0].mergeRate, 0.9);
    assert.equal(summary.providers[1].provider, "grok");
    assert.equal(summary.providers[1].mergeRate, 0);
    // Average of 0.9 and 0 would be 0.45; pooled is 9 / 11.
    assert.equal(summary.totals.mergeRate, 9 / 11);
    assert.equal(summary.totals.closeWithoutMergeRate, 2 / 11);
    assert.equal(summary.totals.costUsd, 100);
    assert.equal(summary.totals.prsMerged, 9);
    assert.equal(summary.totals.costPerMergedPrUsd, 100 / 9);
    // Average of 0.8 and 0 would be 0.4; pooled is 80 / 110.
    assert.equal(summary.totals.linesAdded, 110);
    assert.equal(summary.totals.linesSurviving, 80);
    assert.equal(summary.totals.durableShare, 80 / 110);
  });

  it("returns a valid empty-ish summary for a garbage evidence object", () => {
    const cases: unknown[] = [
      null,
      undefined,
      "nope",
      3,
      [],
      { threads: "nope", prs: 3, notes: 1 },
      {
        durabilityWindowDays: "nope",
        threads: [null, 5, { broken: true }, { threadId: "x", createdAt: "nope" }],
        prs: [{ state: "MAYBE" }, { number: "x" }, null],
        notes: ["gh missing", 12, { x: 1 }],
      },
      {
        durabilityWindowDays: 14,
        threads: [
          {
            threadId: "t1",
            provider: "claude",
            createdAt: NOW - DAY,
            endedAt: NOW,
            activeMs: -50,
            costUsd: "1.5",
            inputTokens: NaN,
            outputTokens: "10",
            linesAdded: -4,
            linesSurviving: "nope",
            durabilityMeasurable: "true",
          },
        ],
        prs: [
          {
            number: 1,
            state: "MERGED",
            createdAt: NOW - DAY,
            threadId: "t1",
            firstReviewAt: NOW - 2 * DAY,
          },
        ],
        notes: ["partial"],
      },
    ];
    for (const blob of cases) {
      const summary = summarizeFleet(blob as FleetEvidence, 7, NOW);
      assert.ok(Array.isArray(summary.providers));
      assert.ok(Array.isArray(summary.threads));
      assert.ok(Array.isArray(summary.notes));
      assert.equal(summary.totals.provider, "all");
      assert.ok(Number.isFinite(summary.totals.mergeRate));
      assert.ok(summary.totals.costPerMergedPrUsd === null || Number.isFinite(summary.totals.costPerMergedPrUsd));
      assert.ok(summary.reviewTax === null || Number.isFinite(summary.reviewTax));
    }

    const notesOnly = summarizeFleet(
      { notes: ["acme: gh missing"], threads: "x", prs: null } as unknown as FleetEvidence,
      7,
      NOW,
    );
    assert.deepEqual(notesOnly.notes, ["acme: gh missing"]);
    assert.equal(notesOnly.providers.length, 0);
    assert.equal(notesOnly.totals.threads, 0);
    assert.equal(notesOnly.humanReviewLatencyMs, null);
    assert.equal(notesOnly.reviewTax, null);
  });

  it("sorts providers by cost then name, and threads newest first", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({ threadId: "old", provider: "grok", createdAt: NOW - 4 * DAY, costUsd: 5 }),
          thread({ threadId: "new", provider: "claude", createdAt: NOW - DAY, costUsd: 5 }),
          thread({ threadId: "mid", provider: "kimi", createdAt: NOW - 2 * DAY, costUsd: 1 }),
        ],
        notes: ["blame budget reached"],
      }),
      7,
      NOW,
    );
    assert.deepEqual(
      summary.providers.map((p) => p.provider),
      ["claude", "grok", "kimi"],
    );
    assert.deepEqual(
      summary.threads.map((t) => t.threadId),
      ["new", "mid", "old"],
    );
    assert.deepEqual(summary.notes, ["blame budget reached"]);
  });

  it("picks merged, then open, then newest closed when a thread has several PRs", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({ threadId: "retry" }),
          thread({ threadId: "open-wins" }),
          thread({ threadId: "closed-newest" }),
          thread({ threadId: "none" }),
        ],
        prs: [
          pr({ number: 1, threadId: "retry", state: "CLOSED", createdAt: NOW - DAY }),
          pr({ number: 2, threadId: "retry", state: "MERGED", createdAt: NOW - 3 * DAY }),
          pr({ number: 3, threadId: "retry", state: "OPEN", createdAt: NOW - DAY }),
          pr({ number: 4, threadId: "open-wins", state: "CLOSED", createdAt: NOW - DAY }),
          pr({ number: 5, threadId: "open-wins", state: "OPEN", createdAt: NOW - 3 * DAY }),
          pr({ number: 6, threadId: "closed-newest", state: "CLOSED", createdAt: NOW - 3 * DAY }),
          pr({ number: 7, threadId: "closed-newest", state: "CLOSED", createdAt: NOW - DAY }),
        ],
      }),
      7,
      NOW,
    );
    const byId = Object.fromEntries(summary.threads.map((t) => [t.threadId, t]));
    assert.equal(byId.retry.outcome, "merged");
    assert.equal(byId.retry.prNumber, 2);
    assert.equal(byId["open-wins"].outcome, "open");
    assert.equal(byId["open-wins"].prNumber, 5);
    assert.equal(byId["closed-newest"].outcome, "closed");
    assert.equal(byId["closed-newest"].prNumber, 7);
    assert.equal(byId.none.outcome, "none");
    assert.equal(byId.none.prNumber, null);
  });

  it("does not clamp activeShare when parallel runs exceed wall clock", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "parallel",
            createdAt: NOW - 1000,
            endedAt: NOW,
            activeMs: 2500,
          }),
          thread({
            threadId: "still",
            createdAt: NOW - 1000,
            endedAt: NOW - 1000,
            activeMs: 10,
          }),
        ],
      }),
      7,
      NOW,
    );
    const parallel = summary.threads.find((t) => t.threadId === "parallel")!;
    assert.equal(parallel.wallClockMs, 1000);
    assert.equal(parallel.activeMs, 2500);
    const still = summary.threads.find((t) => t.threadId === "still")!;
    assert.equal(still.wallClockMs, 0);
    assert.equal(summary.providers[0].activeShare, 2510 / 1000);
    const idle = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "idle",
            createdAt: NOW - 1000,
            endedAt: NOW - 1000,
            activeMs: 10,
          }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(idle.providers[0].activeShare, 0);
  });
});

describe("perception (felt vs actual, issue #401)", () => {
  it("sums felt estimates against the same threads' clocks", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "a",
            createdAt: NOW - 2 * DAY,
            endedAt: NOW - DAY,
            activeMs: 2 * 3_600_000,
            feltSavedMs: 4 * 3_600_000,
          }),
          thread({
            threadId: "b",
            createdAt: NOW - 2 * DAY,
            endedAt: NOW - DAY,
            activeMs: 3_600_000,
            feltSavedMs: 2 * 3_600_000,
          }),
          // No estimate: counted nowhere in the perception bucket.
          thread({ threadId: "c", createdAt: NOW - 2 * DAY, endedAt: NOW }),
        ],
      }),
      7,
      NOW,
    );
    const p = summary.perception;
    assert.equal(p.estimates, 2);
    assert.equal(p.feltSavedMs, 6 * 3_600_000);
    assert.equal(p.wallClockMs, 2 * DAY);
    assert.equal(p.activeMs, 3 * 3_600_000);
    assert.equal(p.feltVsWall, (6 * 3_600_000) / (2 * DAY));
    assert.equal(p.feltVsActive, 2);
    const a = summary.threads.find((t) => t.threadId === "a")!;
    assert.equal(a.feltSavedMs, 4 * 3_600_000);
    const c = summary.threads.find((t) => t.threadId === "c")!;
    assert.equal(c.feltSavedMs, null);
  });

  it("excludes estimates from threads outside the range", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "old",
            createdAt: NOW - 40 * DAY,
            endedAt: NOW - 39 * DAY,
            feltSavedMs: 3_600_000,
          }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(summary.perception.estimates, 0);
    assert.equal(summary.perception.feltVsWall, null);
  });

  it("null ratio, never Infinity, when the clock side is 0", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "instant",
            createdAt: NOW - 1000,
            endedAt: NOW - 1000,
            activeMs: 0,
            feltSavedMs: 3_600_000,
          }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(summary.perception.estimates, 1);
    assert.equal(summary.perception.feltVsWall, null);
    assert.equal(summary.perception.feltVsActive, null);
  });

  it("heals garbage feltSavedMs to null instead of skewing the sum", () => {
    const summary = summarizeFleet(
      evidence({
        threads: [
          thread({
            threadId: "junk",
            feltSavedMs: -5 as unknown as number,
          }),
          thread({
            threadId: "junk2",
            feltSavedMs: "2h" as unknown as number,
          }),
        ],
      }),
      7,
      NOW,
    );
    assert.equal(summary.perception.estimates, 0);
    assert.equal(summary.perception.feltSavedMs, 0);
  });

  it("empty evidence yields an empty perception bucket", () => {
    const summary = summarizeFleet(evidence(), 7, NOW);
    assert.deepEqual(summary.perception, {
      estimates: 0,
      feltSavedMs: 0,
      wallClockMs: 0,
      activeMs: 0,
      feltVsWall: null,
      feltVsActive: null,
    });
  });
});
