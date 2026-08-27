"use strict";

/**
 * Issue #722: dual-gate + prompt + scheduler for sleep-time consolidation.
 * Run: npm run test:electron
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MIN_OPEN,
  WORK_CAP,
  TITLE,
  shouldConsolidate,
  isMemoryConsolidateTool,
  buildConsolidatePrompt,
  fireConsolidate,
  startMemoryConsolidateScheduler,
  pruneConsolidateThreads,
  MAX_THREADS_PER_PROJECT,
} = require("../memory-consolidate.js");

function at(y, m, d, h = 0) {
  return new Date(y, m, d, h, 0, 0, 0).getTime();
}

describe("shouldConsolidate dual-gate", () => {
  const now = at(2026, 7, 27, 12);

  it("fires when never run and the queue is deep enough", () => {
    assert.deepEqual(
      shouldConsolidate({
        lastRunAt: null,
        openCount: DEFAULT_MIN_OPEN,
        now,
        minIntervalMs: DEFAULT_INTERVAL_MS,
        minOpen: DEFAULT_MIN_OPEN,
      }),
      { ok: true },
    );
  });

  it("skips when the queue is below the activity bar", () => {
    assert.deepEqual(
      shouldConsolidate({
        lastRunAt: null,
        openCount: DEFAULT_MIN_OPEN - 1,
        now,
        minOpen: DEFAULT_MIN_OPEN,
      }),
      { ok: false, reason: "queue" },
    );
    assert.deepEqual(
      shouldConsolidate({ lastRunAt: null, openCount: 0, now, minOpen: 5 }),
      { ok: false, reason: "queue" },
    );
  });

  it("skips when the last fire was inside the 24h window", () => {
    assert.deepEqual(
      shouldConsolidate({
        lastRunAt: now - DEFAULT_INTERVAL_MS + 1,
        openCount: 20,
        now,
        minIntervalMs: DEFAULT_INTERVAL_MS,
        minOpen: 5,
      }),
      { ok: false, reason: "interval" },
    );
  });

  it("fires at the 24h boundary with enough open items", () => {
    assert.deepEqual(
      shouldConsolidate({
        lastRunAt: now - DEFAULT_INTERVAL_MS,
        openCount: 5,
        now,
        minIntervalMs: DEFAULT_INTERVAL_MS,
        minOpen: 5,
      }),
      { ok: true },
    );
  });
});

describe("isMemoryConsolidateTool", () => {
  it("allows coder-memory tools and bare memory_/session_ names", () => {
    assert.equal(
      isMemoryConsolidateTool("mcp__coder-memory__memory_maintenance"),
      true,
    );
    assert.equal(isMemoryConsolidateTool("memory_supersede"), true);
    assert.equal(isMemoryConsolidateTool("session_record"), true);
  });

  it("refuses memory_delete, shell, files, and thread tools", () => {
    assert.equal(isMemoryConsolidateTool("memory_delete"), false);
    assert.equal(
      isMemoryConsolidateTool("mcp__coder-memory__memory_delete"),
      false,
    );
    assert.equal(isMemoryConsolidateTool("Bash"), false);
    assert.equal(isMemoryConsolidateTool("Read"), false);
    assert.equal(
      isMemoryConsolidateTool("mcp__coder-threads__thread_fork"),
      false,
    );
  });
});

describe("buildConsolidatePrompt", () => {
  const prompt = buildConsolidatePrompt({
    projectPath: "/tmp/solenta",
    now: Date.parse("2026-08-27T15:00:00.000Z"),
    workCap: WORK_CAP,
  });

  it("is self-contained: tools, tombstone rule, cap, distill, dates, run entry", () => {
    assert.match(prompt, /memory_maintenance/);
    assert.match(prompt, /memory_distill/);
    assert.match(prompt, /memory_supersede/);
    assert.match(prompt, /memory_resolve/);
    assert.match(prompt, /invalidate/);
    assert.match(prompt, /noop/);
    assert.match(prompt, /tombstone/);
    assert.match(prompt, /memory_delete/);
    assert.match(prompt, /1500/);
    assert.match(prompt, /type:strategy/);
    assert.match(prompt, /yesterday/);
    assert.match(prompt, /2026-08-27/);
    assert.match(prompt, /last consolidation: X resolved, Y merged/);
    assert.match(prompt, new RegExp(`Cap this pass at ${WORK_CAP}`));
    assert.match(prompt, /\/tmp\/solenta/);
    assert.match(prompt, /coder-memory/);
  });
});

describe("consolidation scheduler", () => {
  let tmpDir;
  let store;
  let repo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-memc-"));
    repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: repo },
    ]);
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function sched(opts = {}) {
    const started = [];
    const runner = {
      startRun: async (input) => {
        started.push(input);
        return { runId: "r1" };
      },
    };
    const broadcasts = [];
    const handle = startMemoryConsolidateScheduler({
      store,
      runner,
      broadcast: (ch, payload) => broadcasts.push([ch, payload]),
      intervalMs: 60 * 60 * 1000,
      now: () => opts.now || Date.now(),
      maintenance:
        opts.maintenance ||
        (async () => ({ queue: { open: opts.open == null ? 5 : opts.open } })),
      resolveProvider: () => ({ provider: "claude", model: null }),
    });
    return { handle, started, broadcasts };
  }

  it("tick fires when both gates pass and stamps lastRunAt", async () => {
    const { handle, started } = sched({ open: 5 });
    try {
      await handle.tick();
    } finally {
      handle.stop();
    }
    assert.equal(started.length, 1);
    assert.match(started[0].prompt, /memory_maintenance/);
    const thread = store.getThreads()[0];
    assert.ok(thread);
    assert.equal(thread.title, TITLE);
    assert.equal(thread.memoryConsolidate, true);
    assert.equal(thread.provider, "claude");
    assert.equal(started[0].threadId, thread.id);
    const project = store.getProjects()[0];
    assert.ok(project.memoryConsolidateAt);
    assert.equal(project.memoryConsolidateError, null);
  });

  it("tick skips when the queue is too shallow", async () => {
    const { handle, started } = sched({ open: 4 });
    try {
      await handle.tick();
    } finally {
      handle.stop();
    }
    assert.equal(started.length, 0);
    assert.equal(store.getThreads().length, 0);
  });

  it("tick skips inside the 24h window even with a deep queue", async () => {
    const now = Date.now();
    store.setProjects([
      {
        ...store.getProjects()[0],
        memoryConsolidateAt: now - 60_000,
      },
    ]);
    store.saveNow();
    const { handle, started } = sched({ open: 20, now });
    try {
      await handle.tick();
    } finally {
      handle.stop();
    }
    assert.equal(started.length, 0);
  });

  it("skips ssh remotes", async () => {
    store.setProjects([
      {
        id: "p1",
        slug: "acme/app",
        name: "app",
        path: repo,
        remoteHost: "user@host",
        remotePath: "/src/app",
      },
    ]);
    store.saveNow();
    const { handle, started } = sched({ open: 9 });
    try {
      await handle.tick();
    } finally {
      handle.stop();
    }
    assert.equal(started.length, 0);
  });

  it("skips when a consolidation thread is already working", async () => {
    services.createThread(store, {
      projectId: "p1",
      title: TITLE,
      memoryConsolidate: true,
    });
    store.updateThread(store.getThreads()[0].id, { status: "working" });
    const { handle, started } = sched({ open: 9 });
    try {
      await handle.tick();
    } finally {
      handle.stop();
    }
    assert.equal(started.length, 0);
    assert.equal(store.getThreads().length, 1);
  });

  it("runNow bypasses the gate and records lastError on startRun failure", async () => {
    const handle = startMemoryConsolidateScheduler({
      store,
      runner: {
        startRun: async () => {
          throw new Error("no claude");
        },
      },
      intervalMs: 60 * 60 * 1000,
      maintenance: async () => ({ queue: { open: 0 } }),
      resolveProvider: () => ({ provider: "claude", model: null }),
    });
    try {
      await assert.rejects(() => handle.runNow("p1"), /no claude/);
    } finally {
      handle.stop();
    }
    const project = store.getProjects()[0];
    assert.ok(project.memoryConsolidateAt);
    assert.match(String(project.memoryConsolidateError), /no claude/);
    const thread = store.getThreads()[0];
    assert.equal(thread.memoryConsolidate, true);
  });

  it("does not mint a worktree (pendingWorktree stays off)", async () => {
    const thread = await fireConsolidate(
      {
        store,
        runner: { startRun: async () => ({ runId: "r" }) },
        maintenance: async () => ({ queue: { open: 5 } }),
        resolveProvider: () => ({ provider: "claude", model: null }),
      },
      store.getProjects()[0],
      Date.now(),
    );
    assert.ok(thread);
    assert.equal(thread.pendingWorktree, undefined);
    assert.equal(thread.worktreePath, null);
  });
});

describe("pruneConsolidateThreads", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-memc-prune-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: tmpDir },
    ]);
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drops the oldest finished passes past the cap, keeps a live one", () => {
    const ids = [];
    for (let i = 0; i < MAX_THREADS_PER_PROJECT + 3; i++) {
      const t = services.createThread(store, {
        projectId: "p1",
        title: `pass ${i}`,
        memoryConsolidate: true,
      });
      ids.push(t.id);
      store.updateThread(t.id, {
        createdAt: 1000 + i,
        status: i === 0 ? "working" : "done",
      });
    }
    pruneConsolidateThreads(store, "p1");
    const left = store
      .getThreads()
      .filter((t) => t.memoryConsolidate)
      .map((t) => t.id);
    assert.equal(left.includes(ids[0]), true, "working thread kept");
    assert.ok(left.length <= MAX_THREADS_PER_PROJECT + 1);
    assert.equal(left.includes(ids[1]), false);
  });
});
