"use strict";

/**
 * #346 wedged-lane watchdog.
 *
 * Recycle is already in mergeQueue.js; this suite covers the two missing
 * beats: heartbeatLane from the runner while a lane thread is active, and
 * a main-process interval that calls recycleWedgedLanes for each project.
 * Timers and "now" are injected — a boot timer that only recycles would
 * kill live lanes after 30 minutes.
 *
 * Run: node --test electron/test/merge-queue-watchdog.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const issues = require("../issues.js");
const { createRunner } = require("../runner.js");
const {
  createWedgedLaneWatchdog,
  DEFAULT_WEDGE_MS,
  WEDGE_WATCHDOG_INTERVAL_MS,
  WEDGE_WATCHDOG_STARTUP_MS,
} = require("../mergeQueue.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const stubCore = {
  createWorkflow() {
    return { id: "wf" };
  },
  tick(workflow) {
    return workflow;
  },
  isComplete() {
    return false;
  },
  isFailed() {
    return false;
  },
  isStuck() {
    return false;
  },
};

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  return {
    timeouts,
    intervals,
    clearedTimeouts,
    clearedIntervals,
    setTimeoutFn: (fn, ms) => {
      const handle = {
        ms,
        fn,
        unrefCount: 0,
        unref() {
          this.unrefCount += 1;
        },
      };
      timeouts.push(handle);
      return handle;
    },
    setIntervalFn: (fn, ms) => {
      const handle = {
        ms,
        fn,
        unrefCount: 0,
        unref() {
          this.unrefCount += 1;
        },
      };
      intervals.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      clearedTimeouts.push(handle);
    },
    clearIntervalFn: (handle) => {
      clearedIntervals.push(handle);
    },
  };
}

describe("createWedgedLaneWatchdog (#346)", () => {
  it("defaults to a 30-minute interval and 15s startup", () => {
    assert.equal(DEFAULT_WEDGE_MS, 30 * 60 * 1000);
    assert.equal(WEDGE_WATCHDOG_INTERVAL_MS, DEFAULT_WEDGE_MS);
    assert.equal(WEDGE_WATCHDOG_STARTUP_MS, 15_000);
  });

  it("start schedules unref'd startup + interval (injectable timers)", async () => {
    const timers = fakeTimers();
    const seen = [];
    const store = { getProjects: () => [{ id: "p1" }, { id: "p2" }] };

    const watchdog = createWedgedLaneWatchdog({
      store,
      now: () => 99_000,
      ...timers,
      recycleFn: (opts) => {
        seen.push(opts);
        return [];
      },
    });

    watchdog.start();
    assert.equal(timers.timeouts.length, 1);
    assert.equal(timers.timeouts[0].ms, WEDGE_WATCHDOG_STARTUP_MS);
    assert.equal(timers.timeouts[0].unrefCount, 1);
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, WEDGE_WATCHDOG_INTERVAL_MS);
    assert.equal(timers.intervals[0].unrefCount, 1);

    await timers.timeouts[0].fn();
    assert.equal(seen.length, 2);
    assert.deepEqual(
      seen.map((s) => s.projectId),
      ["p1", "p2"],
    );
    assert.equal(seen[0].now, 99_000);
    assert.equal(seen[1].now, 99_000);
    assert.equal(seen[0].store, store);
    assert.equal(seen[0].wedgeMs, DEFAULT_WEDGE_MS);

    seen.length = 0;
    await timers.intervals[0].fn();
    assert.equal(seen.length, 2);

    watchdog.stop();
    assert.equal(timers.clearedTimeouts.length, 0);
    assert.equal(timers.clearedIntervals.length, 1);
  });

  it("start is a no-op when already started", () => {
    const timers = fakeTimers();
    const watchdog = createWedgedLaneWatchdog({
      store: { getProjects: () => [] },
      ...timers,
      recycleFn: () => [],
    });
    watchdog.start();
    watchdog.start();
    assert.equal(timers.timeouts.length, 1);
    assert.equal(timers.intervals.length, 1);
    watchdog.stop();
  });

  it("stop clears both timers", () => {
    const timers = fakeTimers();
    const watchdog = createWedgedLaneWatchdog({
      store: { getProjects: () => [] },
      ...timers,
      recycleFn: () => [],
    });
    watchdog.start();
    watchdog.stop();
    assert.equal(timers.clearedTimeouts.length, 1);
    assert.equal(timers.clearedIntervals.length, 1);
    watchdog.start();
    assert.equal(timers.timeouts.length, 2);
    assert.equal(timers.intervals.length, 2);
    watchdog.stop();
  });

  it("recycles a wedged lane per project and leaves a beating lane alone", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wedge-wd-"));
    const store = new Store(path.join(tmpDir, "store.json"));
    const origComplete = issues.completeIssue;
    const closed = [];
    issues.completeIssue = async (projectPath, number) => {
      closed.push({ projectPath, number });
      return { ok: true };
    };

    try {
      const projectA = {
        id: "proj-a",
        path: path.join(tmpDir, "a"),
        name: "A",
      };
      const projectB = {
        id: "proj-b",
        path: path.join(tmpDir, "b"),
        name: "B",
      };
      fs.mkdirSync(projectA.path);
      fs.mkdirSync(projectB.path);
      store.setProjects([projectA, projectB]);

      const live = services.createThread(store, {
        projectId: projectA.id,
        title: "Live",
      });
      const wedged = services.createThread(store, {
        projectId: projectA.id,
        title: "Wedged",
      });
      const other = services.createThread(store, {
        projectId: projectB.id,
        title: "Other wedged",
      });
      store.updateThread(live.id, {
        issueNumber: 10,
        lane: { n: 1, port: 3001, claimedAt: 0, lastBeat: 50_000 },
      });
      store.updateThread(wedged.id, {
        issueNumber: 11,
        lane: { n: 2, port: 3002, claimedAt: 0, lastBeat: 0 },
      });
      store.updateThread(other.id, {
        issueNumber: 12,
        lane: { n: 1, port: 3001, claimedAt: 0, lastBeat: 0 },
      });
      store.save();

      const timers = fakeTimers();
      const watchdog = createWedgedLaneWatchdog({
        store,
        now: () => DEFAULT_WEDGE_MS + 1,
        ...timers,
      });
      watchdog.start();
      timers.intervals[0].fn();

      assert.equal(store.getThread(live.id).lane.n, 1);
      assert.equal(store.getThread(wedged.id).lane, undefined);
      assert.equal(store.getThread(other.id).lane, undefined);
      assert.deepEqual(closed, []);
      watchdog.stop();
    } finally {
      issues.completeIssue = origComplete;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("swallows recycle errors so one project cannot stop the tick", async () => {
    const timers = fakeTimers();
    const seen = [];
    const watchdog = createWedgedLaneWatchdog({
      store: { getProjects: () => [{ id: "bad" }, { id: "ok" }] },
      now: () => 1,
      ...timers,
      recycleFn: (opts) => {
        seen.push(opts.projectId);
        if (opts.projectId === "bad") throw new Error("boom");
        return [];
      },
    });
    watchdog.start();
    await timers.intervals[0].fn();
    assert.deepEqual(seen, ["bad", "ok"]);
    watchdog.stop();
  });
});

describe("runner lane heartbeat (#346)", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e process.exit(0)`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-lane-beat-"));
    store = new Store(path.join(tmpDir, "store.json"));

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "Lane thread",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("beats a claimed lane while the run is active, not after stop", async () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, {
      lane: { n: 1, port: 3001, claimedAt: 0, lastBeat: 0 },
    });
    store.save();

    runner = createRunner({
      store,
      core: stubCore,
      pushFn: () => {},
      tickMs: 15,
      now: () => 1_000,
      runAgentFn: () => ({ kill() {} }),
    });

    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    assert.equal(
      store.getThread(thread.id).lane.lastBeat,
      1_000,
      "startRun must heartbeat a claimed lane",
    );

    runner.heartbeatActiveLanes({ now: 5_000 });
    assert.equal(store.getThread(thread.id).lane.lastBeat, 5_000);

    await runner.stopRun({ threadId: thread.id });
    runner.heartbeatActiveLanes({ now: 9_000 });
    assert.equal(
      store.getThread(thread.id).lane.lastBeat,
      5_000,
      "stopped runs must not keep the lane alive",
    );
  });

  it("does not heartbeat a thread without a lane", async () => {
    const thread = store.getThreads()[0];
    runner = createRunner({
      store,
      core: stubCore,
      pushFn: () => {},
      tickMs: 15,
      now: () => 1_000,
      runAgentFn: () => ({ kill() {} }),
    });

    await runner.startRun({ threadId: thread.id, prompt: "plain" });
    runner.heartbeatActiveLanes({ now: 2_000 });
    assert.equal(store.getThread(thread.id).lane, undefined);
    await runner.stopRun({ threadId: thread.id });
  });
});

describe("main.js wedged-lane watchdog wiring (#346)", () => {
  it("starts createWedgedLaneWatchdog and stops it on shutdown", () => {
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.match(main, /createWedgedLaneWatchdog/);
    assert.match(main, /wedgedLaneWatchdog\.start\(\)/);
    assert.match(main, /wedgedLaneWatchdog\.stop\(\)/);
  });
});
