/**
 * summarizeDigest: bucketing, risk flags, ordering, wasted spend.
 * Run: npm run test:renderer
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DIGEST_BUCKETS,
  digestHeadline,
  formatUsd,
  summarizeDigest,
} from "../src/digest.ts";
import type { DigestRun } from "../src/shared/ipc.ts";

const NOW = 1_700_000_000_000;

function run(over: Partial<DigestRun> & Pick<DigestRun, "threadId">): DigestRun {
  return {
    projectId: "p1",
    projectSlug: "coder",
    title: over.threadId,
    provider: "claude",
    status: "done",
    awaitingInput: false,
    lastError: null,
    endedAt: NOW,
    costUsd: 0,
    turns: 1,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    commits: 0,
    prNumber: null,
    prState: null,
    checks: { ran: false, failed: false, label: null },
    ...over,
  };
}

function bucketOf(summary: ReturnType<typeof summarizeDigest>, id: string) {
  for (const group of summary.groups) {
    if (group.entries.some((e) => e.run.threadId === id)) return group.bucket;
  }
  return null;
}

describe("summarizeDigest", () => {
  it("always returns the three buckets in reading order", () => {
    const summary = summarizeDigest([]);
    assert.deepEqual(
      summary.groups.map((g) => g.bucket),
      DIGEST_BUCKETS,
    );
    assert.equal(summary.runs, 0);
    assert.equal(summary.costUsd, 0);
  });

  it("a run that produced changes and passed checks is merge-ready", () => {
    const summary = summarizeDigest([
      run({
        threadId: "t1",
        filesChanged: 3,
        additions: 40,
        deletions: 5,
        commits: 1,
        checks: { ran: true, failed: false, label: "npm test" },
      }),
    ]);
    assert.equal(bucketOf(summary, "t1"), "merge-ready");
    const entry = summary.groups[0].entries[0];
    assert.match(entry.reason, /3 files changed/);
    assert.deepEqual(entry.risks, []);
  });

  it("CI workflow diffs need a human even with a green PR (issue #510)", () => {
    const summary = summarizeDigest([
      run({
        threadId: "ci",
        filesChanged: 2,
        commits: 1,
        prNumber: 12,
        prState: "OPEN",
        ciWorkflow: true,
        checks: { ran: true, failed: false, label: "npm test" },
      }),
    ]);
    assert.equal(bucketOf(summary, "ci"), "needs-you");
    const entry = summary.groups
      .find((g) => g.bucket === "needs-you")!
      .entries[0];
    assert.match(entry.reason, /CI workflow/);
    assert.ok(entry.risks.includes("CI workflow"));
  });

  it("a stalled prompt, a failure and failed checks all need you", () => {
    const summary = summarizeDigest([
      run({ threadId: "stalled", awaitingInput: true, filesChanged: 2 }),
      run({ threadId: "failed", status: "failed", lastError: "Run error: boom" }),
      run({
        threadId: "red",
        filesChanged: 1,
        checks: { ran: true, failed: true, label: "npm test" },
      }),
    ]);
    for (const id of ["stalled", "failed", "red"]) {
      assert.equal(bucketOf(summary, id), "needs-you", id);
    }
  });

  it("burned tokens with no output land in discard and count as wasted", () => {
    const summary = summarizeDigest([
      run({ threadId: "nothing", costUsd: 1.8 }),
      run({ threadId: "shipped", costUsd: 2.2, commits: 1, checks: { ran: true, failed: false, label: "npm test" } }),
    ]);
    assert.equal(bucketOf(summary, "nothing"), "discard");
    assert.equal(summary.wastedUsd, 1.8);
    assert.equal(Number(summary.costUsd.toFixed(2)), 4);
    const discard = summary.groups.find((g) => g.bucket === "discard")!;
    assert.deepEqual(discard.entries[0].risks, ["spent, produced nothing"]);
  });

  it("flags the risks that make a diff unreviewable at a glance", () => {
    const summary = summarizeDigest([
      run({
        threadId: "big",
        filesChanged: 25,
        additions: 900,
        deletions: 200,
        commits: 0,
      }),
    ]);
    const entry = summary.groups[0].entries[0];
    assert.deepEqual(entry.risks, [
      "no test evidence",
      "large diff (1100 lines)",
      "touches 25 files",
      "uncommitted",
    ]);
  });

  it("orders each bucket by cost, then recency", () => {
    const summary = summarizeDigest([
      run({ threadId: "cheap", costUsd: 0.1, commits: 1, endedAt: NOW }),
      run({ threadId: "dear", costUsd: 5, commits: 1, endedAt: NOW - 1000 }),
      run({ threadId: "tie", costUsd: 0.1, commits: 1, endedAt: NOW + 1000 }),
    ]);
    assert.deepEqual(
      summary.groups[0].entries.map((e) => e.run.threadId),
      ["dear", "tie", "cheap"],
    );
  });

  it("survives junk rows without checks", () => {
    const summary = summarizeDigest([
      { ...run({ threadId: "old" }), checks: undefined as never },
      null as never,
    ]);
    assert.equal(summary.runs, 1);
    assert.equal(bucketOf(summary, "old"), "discard");
  });
});

describe("digest formatting", () => {
  it("rounds to cents but never to nothing", () => {
    assert.equal(formatUsd(0), "$0");
    assert.equal(formatUsd(0.004), "<$0.01");
    assert.equal(formatUsd(1.239), "$1.24");
  });

  it("headline names the waste only when there is some", () => {
    const clean = summarizeDigest([run({ threadId: "a", costUsd: 1, commits: 1 })]);
    assert.equal(digestHeadline(clean), "1 run · $1.00");
    const wasteful = summarizeDigest([run({ threadId: "b", costUsd: 2 })]);
    assert.equal(digestHeadline(wasteful), "1 run · $2.00 · $2.00 wasted");
  });
});
