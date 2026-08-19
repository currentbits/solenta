/**
 * electron/fleet.js: activeMs by run, human vs agent PRs, line durability,
 * blame-budget notes, and a missing-gh path that never throws.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { collectFleet, BLAME_COMMIT_CAP } = require("../fleet.js");

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function thread(over) {
  return {
    id: "t1",
    projectId: "p1",
    title: over.title ?? over.id ?? "t1",
    provider: "claude",
    model: "opus",
    branch: "coder/t1",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    archived: false,
    ...over,
  };
}

function project(over) {
  return {
    id: "p1",
    slug: "solenta",
    name: "solenta",
    path: "/tmp/solenta",
    ...over,
  };
}

function makeStore({
  threads = [],
  projects = [project()],
  usage = {},
  workLog = {},
} = {}) {
  return {
    getThreads: () => threads,
    getProjects: () => projects,
    getProject: (id) => projects.find((p) => p.id === id) || null,
    getUsage: (id) =>
      Object.prototype.hasOwnProperty.call(usage, id) ? usage[id] : null,
    getWorkLog: (id) => workLog[id] || [],
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function ghPr(over) {
  return {
    number: 12,
    title: "Agent work",
    url: "https://github.com/acme/solenta/pull/12",
    state: "MERGED",
    headRefName: "coder/t1",
    createdAt: iso(NOW - 20 * DAY),
    mergedAt: iso(NOW - 18 * DAY),
    closedAt: iso(NOW - 18 * DAY),
    additions: 10,
    deletions: 2,
    reviews: [{ submittedAt: iso(NOW - 19 * DAY) }],
    ...over,
  };
}

function blameLines(sha, n) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `${sha} ${i + 1} ${i + 1}\n`;
    out += `\tline ${i}\n`;
  }
  return out;
}

function collect(over) {
  return collectFleet({
    nowMs: NOW,
    days: 90,
    listPrsFn: async () => ({ ok: true, prs: [] }),
    gitFn: async () => ({ ok: false, stdout: "" }),
    ...over,
  });
}

describe("collectFleet", () => {
  it("sums activeMs by runId, not wall clock, and a single-item run is 0", async () => {
    const result = await collect({
      store: makeStore({
        threads: [
          thread({
            id: "t1",
            createdAt: NOW - 5 * DAY,
            updatedAt: NOW,
          }),
        ],
        workLog: {
          t1: [
            { runId: "r1", timestamp: NOW - 10_000 },
            { runId: "r1", timestamp: NOW - 4_000 },
            { runId: "r2", timestamp: NOW - 3_000 },
            { runId: "r2", timestamp: NOW - 1_000 },
            { runId: "r3", timestamp: NOW - 500 },
          ],
        },
      }),
    });
    assert.equal(result.threads.length, 1);
    // r1: 6000, r2: 2000, r3: 0. Wall clock would be ~10s or created→ended.
    assert.equal(result.threads[0].activeMs, 8_000);
    assert.ok(result.threads[0].endedAt - result.threads[0].createdAt > 8_000);
  });

  it("a human PR (no matching branch) comes back with threadId null", async () => {
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1", branch: "coder/agent" })],
      }),
      listPrsFn: async () => ({
        ok: true,
        prs: [
          ghPr({
            number: 7,
            title: "Human fix",
            url: "https://github.com/acme/solenta/pull/7",
            headRefName: "humans/fix-typo",
            state: "OPEN",
            mergedAt: null,
            closedAt: null,
          }),
          ghPr({
            number: 8,
            title: "Agent fix",
            url: "https://github.com/acme/solenta/pull/8",
            headRefName: "coder/agent",
            state: "OPEN",
            mergedAt: null,
            closedAt: null,
          }),
        ],
      }),
    });
    const human = result.prs.find((p) => p.number === 7);
    const agent = result.prs.find((p) => p.number === 8);
    assert.ok(human);
    assert.equal(human.threadId, null);
    assert.ok(agent);
    assert.equal(agent.threadId, "t1");
    assert.equal(human.firstReviewAt, NOW - 19 * DAY);
  });

  it("measures linesAdded/linesSurviving from an injected git fn", async () => {
    const oldAt = Math.floor((NOW - 20 * DAY) / 1000);
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1", branch: "coder/t1" })],
      }),
      listPrsFn: async () => ({ ok: true, prs: [ghPr()] }),
      gitFn: async (_cwd, args) => {
        if (args[0] === "branch") return { ok: true, stdout: "main" };
        if (args[0] === "log") {
          return {
            ok: true,
            stdout: `${SHA}\0${oldAt}\0feat: thing (#12)`,
          };
        }
        if (args[0] === "show") {
          return { ok: true, stdout: "10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n" };
        }
        if (args[0] === "blame") {
          const file = args[args.length - 1];
          if (file === "src/a.ts") {
            return {
              ok: true,
              stdout: blameLines(SHA, 8) + blameLines(OTHER, 2),
            };
          }
          return { ok: true, stdout: blameLines(SHA, 5) };
        }
        return { ok: false, stdout: "" };
      },
    });
    const row = result.threads[0];
    assert.equal(row.linesAdded, 15);
    assert.equal(row.linesSurviving, 13);
    assert.equal(row.durabilityMeasurable, true);
    assert.equal(result.durabilityWindowDays, 14);
  });

  it("marks a fresh merge durabilityMeasurable false but still reports counts", async () => {
    const freshAt = Math.floor((NOW - DAY) / 1000);
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1", branch: "coder/t1" })],
      }),
      listPrsFn: async () => ({
        ok: true,
        prs: [
          ghPr({
            createdAt: iso(NOW - 2 * DAY),
            mergedAt: iso(NOW - DAY),
          }),
        ],
      }),
      gitFn: async (_cwd, args) => {
        if (args[0] === "branch") return { ok: true, stdout: "main" };
        if (args[0] === "log") {
          return {
            ok: true,
            stdout: `${SHA}\0${freshAt}\0feat: thing (#12)`,
          };
        }
        if (args[0] === "show") {
          return { ok: true, stdout: "4\t0\tsrc/a.ts\n" };
        }
        if (args[0] === "blame") {
          return { ok: true, stdout: blameLines(SHA, 4) };
        }
        return { ok: false, stdout: "" };
      },
    });
    const row = result.threads[0];
    assert.equal(row.linesAdded, 4);
    assert.equal(row.linesSurviving, 4);
    assert.equal(row.durabilityMeasurable, false);
  });

  it("gh missing yields a note and does not throw", async () => {
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1" })],
      }),
      listPrsFn: async () => ({ ok: false, reason: "gh missing" }),
    });
    assert.deepEqual(result.notes, ["solenta: gh missing"]);
    assert.equal(result.threads.length, 1);
    assert.deepEqual(result.prs, []);
  });

  it("null usage is zeros, archived and old threads are dropped", async () => {
    const result = await collect({
      store: makeStore({
        threads: [
          thread({ id: "kept", createdAt: NOW - DAY }),
          thread({ id: "old", createdAt: NOW - 120 * DAY }),
          thread({ id: "gone", createdAt: NOW - DAY, archived: true }),
        ],
        usage: { kept: { costUsd: 1.5, inputTokens: 10, outputTokens: 4, turns: 2 } },
      }),
    });
    assert.deepEqual(
      result.threads.map((t) => t.threadId),
      ["kept"],
    );
    assert.equal(result.threads[0].costUsd, 1.5);
    assert.equal(result.threads[0].inputTokens, 10);
    assert.equal(result.threads[0].outputTokens, 4);
    assert.equal(result.threads[0].turns, 2);
  });

  it("a missing merge commit leaves linesAdded/linesSurviving null, not zero", async () => {
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1", branch: "coder/t1" })],
      }),
      listPrsFn: async () => ({ ok: true, prs: [ghPr()] }),
      gitFn: async (_cwd, args) => {
        if (args[0] === "branch") return { ok: true, stdout: "main" };
        if (args[0] === "log") {
          return { ok: true, stdout: `${SHA}\0${NOW / 1000}\0unrelated` };
        }
        return { ok: false, stdout: "" };
      },
    });
    assert.equal(result.threads[0].linesAdded, null);
    assert.equal(result.threads[0].linesSurviving, null);
    assert.equal(result.threads[0].durabilityMeasurable, false);
  });

  it("unparseable review timestamps and a short-field fallback stay null", async () => {
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1", branch: "coder/t1" })],
      }),
      listPrsFn: async () => ({
        ok: true,
        prs: [
          {
            number: 3,
            title: "old gh",
            url: "https://github.com/acme/solenta/pull/3",
            state: "OPEN",
            headRefName: "coder/t1",
            createdAt: iso(NOW - DAY),
          },
          ghPr({
            number: 4,
            url: "https://github.com/acme/solenta/pull/4",
            reviews: [{ submittedAt: "not-a-date" }],
          }),
        ],
      }),
    });
    const short = result.prs.find((p) => p.number === 3);
    const bad = result.prs.find((p) => p.number === 4);
    assert.equal(short.firstReviewAt, null);
    assert.equal(bad.firstReviewAt, null);
    assert.equal(short.mergedAt, null);
  });

  it("skips remoteHost projects and notes a non-GitHub local repo", async () => {
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1" })],
        projects: [
          project({ id: "p1", slug: "solenta", remoteHost: "box" }),
          project({ id: "p2", slug: "acme", path: "/tmp/acme" }),
        ],
      }),
      listPrsFn: async (p) => {
        if (p.id === "p1") throw new Error("should not list remotes");
        return { ok: false, reason: "not a GitHub repo" };
      },
    });
    assert.deepEqual(result.notes, ["acme: not a GitHub repo"]);
    assert.deepEqual(result.prs, []);
  });

  it("notes when the blame budget is reached instead of silently truncating", async () => {
    const oldAt = Math.floor((NOW - 30 * DAY) / 1000);
    const many = [];
    for (let i = 1; i <= BLAME_COMMIT_CAP + 3; i++) {
      many.push(
        ghPr({
          number: i,
          url: `https://github.com/acme/solenta/pull/${i}`,
          headRefName: "coder/t1",
        }),
      );
    }
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1", branch: "coder/t1" })],
      }),
      listPrsFn: async () => ({ ok: true, prs: many }),
      gitFn: async (_cwd, args) => {
        if (args[0] === "branch") return { ok: true, stdout: "main" };
        if (args[0] === "log") {
          const lines = [];
          for (let i = 1; i <= BLAME_COMMIT_CAP + 3; i++) {
            const sha = i.toString(16).padStart(40, "c");
            lines.push(`${sha}\0${oldAt}\0feat (#${i})`);
          }
          return { ok: true, stdout: lines.join("\n") };
        }
        if (args[0] === "show") return { ok: true, stdout: "1\t0\ta.ts\n" };
        if (args[0] === "blame") {
          return { ok: true, stdout: blameLines(args[1] === "show" ? SHA : args[3] || SHA, 0) };
        }
        return { ok: false, stdout: "" };
      },
    });
    assert.ok(
      result.notes.some((n) =>
        /solenta: blame budget reached, 3 commits unmeasured/.test(n),
      ),
      result.notes.join(" | "),
    );
    // Tainted: the leftover commits belong to the same thread, so counts
    // stay null rather than looking like full coverage.
    assert.equal(result.threads[0].linesAdded, null);
    assert.equal(result.threads[0].linesSurviving, null);
  });

  it("never rejects when listPrsFn or gitFn throw", async () => {
    const result = await collect({
      store: makeStore({
        threads: [thread({ id: "t1", branch: "coder/t1" })],
      }),
      listPrsFn: async () => {
        throw new Error("boom");
      },
      gitFn: async () => {
        throw new Error("git boom");
      },
    });
    assert.deepEqual(result.notes, ["solenta: gh failed"]);
    assert.equal(result.threads.length, 1);
  });
});

describe("collectFleet felt estimate (issue #401)", () => {
  it("carries a saved estimate as feltSavedMs; declined and absent are null", async () => {
    const result = await collect({
      store: makeStore({
        threads: [
          thread({
            id: "t1",
            feltEstimate: { kind: "saved", savedMs: 3_600_000, at: NOW },
          }),
          thread({
            id: "t2",
            title: "t2",
            feltEstimate: { kind: "declined", at: NOW },
          }),
          thread({ id: "t3", title: "t3" }),
          thread({
            id: "t4",
            title: "t4",
            feltEstimate: { kind: "saved", savedMs: "2h", at: NOW },
          }),
        ],
      }),
    });
    const byId = Object.fromEntries(
      result.threads.map((t) => [t.threadId, t]),
    );
    assert.equal(byId.t1.feltSavedMs, 3_600_000);
    assert.equal(byId.t2.feltSavedMs, null);
    assert.equal(byId.t3.feltSavedMs, null);
    assert.equal(byId.t4.feltSavedMs, null);
  });
});
