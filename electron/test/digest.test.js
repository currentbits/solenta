/**
 * electron/digest.js: window filter, cost, check evidence, gitStats injection.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { collectDigest } = require("../digest.js");

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function thread(over) {
  return {
    id: "t1",
    projectId: "p1",
    title: over.title ?? over.id ?? "t1",
    provider: "claude",
    status: "done",
    awaitingInput: false,
    lastError: null,
    updatedAt: NOW,
    archived: false,
    prNumber: null,
    prState: null,
    worktreePath: null,
    ...over,
  };
}

function project(over) {
  return {
    id: "p1",
    slug: "owner/repo",
    path: "/tmp/repo",
    ...over,
  };
}

function zeros() {
  return { filesChanged: 0, additions: 0, deletions: 0, commits: 0 };
}

function makeStore({
  threads = [],
  projects = [project()],
  messages = {},
  usage = {},
  digestSeenAt = null,
} = {}) {
  return {
    getThreads: () => threads,
    getProject: (id) => projects.find((p) => p.id === id) || null,
    getMessages: (id) => messages[id] || [],
    getUsage: (id) =>
      Object.prototype.hasOwnProperty.call(usage, id) ? usage[id] : null,
    getDigestSeenAt: () => digestSeenAt,
  };
}

function collect(over) {
  return collectDigest({
    nowMs: NOW,
    gitStats: async () => zeros(),
    ...over,
  });
}

describe("collectDigest", () => {
  it("excludes threads older than the window and includes ones inside it", async () => {
    const sinceMs = NOW - HOUR;
    const result = await collect({
      store: makeStore({
        threads: [
          thread({ id: "old", updatedAt: sinceMs - 1 }),
          thread({ id: "in", updatedAt: sinceMs }),
          thread({ id: "fresh", updatedAt: NOW }),
        ],
      }),
      sinceMs,
    });
    assert.equal(result.sinceMs, sinceMs);
    assert.equal(result.generatedAt, NOW);
    assert.deepEqual(
      result.runs.map((r) => r.threadId),
      ["fresh", "in"],
    );
  });

  it("excludes archived threads", async () => {
    const result = await collect({
      store: makeStore({
        threads: [
          thread({ id: "kept", updatedAt: NOW }),
          thread({ id: "gone", updatedAt: NOW, archived: true }),
        ],
      }),
      sinceMs: NOW - HOUR,
    });
    assert.deepEqual(
      result.runs.map((r) => r.threadId),
      ["kept"],
    );
  });

  it("skips a plain working thread but includes one awaiting input", async () => {
    const result = await collect({
      store: makeStore({
        threads: [
          thread({ id: "running", status: "working", updatedAt: NOW }),
          thread({
            id: "stalled",
            status: "working",
            awaitingInput: true,
            updatedAt: NOW - 1,
          }),
          thread({ id: "done", status: "done", updatedAt: NOW - 2 }),
        ],
      }),
      sinceMs: NOW - HOUR,
    });
    assert.deepEqual(
      result.runs.map((r) => r.threadId),
      ["stalled", "done"],
    );
    assert.equal(result.runs[0].awaitingInput, true);
  });

  it("reads cost and turns from usage, and 0 when usage is null", async () => {
    const result = await collect({
      store: makeStore({
        threads: [
          thread({ id: "billed", updatedAt: NOW }),
          thread({ id: "free", updatedAt: NOW - 1 }),
        ],
        usage: { billed: { costUsd: 1.25, turns: 4 } },
      }),
      sinceMs: NOW - HOUR,
    });
    const billed = result.runs.find((r) => r.threadId === "billed");
    const free = result.runs.find((r) => r.threadId === "free");
    assert.equal(billed.costUsd, 1.25);
    assert.equal(billed.turns, 4);
    assert.equal(free.costUsd, 0);
    assert.equal(free.turns, 0);
  });

  it("records check evidence: ran+passed, ran+failed, none, and ignores old tools", async () => {
    const sinceMs = NOW - HOUR;
    const result = await collect({
      store: makeStore({
        threads: [
          thread({ id: "pass", updatedAt: NOW }),
          thread({ id: "fail", updatedAt: NOW }),
          thread({ id: "none", updatedAt: NOW }),
          thread({ id: "stale", updatedAt: NOW }),
        ],
        messages: {
          pass: [
            {
              role: "tool",
              createdAt: sinceMs,
              tool: { input: "cd app && npm test", isError: false },
            },
          ],
          fail: [
            {
              role: "tool",
              createdAt: sinceMs,
              tool: { input: "npm test", isError: false },
            },
            {
              role: "tool",
              createdAt: sinceMs + 1,
              tool: { input: "pnpm run lint", isError: true },
            },
          ],
          none: [
            {
              role: "tool",
              createdAt: sinceMs,
              tool: { input: "ls -la", isError: true },
            },
          ],
          stale: [
            {
              role: "tool",
              createdAt: sinceMs - 1,
              tool: { input: "npm test", isError: true },
            },
          ],
        },
      }),
      sinceMs,
    });
    const byId = Object.fromEntries(result.runs.map((r) => [r.threadId, r]));
    assert.deepEqual(byId.pass.checks, {
      ran: true,
      failed: false,
      label: "npm test",
    });
    assert.deepEqual(byId.fail.checks, {
      ran: true,
      failed: true,
      label: "pnpm run lint",
    });
    assert.deepEqual(byId.none.checks, {
      ran: false,
      failed: false,
      label: null,
    });
    assert.deepEqual(byId.stale.checks, {
      ran: false,
      failed: false,
      label: null,
    });
  });

  it("defaults the window to 12h when digestSeenAt is null", async () => {
    const result = await collect({
      store: makeStore({
        digestSeenAt: null,
        threads: [
          thread({ id: "inside", updatedAt: NOW - 11 * HOUR }),
          thread({ id: "outside", updatedAt: NOW - 13 * HOUR }),
        ],
      }),
    });
    assert.equal(result.sinceMs, NOW - 12 * HOUR);
    assert.deepEqual(
      result.runs.map((r) => r.threadId),
      ["inside"],
    );
  });

  it("yields zero git stats when gitStats rejects", async () => {
    const result = await collectDigest({
      store: makeStore({
        threads: [thread({ id: "t1", updatedAt: NOW })],
      }),
      sinceMs: NOW - HOUR,
      nowMs: NOW,
      gitStats: async () => {
        throw new Error("git died");
      },
    });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].filesChanged, 0);
    assert.equal(result.runs[0].additions, 0);
    assert.equal(result.runs[0].deletions, 0);
    assert.equal(result.runs[0].commits, 0);
  });
});
