"use strict";

/**
 * Periodic worktree retention sweep (#641).
 *
 * enforceRetention used to run only at boot (+15 s) and on archive/merge.
 * Grace-period crossings during a multi-day uptime were never reclaimed.
 * The sweeper is the same shape as createPrStateRefresher: unref'd
 * startup + interval, overlap latch, injectable timers.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const {
  createRetentionSweeper,
  RETENTION_SWEEP_INTERVAL_MS,
  RETENTION_SWEEP_STARTUP_MS,
} = require("../worktrees.js");

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

describe("createRetentionSweeper (#641)", () => {
  it("defaults to a 6h interval and 15s startup", () => {
    assert.equal(RETENTION_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000);
    assert.equal(RETENTION_SWEEP_STARTUP_MS, 15_000);
  });

  it("start schedules unref'd startup + interval (injectable timers)", async () => {
    const timers = fakeTimers();
    let calls = 0;
    const seen = [];
    const store = { getProjects: () => [] };
    const worktreeBase = "/tmp/worktrees";
    const broadcast = () => {};

    const sweeper = createRetentionSweeper({
      store,
      worktreeBase,
      broadcast,
      ...timers,
      sweepFn: async (opts) => {
        calls += 1;
        seen.push(opts);
        return { removed: [], failed: [], bytes: 0 };
      },
    });

    sweeper.start();
    assert.equal(timers.timeouts.length, 1);
    assert.equal(timers.timeouts[0].ms, RETENTION_SWEEP_STARTUP_MS);
    assert.equal(timers.timeouts[0].unrefCount, 1);
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, RETENTION_SWEEP_INTERVAL_MS);
    assert.equal(timers.intervals[0].unrefCount, 1);

    await timers.timeouts[0].fn();
    assert.equal(calls, 1);
    assert.equal(seen[0].store, store);
    assert.equal(seen[0].worktreeBase, worktreeBase);
    assert.equal(seen[0].broadcast, broadcast);

    await timers.intervals[0].fn();
    assert.equal(calls, 2);

    sweeper.stop();
  });

  it("start is a no-op when already started", () => {
    const timers = fakeTimers();
    const sweeper = createRetentionSweeper({
      store: { getProjects: () => [] },
      worktreeBase: "/tmp/worktrees",
      ...timers,
      sweepFn: async () => ({ removed: [], failed: [], bytes: 0 }),
    });
    sweeper.start();
    sweeper.start();
    assert.equal(timers.timeouts.length, 1);
    assert.equal(timers.intervals.length, 1);
    sweeper.stop();
  });

  it("overlap latch: second trigger during a pass is a no-op", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let entered = 0;
    const sweeper = createRetentionSweeper({
      store: { getProjects: () => [] },
      worktreeBase: "/tmp/worktrees",
      intervalMs: 60_000,
      startupDelayMs: 60_000,
      sweepFn: async () => {
        entered += 1;
        await gate;
        return { removed: ["a"], failed: [], bytes: 1 };
      },
    });

    const first = sweeper.trigger();
    await new Promise((r) => setImmediate(r));
    assert.equal(sweeper.isRunning(), true);
    const second = await sweeper.trigger();
    assert.equal(second.ran, false, "latched pass must no-op the second trigger");
    assert.equal(entered, 1);

    release();
    const firstResult = await first;
    assert.equal(firstResult.ran, true);
    assert.deepEqual(firstResult.result, {
      removed: ["a"],
      failed: [],
      bytes: 1,
    });
    assert.equal(entered, 1);

    const third = await sweeper.trigger();
    assert.equal(third.ran, true);
    assert.equal(entered, 2);

    sweeper.stop();
  });

  it("latch clears after a throwing pass", async () => {
    let passes = 0;
    const sweeper = createRetentionSweeper({
      store: { getProjects: () => [] },
      worktreeBase: "/tmp/worktrees",
      intervalMs: 60_000,
      startupDelayMs: 60_000,
      sweepFn: async () => {
        passes += 1;
        throw new Error("forced retention pass failure");
      },
    });

    const first = await sweeper.trigger();
    assert.equal(first.ran, true, "throwing pass still resolves the trigger");
    assert.equal(first.result, null);
    assert.equal(sweeper.isRunning(), false);
    assert.equal(passes, 1);

    const second = await sweeper.trigger();
    assert.equal(second.ran, true, "next trigger must run (not stay latched)");
    assert.equal(passes, 2);
    assert.equal(sweeper.isRunning(), false);

    sweeper.stop();
  });

  it("stop clears both timers", () => {
    const timers = fakeTimers();
    const sweeper = createRetentionSweeper({
      store: { getProjects: () => [] },
      worktreeBase: "/tmp/worktrees",
      ...timers,
      sweepFn: async () => ({ removed: [], failed: [], bytes: 0 }),
    });
    sweeper.start();
    sweeper.stop();
    assert.equal(timers.clearedTimeouts.length, 1);
    assert.equal(timers.clearedTimeouts[0], timers.timeouts[0]);
    assert.equal(timers.clearedIntervals.length, 1);
    assert.equal(timers.clearedIntervals[0], timers.intervals[0]);
  });

  it("default sweepFn is scheduleRetention (cheap no-op with empty store)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-retsweep-"));
    try {
      const store = new Store(path.join(tmp, "store.json"));
      const sweeper = createRetentionSweeper({
        store,
        worktreeBase: path.join(tmp, "worktrees"),
        broadcast: () => {},
        intervalMs: 60_000,
        startupDelayMs: 60_000,
      });
      const result = await sweeper.trigger();
      assert.equal(result.ran, true);
      assert.deepEqual(result.result, { removed: [], failed: [], bytes: 0 });
      sweeper.stop();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("default sweepFn swallows errors like scheduleRetention", async () => {
    // enforceRetention would throw; scheduleRetention returns the empty
    // result. A hung latch after a throw is the other test; this pins the
    // production default so an interval tick cannot reject.
    const sweeper = createRetentionSweeper({
      store: {
        getProjects() {
          throw new Error("boom");
        },
      },
      worktreeBase: "/tmp/worktrees",
      intervalMs: 60_000,
      startupDelayMs: 60_000,
    });
    const result = await sweeper.trigger();
    assert.equal(result.ran, true);
    assert.deepEqual(result.result, { removed: [], failed: [], bytes: 0 });
    sweeper.stop();
  });
});

describe("main.js retention sweeper wiring (#641)", () => {
  it("starts createRetentionSweeper at 6h and stops it on shutdown", () => {
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.match(main, /createRetentionSweeper/);
    assert.match(main, /retentionSweeper\.start\(\)/);
    assert.match(main, /retentionSweeper\.stop\(\)/);
    assert.match(main, /6 \* 60 \* 60 \* 1000/);
    assert.match(main, /sweepOrphanWorktrees/);
    // Boot timeout is orphan-only; the sweeper owns enforceRetention.
    const bootSweep = main.slice(
      main.indexOf("const sweepTimer"),
      main.indexOf("sweepTimer.unref()"),
    );
    assert.match(bootSweep, /sweepOrphanWorktrees/);
    assert.doesNotMatch(bootSweep, /enforceRetention/);
  });
});
