"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  startAutoDispatch,
  MAX_AUTO_DISPATCH_RUNNING,
} = require("../autodispatch.js");

const ISSUES_PATH = require.resolve("../issues.js");
const realIssues = require("../issues.js");

const TODO_ISSUE = {
  number: 165,
  title: "Auto-dispatch threads",
  url: "https://github.com/currentbits/solenta/issues/165",
  state: "OPEN",
  labels: ["plan:todo"],
  updatedAt: "2026-08-17T00:00:00Z",
};

const FETCHED = {
  number: 165,
  title: "Auto-dispatch threads",
  body: "poll plan:todo and start a thread",
  url: "https://github.com/currentbits/solenta/issues/165",
};

function installIssuesMock(impl) {
  require.cache[ISSUES_PATH].exports = {
    listIssues: async () => ({ ok: true, issues: [] }),
    fetchIssue: async () => ({ ok: false, reason: "unmocked" }),
    setPlanStatus: async () => ({ ok: true }),
    ...impl,
  };
}

describe("auto-dispatch", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-autodispatch-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      {
        id: "p1",
        slug: "acme/app",
        name: "app",
        path: tmpDir,
        autoDispatch: true,
      },
    ]);
    store.saveNow();
  });

  afterEach(() => {
    require.cache[ISSUES_PATH].exports = realIssues;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function start(runner, extra = {}) {
    const broadcasts = [];
    const sched = startAutoDispatch({
      store,
      runner,
      broadcast: (ch, payload) => broadcasts.push([ch, payload]),
      intervalMs: 60 * 60 * 1000,
      ...extra,
    });
    return { sched, broadcasts };
  }

  it("dispatches an OPEN plan:todo issue: thread, run, label move", async () => {
    const listed = [];
    const fetched = [];
    const moved = [];
    installIssuesMock({
      listIssues: async (projectPath) => {
        listed.push(projectPath);
        return { ok: true, issues: [TODO_ISSUE] };
      },
      fetchIssue: async (projectPath, ref) => {
        fetched.push([projectPath, ref]);
        return { ok: true, issue: FETCHED };
      },
      setPlanStatus: async (projectPath, number, status) => {
        moved.push([projectPath, number, status]);
        return { ok: true };
      },
    });

    const started = [];
    const { sched, broadcasts } = start({
      startRun: async (input) => {
        started.push(input);
        return { runId: "r1" };
      },
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }

    assert.deepEqual(listed, [tmpDir]);
    assert.deepEqual(fetched, [[tmpDir, "165"]]);
    assert.equal(started.length, 1);
    assert.equal(
      started[0].prompt,
      "GitHub issue #165: Auto-dispatch threads\nhttps://github.com/currentbits/solenta/issues/165\n\npoll plan:todo and start a thread",
    );
    const thread = store.getThreads()[0];
    assert.ok(thread);
    assert.equal(thread.title, "Auto-dispatch threads");
    assert.equal(thread.projectId, "p1");
    assert.equal(thread.pendingWorktree, true);
    assert.equal(started[0].threadId, thread.id);
    assert.deepEqual(moved, [[tmpDir, 165, "doing"]]);
    assert.ok(broadcasts.some((b) => b[0] === "threads:changed"));
    const changed = broadcasts.find((b) => b[0] === "threads:changed");
    assert.ok(changed[1].some((t) => t.id === thread.id));
  });

  it("skips a project without autoDispatch === true", async () => {
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: tmpDir },
    ]);
    store.saveNow();

    let listed = 0;
    installIssuesMock({
      listIssues: async () => {
        listed += 1;
        return { ok: true, issues: [TODO_ISSUE] };
      },
    });

    const started = [];
    const { sched } = start({
      startRun: async (input) => {
        started.push(input);
        return { runId: "r1" };
      },
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }

    assert.equal(listed, 0);
    assert.equal(started.length, 0);
    assert.equal(store.getThreads().length, 0);
  });

  it("dispatches a still-todo issue only once across ticks", async () => {
    installIssuesMock({
      listIssues: async () => ({ ok: true, issues: [TODO_ISSUE] }),
      fetchIssue: async () => ({ ok: true, issue: FETCHED }),
      setPlanStatus: async () => ({ ok: true }),
    });

    const started = [];
    const { sched } = start({
      startRun: async (input) => {
        started.push(input);
        return { runId: "r1" };
      },
    });
    try {
      await sched.tick();
      await sched.tick();
    } finally {
      sched.stop();
    }

    assert.equal(started.length, 1);
    assert.equal(store.getThreads().length, 1);
  });

  it("does not dispatch when MAX working threads are already running", async () => {
    for (let i = 0; i < MAX_AUTO_DISPATCH_RUNNING; i++) {
      const thread = services.createThread(store, {
        projectId: "p1",
        title: `busy ${i}`,
      });
      store.updateThread(thread.id, { status: "working" });
    }
    store.saveNow();

    let listed = 0;
    installIssuesMock({
      listIssues: async () => {
        listed += 1;
        return { ok: true, issues: [TODO_ISSUE] };
      },
    });

    const started = [];
    const { sched } = start({
      startRun: async (input) => {
        started.push(input);
        return { runId: "r1" };
      },
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }

    assert.equal(listed, 0);
    assert.equal(started.length, 0);
    assert.equal(store.getThreads().length, MAX_AUTO_DISPATCH_RUNNING);
  });
});
