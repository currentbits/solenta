/**
 * The seam between the collector (electron/fleet.js) and the rollup
 * (src/fleet.ts): each side was built against a fake of the other, so this
 * drives the REAL collector's evidence into the REAL summarizeFleet. If a
 * field is renamed, dropped, or starts arriving as an ISO string where the
 * rollup expects epoch ms, this is what fails — the unit tests on either
 * side would both stay green.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { collectFleet } = require("../fleet.js");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** @type {typeof import("../../src/fleet.ts").summarizeFleet} */
let summarizeFleet;

before(async () => {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "../../src/fleet.ts")).href
  );
  summarizeFleet = mod.summarizeFleet;
});

function iso(ms) {
  return new Date(ms).toISOString();
}

function blameLines(sha, n) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `${sha} ${i + 1} ${i + 1}\n\tline ${i}\n`;
  }
  return out;
}

const THREADS = [
  {
    id: "t1",
    projectId: "p1",
    title: "Claude merged one",
    provider: "claude",
    model: "opus",
    branch: "coder/t1",
    createdAt: NOW - 25 * DAY,
    updatedAt: NOW - 24 * DAY,
    archived: false,
  },
  {
    id: "t2",
    projectId: "p1",
    title: "Grok closed one",
    provider: "grok",
    model: null,
    branch: "coder/t2",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 9 * DAY,
    archived: false,
  },
];

const PRS = [
  {
    number: 11,
    title: "Claude work",
    url: "https://github.com/acme/solenta/pull/11",
    state: "MERGED",
    headRefName: "coder/t1",
    createdAt: iso(NOW - 25 * DAY),
    mergedAt: iso(NOW - 23 * DAY),
    closedAt: iso(NOW - 23 * DAY),
    additions: 15,
    deletions: 2,
    // Reviewed 2 days after opening.
    reviews: [{ submittedAt: iso(NOW - 23 * DAY) }],
  },
  {
    number: 12,
    title: "Grok work",
    url: "https://github.com/acme/solenta/pull/12",
    state: "CLOSED",
    headRefName: "coder/t2",
    createdAt: iso(NOW - 10 * DAY),
    mergedAt: null,
    closedAt: iso(NOW - 9 * DAY),
    additions: 4,
    deletions: 1,
    reviews: [],
  },
  {
    number: 13,
    title: "Human work",
    url: "https://github.com/acme/solenta/pull/13",
    state: "MERGED",
    headRefName: "willem/hand-written",
    createdAt: iso(NOW - 8 * DAY),
    mergedAt: iso(NOW - 7 * DAY),
    closedAt: iso(NOW - 7 * DAY),
    additions: 3,
    deletions: 0,
    // Reviewed 1 day after opening: half the agent wait, so tax = 2.
    reviews: [{ submittedAt: iso(NOW - 7 * DAY) }],
  },
];

const STORE = {
  getThreads: () => THREADS,
  getProjects: () => [
    { id: "p1", slug: "solenta", name: "solenta", path: "/tmp/solenta" },
  ],
  getProject: (id) => (id === "p1" ? { id: "p1", slug: "solenta", path: "/tmp/solenta" } : null),
  getUsage: (id) =>
    id === "t1"
      ? { costUsd: 6, inputTokens: 1000, outputTokens: 500, turns: 4 }
      : { costUsd: 2, inputTokens: 200, outputTokens: 100, turns: 1 },
  getWorkLog: (id) =>
    id === "t1"
      ? [
          { runId: "r1", timestamp: NOW - 25 * DAY },
          { runId: "r1", timestamp: NOW - 25 * DAY + 60_000 },
        ]
      : [],
};

async function gitFn(_cwd, args) {
  if (args[0] === "branch") return { ok: true, stdout: "main" };
  if (args[0] === "log") {
    const at = Math.floor((NOW - 23 * DAY) / 1000);
    return { ok: true, stdout: `${SHA}\0${at}\0Claude work (#11)` };
  }
  if (args[0] === "show") return { ok: true, stdout: "15\t2\tsrc/a.ts\n" };
  if (args[0] === "blame") {
    return { ok: true, stdout: blameLines(SHA, 12) + blameLines("b".repeat(40), 3) };
  }
  return { ok: false, stdout: "" };
}

describe("fleet seam: real collector into real rollup", () => {
  it("turns collected evidence into the rates the view renders", async () => {
    const evidence = await collectFleet({
      store: STORE,
      nowMs: NOW,
      days: 90,
      listPrsFn: async () => ({ ok: true, prs: PRS }),
      gitFn,
    });

    const summary = summarizeFleet(evidence, 90, NOW);

    const claude = summary.providers.find((p) => p.provider === "claude");
    const grok = summary.providers.find((p) => p.provider === "grok");
    assert.ok(claude, "claude row");
    assert.ok(grok, "grok row");

    // Merge rate: claude merged its only decided PR, grok closed its only one.
    assert.equal(claude.prsMerged, 1);
    assert.equal(claude.mergeRate, 1);
    assert.equal(grok.prsClosedUnmerged, 1);
    assert.equal(grok.mergeRate, 0);
    assert.equal(grok.closeWithoutMergeRate, 1);

    // Cost per MERGED PR, not per token: $6 over one merge, and null for a
    // provider that merged nothing.
    assert.equal(claude.costPerMergedPrUsd, 6);
    assert.equal(grok.costPerMergedPrUsd, null);

    // Durability: 15 lines added by the squash commit, 12 still blamed to it.
    assert.equal(claude.linesAdded, 15);
    assert.equal(claude.linesSurviving, 12);
    assert.equal(claude.durableShare, 12 / 15);
    assert.equal(claude.reworkShare, 1 - 12 / 15);
    // Grok's PR never merged, so it has nothing measurable — null, not 0.
    assert.equal(grok.durableShare, null);

    // Active time is per-run, wall clock is createdAt -> updatedAt.
    assert.equal(claude.activeMs, 60_000);
    assert.equal(claude.wallClockMs, DAY);

    // Review tax: agent PR waited 2 days, the human PR 1 day.
    assert.equal(summary.humanReviewLatencyMs, DAY);
    assert.equal(summary.reviewTax, 2);

    // The human PR is the baseline, never an agent row.
    assert.equal(summary.threads.length, 2);
    assert.deepEqual(
      summary.threads.map((t) => t.outcome).sort(),
      ["closed", "merged"],
    );
  });

  it("survives a project with no gh: partial evidence, a note, no throw", async () => {
    const evidence = await collectFleet({
      store: STORE,
      nowMs: NOW,
      days: 90,
      listPrsFn: async () => ({ ok: false, reason: "gh missing" }),
      gitFn,
    });

    const summary = summarizeFleet(evidence, 90, NOW);
    assert.ok(summary.notes.length > 0, "collection note reaches the view");
    assert.equal(summary.totals.prsOpened, 0);
    // No PRs decided anywhere: a 0 merge rate here means "nothing decided",
    // which is why the view leans on notes rather than the bare number.
    assert.equal(summary.totals.costPerMergedPrUsd, null);
    assert.equal(summary.threads.length, 2);
  });
});
