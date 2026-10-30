"use strict";

/**
 * Opt-in idle-thread compaction (#1765).
 *
 * The scheduler reuses the exact "Compact first" chip mechanism (a bare
 * `/compact` turn, electron/compaction.js) via runner.startRun, so these
 * tests stub startRun rather than spinning up a real provider CLI; the
 * `/compact` dispatch itself is covered by electron/test/compaction*.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  createIdleCompactScheduler,
  isIdleCompactCandidate,
  IDLE_COMPACT_MIN_TOKENS,
  IDLE_COMPACT_NOTE,
} = require("../idleCompact.js");

describe("idle Claude thread compaction (#1765)", () => {
  let tmpDir;
  let store;
  let project;
  let now;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-idle-compact-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([{ id: "p1", slug: "acme/app", name: "app", path: tmpDir }]);
    project = store.getProject("p1");
    now = Date.now();
    services.setSettings(store, { idleCompactClaudeThreads: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeThread(patch = {}) {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Big refactor",
    });
    store.updateThread(thread.id, {
      provider: "claude",
      sessionId: "sess-1",
      status: "idle",
      updatedAt: now - 55 * 60 * 1000,
      ...patch,
    });
    store.setUsage(thread.id, {
      model: "claude-opus",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 1,
      contextTokens: IDLE_COMPACT_MIN_TOKENS,
    });
    return store.getThread(thread.id);
  }

  function makeScheduler(extra = {}) {
    const calls = [];
    const broadcasts = [];
    const runner = {
      startRun: async (input) => {
        calls.push(input);
        return { runId: "r1" };
      },
    };
    const sched = createIdleCompactScheduler({
      store,
      runner,
      broadcast: (ch, payload) => broadcasts.push([ch, payload]),
      now: () => now,
      ...extra,
    });
    return { sched, calls, broadcasts };
  }

  it("fires exactly once inside the 50-58 minute window, with a quiet note", async () => {
    const thread = makeThread();
    const { sched, calls, broadcasts } = makeScheduler();
    const result = await sched.trigger();
    assert.equal(result.compacted, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      threadId: thread.id,
      prompt: "/compact",
      fromIdleCompact: true,
    });
    const updated = store.getThread(thread.id);
    assert.ok(updated.idleCompactedAt != null, "thread is claimed");
    const note = store
      .getMessages(thread.id)
      .find((m) => m.role === "event" && m.text === IDLE_COMPACT_NOTE);
    assert.ok(note, "quiet note appended");
    assert.ok(broadcasts.some(([ch]) => ch === "threads:changed"));
  });

  it("does not fire before the window (idle 49 minutes)", async () => {
    makeThread({ updatedAt: now - 49 * 60 * 1000 });
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 0);
  });

  it("does not fire after the window either (idle 61 minutes; the chip owns that)", async () => {
    makeThread({ updatedAt: now - 61 * 60 * 1000 });
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 0);
  });

  it("does not fire twice for the same idle window", async () => {
    makeThread();
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 1);
    await sched.trigger();
    assert.equal(calls.length, 1, "second tick in the same window is a no-op");
  });

  it("does not fire when the setting is off", async () => {
    services.setSettings(store, { idleCompactClaudeThreads: false });
    makeThread();
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 0);
  });

  it("does not fire for a non-Claude thread", async () => {
    makeThread({ provider: "codex" });
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 0);
  });

  it("does not fire under the token threshold", async () => {
    const thread = makeThread();
    store.setUsage(thread.id, {
      model: "claude-opus",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 1,
      contextTokens: IDLE_COMPACT_MIN_TOKENS - 1,
    });
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 0);
  });

  it("skips a working, quota-wait, archived, trashed, snoozed, or settled thread", async () => {
    const perStatusPatches = [
      { status: "working" },
      { status: "quota-wait" },
      { archived: true },
      { trashedAt: now },
      { snoozedUntil: now + 10_000 },
      { settledOverride: "settled" },
    ];
    for (const patch of perStatusPatches) {
      makeThread(patch);
    }
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 0, JSON.stringify(perStatusPatches));
  });

  it("skips entirely while the daily budget is already spent (global pause)", async () => {
    services.setSettings(store, { dailyBudgetUsd: 1 });
    store.recordSpend(5);
    makeThread();
    const { sched, calls } = makeScheduler();
    await sched.trigger();
    assert.equal(calls.length, 0);
  });

  it("isIdleCompactCandidate matches the scheduler's own filter at the boundaries", () => {
    const thread = makeThread();
    assert.equal(
      isIdleCompactCandidate(thread, IDLE_COMPACT_MIN_TOKENS, now),
      true,
    );
    assert.equal(
      isIdleCompactCandidate(thread, IDLE_COMPACT_MIN_TOKENS - 1, now),
      false,
    );
    assert.equal(isIdleCompactCandidate(thread, null, now), false);
    assert.equal(isIdleCompactCandidate(null, IDLE_COMPACT_MIN_TOKENS, now), false);
  });

  it("runs only one compaction at a time (serialized within a tick)", async () => {
    const t1 = makeThread();
    const t2 = makeThread();
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const runner = {
      startRun: async (input) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(input.threadId);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return { runId: "r" };
      },
    };
    const sched = createIdleCompactScheduler({ store, runner, now: () => now });
    await sched.trigger();
    assert.equal(maxConcurrent, 1, "never two compactions running at once");
    assert.deepEqual(order.sort(), [t1.id, t2.id].sort());
  });

  it("start() installs one unref'd interval ticking trigger; stop() clears it", () => {
    const intervals = [];
    const cleared = [];
    const setIntervalFn = (fn, ms) => {
      const handle = { fn, ms, unrefCount: 0, unref() { this.unrefCount += 1; } };
      intervals.push(handle);
      return handle;
    };
    const clearIntervalFn = (handle) => cleared.push(handle);
    const sched = createIdleCompactScheduler({
      store,
      runner: { startRun: async () => ({ runId: "r1" }) },
      now: () => now,
      intervalMs: 60_000,
      setIntervalFn,
      clearIntervalFn,
    });
    sched.start();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 60_000);
    assert.equal(intervals[0].unrefCount, 1, "interval is unref'd");
    sched.stop();
    assert.deepEqual(cleared, [intervals[0]]);
  });
});
