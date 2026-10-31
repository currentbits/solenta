"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  nextFire,
  dueAutomations,
  startScheduler,
  runNow,
  listAutomationRuns,
  MAX_THREADS_PER_AUTOMATION,
  STAGE_MS,
  ONCE_GRACE_MS,
  graduatedStage,
  buildRunPrompt,
} = require("../automations.js");

function at(y, m, d, h, min = 0, s = 0, ms = 0) {
  return new Date(y, m, d, h, min, s, ms).getTime();
}

describe("nextFire", () => {
  it("hourly: next top of hour after a mid-hour time", () => {
    const from = at(2026, 5, 10, 10, 30, 15);
    assert.equal(nextFire("hourly", null, from), at(2026, 5, 10, 11, 0, 0));
  });

  it("hourly: exact hour goes to the next hour", () => {
    const from = at(2026, 5, 10, 10, 0, 0);
    assert.equal(nextFire("hourly", null, from), at(2026, 5, 10, 11, 0, 0));
  });

  it("hourly: wraps midnight", () => {
    const from = at(2026, 5, 10, 23, 30, 0);
    assert.equal(nextFire("hourly", null, from), at(2026, 5, 11, 0, 0, 0));
  });

  it("daily: before the hour fires today", () => {
    const from = at(2026, 5, 10, 8, 0, 0);
    assert.equal(nextFire("daily", 9, from), at(2026, 5, 10, 9, 0, 0));
  });

  it("daily: at or after the hour wraps to tomorrow", () => {
    const from = at(2026, 5, 10, 9, 0, 0);
    assert.equal(nextFire("daily", 9, from), at(2026, 5, 11, 9, 0, 0));
    assert.equal(
      nextFire("daily", 9, at(2026, 5, 10, 10, 0, 0)),
      at(2026, 5, 11, 9, 0, 0),
    );
  });

  it("daily: wraps the month", () => {
    const from = at(2026, 5, 30, 22, 0, 0);
    assert.equal(nextFire("daily", 9, from), at(2026, 6, 1, 9, 0, 0));
  });

  it("weekly: before the hour fires same weekday", () => {
    // 2026-06-08 is a Monday.
    const from = at(2026, 5, 8, 8, 0, 0);
    assert.equal(nextFire("weekly", 9, from), at(2026, 5, 8, 9, 0, 0));
    assert.equal(new Date(from).getDay(), 1);
  });

  it("weekly: at or after the hour wraps seven days", () => {
    const from = at(2026, 5, 8, 9, 0, 0);
    assert.equal(nextFire("weekly", 9, from), at(2026, 5, 15, 9, 0, 0));
    assert.equal(new Date(from).getDay(), 1);
    assert.equal(new Date(at(2026, 5, 15, 9, 0, 0)).getDay(), 1);
  });

  it("weekly: wraps across a month", () => {
    // 2026-06-29 is a Monday.
    const from = at(2026, 5, 29, 10, 0, 0);
    assert.equal(nextFire("weekly", 9, from), at(2026, 6, 6, 9, 0, 0));
    assert.equal(new Date(from).getDay(), 1);
    assert.equal(new Date(at(2026, 6, 6, 9, 0, 0)).getDay(), 1);
  });

  it("weekly: anchor keeps the scheduled weekday on a later catch-up (#931)", () => {
    const monday = at(2026, 5, 8, 9, 0, 0);
    // Tuesday catch-up: next Monday, not next Tuesday.
    assert.equal(
      nextFire("weekly", 9, at(2026, 5, 9, 10, 0, 0), monday),
      at(2026, 5, 15, 9, 0, 0),
    );
    // Three weeks offline: skips the backlog to the next Monday.
    assert.equal(
      nextFire("weekly", 9, at(2026, 5, 30, 12, 0, 0), monday),
      at(2026, 6, 6, 9, 0, 0),
    );
    // Run by hand on Wednesday before the slot: the Monday slot stands.
    assert.equal(
      nextFire("weekly", 9, at(2026, 5, 3, 12, 0, 0), monday),
      monday,
    );
  });

  it("weekly: anchored slots keep the local hour across DST", () => {
    // Spans the US (Mar 8) and EU (Mar 29) spring-forward and the
    // Oct 25 / Nov 1 fall-back; whatever TZ the suite runs in.
    let slot = at(2026, 1, 2, 9, 0, 0); // Monday
    for (let i = 0; i < 45; i++) {
      slot = nextFire("weekly", 9, slot + 3_600_000, slot);
      const d = new Date(slot);
      assert.equal(d.getDay(), 1);
      assert.equal(d.getHours(), 9);
      assert.equal(d.getMinutes(), 0);
    }
  });
});

describe("dueAutomations", () => {
  const now = at(2026, 5, 10, 12, 0, 0);

  it("includes enabled automations at or past nextRunAt", () => {
    const due = dueAutomations(
      [
        { id: "a", enabled: true, nextRunAt: now },
        { id: "b", enabled: true, nextRunAt: now - 1 },
        { id: "c", enabled: true, nextRunAt: now + 1 },
        { id: "d", enabled: false, nextRunAt: now - 1 },
        { id: "e", enabled: true },
      ],
      now,
    );
    assert.deepEqual(
      due.map((a) => a.id),
      ["a", "b"],
    );
  });

  it("returns [] for a missing list", () => {
    assert.deepEqual(dueAutomations(null, now), []);
    assert.deepEqual(dueAutomations(undefined, now), []);
  });
});

describe("calibration lifecycle (#388)", () => {
  const now = at(2026, 5, 10, 12, 0, 0);
  const ready = {
    stage: "observe",
    graduate: true,
    stageSince: now - STAGE_MS,
    lastRunAt: now - 1000,
    consecutiveFailures: 0,
    pendingRunThreadId: null,
  };

  it("graduates one stage once the stage has earned it", () => {
    assert.deepEqual(graduatedStage(ready, now), { stage: "draft", stageSince: now });
    assert.deepEqual(graduatedStage({ ...ready, stage: "draft" }, now), {
      stage: "act",
      stageSince: now,
    });
    assert.equal(graduatedStage({ ...ready, stage: "act" }, now).stage, "act");
  });

  it("holds the stage when time, a run, health, or opt-in is missing", () => {
    const held = (patch) => graduatedStage({ ...ready, ...patch }, now).stage;
    assert.equal(held({ stageSince: now - STAGE_MS + 1 }), "observe");
    assert.equal(held({ lastRunAt: null }), "observe");
    assert.equal(held({ lastRunAt: ready.stageSince - 1 }), "observe");
    assert.equal(held({ consecutiveFailures: 1 }), "observe");
    assert.equal(held({ pendingRunThreadId: "t1" }), "observe");
    assert.equal(held({ graduate: false }), "observe");
  });

  it("starts the clock on a missing stageSince; unknown stages act", () => {
    assert.deepEqual(graduatedStage({ stage: "observe" }, now), {
      stage: "observe",
      stageSince: now,
    });
    assert.equal(graduatedStage({}, now).stage, "act");
  });

  it("only observe and draft add a guardrail to the prompt", () => {
    assert.match(buildRunPrompt({ prompt: "p", stage: "observe" }), /Change nothing/);
    assert.match(buildRunPrompt({ prompt: "p", stage: "draft" }), /gh pr create --draft/);
    assert.doesNotMatch(buildRunPrompt({ prompt: "p", stage: "act" }), /Automation stage/);
  });
});

describe("automation CRUD + scheduler", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: tmpDir },
    ]);
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("add/list/update/remove persist", () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Nightly review",
      prompt: "review the repo",
      provider: "claude",
      model: null,
      preset: "daily",
      hour: 9,
    });
    assert.equal(created.name, "Nightly review");
    assert.equal(created.preset, "daily");
    assert.equal(created.hour, 9);
    assert.equal(created.enabled, true);
    assert.equal(created.lastRunAt, null);
    assert.equal(created.lastError, null);
    assert.ok(created.nextRunAt > Date.now() - 1000);
    assert.equal(services.listAutomations(store).length, 1);

    const updated = services.updateAutomation(store, {
      id: created.id,
      enabled: false,
    });
    assert.equal(updated.enabled, false);
    assert.equal(store.getAutomation(created.id).enabled, false);

    services.removeAutomation(store, { id: created.id });
    assert.equal(services.listAutomations(store).length, 0);
  });

  it("prompt and model updates keep id and nextRunAt", () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Nightly review",
      prompt: "review the repo",
      provider: "claude",
      model: null,
      preset: "daily",
      hour: 9,
    });
    const pinned = created.nextRunAt + 86_400_000;
    store.setAutomations([
      { ...store.getAutomation(created.id), nextRunAt: pinned },
    ]);
    store.saveNow();

    const updated = services.updateAutomation(store, {
      id: created.id,
      prompt: "review harder",
      model: "opus",
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.nextRunAt, pinned);
    assert.equal(updated.prompt, "review harder");
    assert.equal(updated.model, "opus");
    assert.equal(updated.enabled, true);
    assert.equal(updated.projectId, "p1");
    assert.equal(services.listAutomations(store).length, 1);
  });

  it("schedule changes recompute nextRunAt", () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Hourly",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const pinned = Date.now() + 99 * 86_400_000;
    store.setAutomations([
      { ...store.getAutomation(created.id), nextRunAt: pinned },
    ]);
    store.saveNow();

    const updated = services.updateAutomation(store, {
      id: created.id,
      preset: "daily",
      hour: 9,
    });
    assert.equal(updated.id, created.id);
    assert.notEqual(updated.nextRunAt, pinned);
    assert.ok(updated.nextRunAt < pinned);
    assert.equal(updated.preset, "daily");
    assert.equal(updated.hour, 9);
  });

  it("rejects a create without a name or hour", () => {
    assert.throws(
      () =>
        services.addAutomation(store, {
          projectId: "p1",
          name: "  ",
          prompt: "go",
          provider: "claude",
          preset: "hourly",
        }),
      /name is required/i,
    );
    assert.throws(
      () =>
        services.addAutomation(store, {
          projectId: "p1",
          name: "Daily",
          prompt: "go",
          provider: "claude",
          preset: "daily",
          hour: null,
        }),
      /hour is required/i,
    );
  });

  it("tick fires a due automation via createThread + startRun", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Hourly sweep",
      prompt: "do the thing",
      provider: "claude",
      preset: "hourly",
    });
    store.setAutomations([
      { ...store.getAutomation(created.id), nextRunAt: Date.now() - 1000 },
    ]);
    store.saveNow();

    const started = [];
    const runner = {
      startRun: async (input) => {
        started.push(input);
        return { runId: "r1" };
      },
    };
    const broadcasts = [];
    const sched = startScheduler({
      store,
      runner,
      broadcast: (ch, payload) => broadcasts.push([ch, payload]),
      intervalMs: 60 * 60 * 1000,
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }

    assert.equal(started.length, 1);
    // #388: a new automation's first fires are report-only.
    assert.match(
      started[0].prompt,
      /^do the thing\n\n\[Automation stage: observe\][^\n]*\n\n\[Automation memory\]/,
    );
    const thread = store.getThreads()[0];
    assert.ok(thread);
    assert.equal(thread.title, "Hourly sweep");
    assert.equal(thread.provider, "claude");
    assert.equal(thread.automationId, created.id);
    assert.equal(started[0].threadId, thread.id);
    const after = store.getAutomation(created.id);
    assert.ok(after.lastRunAt);
    assert.ok(after.nextRunAt > Date.now());
    assert.equal(after.lastError, null);
    assert.ok(broadcasts.some((b) => b[0] === "threads:changed"));
  });

  it("weekly: Monday-due, Tuesday catch-up stays on Monday (#931)", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Weekly",
      prompt: "go",
      provider: "claude",
      preset: "weekly",
      hour: 9,
    });
    store.setAutomations([
      { ...store.getAutomation(created.id), nextRunAt: at(2026, 5, 8, 9) },
    ]);
    store.saveNow();
    const started = [];
    const sched = startScheduler({
      store,
      runner: { startRun: async (input) => started.push(input) },
      intervalMs: 60 * 60 * 1000,
      now: () => at(2026, 5, 9, 10),
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.equal(started.length, 1);
    assert.equal(store.getAutomation(created.id).nextRunAt, at(2026, 5, 15, 9));
  });

  it("weekly: runNow and hour edits keep the scheduled weekday (#931)", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Weekly",
      prompt: "go",
      provider: "claude",
      preset: "weekly",
      hour: 9,
    });
    // A slot three days of the week away from today, so neither path can
    // pass by landing on today's weekday.
    const d = new Date();
    d.setDate(d.getDate() + 3);
    d.setHours(9, 0, 0, 0);
    const weekday = d.getDay();
    store.setAutomations([
      { ...store.getAutomation(created.id), nextRunAt: d.getTime() },
    ]);
    store.saveNow();
    await runNow({ store, runner: { startRun: async () => ({}) } }, created.id);
    assert.equal(store.getAutomation(created.id).nextRunAt, d.getTime());

    const updated = services.updateAutomation(store, { id: created.id, hour: 14 });
    assert.equal(new Date(updated.nextRunAt).getDay(), weekday);
    assert.equal(new Date(updated.nextRunAt).getHours(), 14);
  });

  it("runNow fires immediately and advances nextRunAt", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Now",
      prompt: "run me",
      provider: "claude",
      preset: "hourly",
    });
    const beforeNext = store.getAutomation(created.id).nextRunAt;
    const started = [];
    await runNow(
      {
        store,
        runner: {
          startRun: async (input) => {
            started.push(input);
            return { runId: "r2" };
          },
        },
      },
      created.id,
    );
    assert.equal(started.length, 1);
    const after = store.getAutomation(created.id);
    assert.ok(after.lastRunAt);
    assert.ok(after.nextRunAt >= beforeNext);
  });

  it("records lastError when startRun fails", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Boom",
      prompt: "nope",
      provider: "claude",
      preset: "hourly",
    });
    await assert.rejects(
      () =>
        runNow(
          {
            store,
            runner: {
              startRun: async () => {
                throw new Error("CLI missing");
              },
            },
          },
          created.id,
        ),
      /CLI missing/,
    );
    const after = store.getAutomation(created.id);
    assert.equal(after.lastError, "CLI missing");
    assert.ok(after.lastRunAt);
  });

  it("pauses after consecutive failures, notifies once, re-enable resets", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Flaky",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const notes = [];
    let launchThrows = true;
    let lastThreadId = null;
    const sched = startScheduler({
      store,
      notify: (n) => notes.push(n),
      intervalMs: 60 * 60 * 1000,
      runner: {
        startRun: async (input) => {
          lastThreadId = input.threadId;
          if (launchThrows) throw new Error("CLI missing");
          store.updateThread(input.threadId, { status: "working" });
          return { runId: "r" };
        },
      },
    });
    const due = () =>
      store.setAutomations([
        { ...store.getAutomation(created.id), nextRunAt: Date.now() - 1000 },
      ]);
    try {
      // Launch failure counts immediately.
      due();
      await sched.tick();
      assert.equal(store.getAutomation(created.id).consecutiveFailures, 1);

      // Run that launches then ends failed counts on the next tick.
      launchThrows = false;
      due();
      await sched.tick();
      assert.equal(store.getAutomation(created.id).pendingRunThreadId, lastThreadId);
      store.updateThread(lastThreadId, { status: "failed" });
      due();
      await sched.tick(); // settles failure #2, fires #3
      assert.equal(store.getAutomation(created.id).consecutiveFailures, 2);
      store.updateThread(lastThreadId, { status: "failed" });
      const firedBefore = lastThreadId;
      due();
      await sched.tick(); // settles #3 -> paused, must not fire

      const paused = store.getAutomation(created.id);
      assert.equal(paused.enabled, false);
      assert.equal(paused.consecutiveFailures, 3);
      assert.match(paused.lastError, /Paused after 3 consecutive failures/);
      assert.equal(lastThreadId, firedBefore);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].name, "Flaky");

      const back = services.updateAutomation(store, { id: created.id, enabled: true });
      assert.equal(back.consecutiveFailures, 0);
      assert.equal(back.lastError, null);
    } finally {
      sched.stop();
    }
  });

  it("a finished run resets the failure streak", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Recovers",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    store.setAutomations([
      { ...store.getAutomation(created.id), consecutiveFailures: 2 },
    ]);
    let threadId = null;
    await runNow(
      {
        store,
        runner: {
          startRun: async (input) => {
            threadId = input.threadId;
            return { runId: "r" };
          },
        },
      },
      created.id,
    );
    store.updateThread(threadId, { status: "done" });
    const { settleAutomationRuns } = require("../automations.js");
    assert.equal(settleAutomationRuns({ store }), true);
    const after = store.getAutomation(created.id);
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.pendingRunThreadId, null);
    assert.equal(settleAutomationRuns({ store }), false);
  });

  it("graduates observe to draft through tick and settle (#388)", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Calibrating",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    assert.equal(created.stage, "observe");
    assert.equal(created.graduate, true);
    let clock = Date.now();
    const prompts = [];
    const sched = startScheduler({
      store,
      runner: {
        startRun: async (input) => {
          prompts.push(input.prompt);
          store.updateThread(input.threadId, { status: "done" });
          return { runId: "r" };
        },
      },
      intervalMs: 60 * 60 * 1000,
      now: () => clock,
    });
    const makeDue = () =>
      store.setAutomations([
        { ...store.getAutomation(created.id), nextRunAt: clock - 1 },
      ]);
    try {
      makeDue();
      await sched.tick();
      clock += STAGE_MS;
      makeDue();
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.match(prompts[0], /\[Automation stage: observe\]/);
    assert.match(prompts[1], /\[Automation stage: draft\]/);
    const after = store.getAutomation(created.id);
    assert.equal(after.stage, "draft");
    assert.equal(after.stageSince, clock);
  });

  it("pre-#388 rows load as act; a hand-picked stage restarts the clock", () => {
    store.setAutomations([
      { id: "old", projectId: "p1", name: "Old", prompt: "go", provider: "claude", preset: "hourly" },
    ]);
    store.saveNow();
    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getAutomation("old").stage, "act");
    const before = Date.now();
    const updated = services.updateAutomation(reloaded, {
      id: "old",
      stage: "draft",
      graduate: false,
    });
    assert.equal(updated.stage, "draft");
    assert.equal(updated.graduate, false);
    assert.ok(updated.stageSince >= before);
    assert.throws(
      () => services.updateAutomation(reloaded, { id: "old", stage: "yolo" }),
      /Invalid stage/,
    );
  });

  async function fireAuto(autoId) {
    let threadId = null;
    await runNow(
      {
        store,
        runner: {
          startRun: async (input) => {
            threadId = input.threadId;
            return { runId: "r" };
          },
        },
      },
      autoId,
    );
    return store.getThread(threadId);
  }

  it("updating an automation keeps existing thread links", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const thread = await fireAuto(created.id);
    assert.equal(thread.automationId, created.id);

    const updated = services.updateAutomation(store, {
      id: created.id,
      prompt: "go farther",
    });
    assert.equal(updated.id, created.id);
    assert.equal(store.getThread(thread.id).automationId, created.id);
    assert.equal(services.listAutomations(store).length, 1);
  });

  it("retains only the newest MAX threads per automation and drops their messages", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const ids = [];
    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION + 5; i++) {
      const thread = await fireAuto(created.id);
      ids.push(thread.id);
    }
    const mine = store
      .getThreads()
      .filter((t) => t.automationId === created.id);
    assert.equal(mine.length, MAX_THREADS_PER_AUTOMATION);
    const surviving = new Set(mine.map((t) => t.id));
    const expected = ids.slice(-MAX_THREADS_PER_AUTOMATION);
    assert.deepEqual([...surviving].sort(), [...expected].sort());
    for (const id of ids.slice(0, 5)) {
      assert.equal(surviving.has(id), false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(store.data.messagesByThread, id),
        false,
      );
    }
    for (const id of expected) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(store.data.messagesByThread, id),
        true,
      );
    }
  });

  it("does not purge working, worktree, or pinned automation threads", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const withWorktree = await fireAuto(created.id);
    withWorktree.worktreePath = path.join(tmpDir, "wt");
    const working = await fireAuto(created.id);
    working.status = "working";
    const pinned = await fireAuto(created.id);
    pinned.pinnedAt = Date.now();

    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION + 2; i++) {
      await fireAuto(created.id);
    }

    assert.ok(store.getThread(withWorktree.id));
    assert.ok(store.getThread(working.id));
    assert.ok(store.getThread(pinned.id));
    const mine = store
      .getThreads()
      .filter((t) => t.automationId === created.id);
    // Newest MAX kept, plus the 3 skipped live/pinned threads past the keep set.
    assert.equal(mine.length, MAX_THREADS_PER_AUTOMATION + 3);
  });

  it("keeps a quota-wait automation thread and its transcript past the cap (#932)", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const parked = services.createThread(store, {
      projectId: "p1",
      title: "Sweep",
      automationId: created.id,
    });
    const parkedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    store.updateThread(parked.id, {
      createdAt: parkedAt,
      status: "quota-wait",
      quotaWaitUntil: Date.now() + 7 * 24 * 60 * 60 * 1000,
      lastError: "usage limit reached",
    });
    store.appendMessage(parked.id, {
      id: "u1",
      role: "user",
      text: "review the repo",
      createdAt: parkedAt,
    });
    store.appendMessage(parked.id, {
      id: "a1",
      role: "assistant",
      text: "started, then hit quota",
      createdAt: parkedAt + 1,
    });

    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION; i++) {
      const thread = await fireAuto(created.id);
      thread.status = "done";
    }

    assert.ok(store.getThread(parked.id), "quota-wait thread must survive prune");
    assert.equal(store.getThread(parked.id).status, "quota-wait");
    assert.deepEqual(
      store.getMessages(parked.id).map((m) => m.text),
      ["review the repo", "started, then hit quota"],
    );
  });

  it("keeps other unfinished automation threads past the cap (#932)", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const now = Date.now();
    const failover = services.createThread(store, {
      projectId: "p1",
      title: "Sweep",
      automationId: created.id,
    });
    store.updateThread(failover.id, {
      createdAt: now - 4000,
      status: "idle",
      quotaFailoverPending: true,
    });
    const asking = services.createThread(store, {
      projectId: "p1",
      title: "Sweep",
      automationId: created.id,
    });
    store.updateThread(asking.id, {
      createdAt: now - 3000,
      status: "idle",
      pendingQuestion: {
        id: "q1",
        askedAt: now - 3000,
        questions: [{ question: "Merge?", options: [{ label: "Yes" }] }],
      },
    });
    const planning = services.createThread(store, {
      projectId: "p1",
      title: "Sweep",
      automationId: created.id,
    });
    store.updateThread(planning.id, {
      createdAt: now - 2000,
      status: "idle",
      pendingPlan: {
        id: "plan1",
        plan: "Ship the parked work after quota resets.",
        askedAt: now - 2000,
      },
    });

    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION; i++) {
      const thread = await fireAuto(created.id);
      thread.status = "done";
    }

    assert.ok(store.getThread(failover.id), "quotaFailoverPending");
    assert.ok(store.getThread(asking.id), "pendingQuestion");
    assert.ok(store.getThread(planning.id), "pendingPlan");
  });

  it("still prunes done and failed automation history past the cap", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const done = await fireAuto(created.id);
    done.status = "done";
    const failed = await fireAuto(created.id);
    failed.status = "failed";

    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION; i++) {
      const thread = await fireAuto(created.id);
      thread.status = "done";
    }

    assert.equal(store.getThread(done.id), null);
    assert.equal(store.getThread(failed.id), null);
    assert.equal(store.getMessages(done.id).length, 0);
    assert.equal(store.getMessages(failed.id).length, 0);
  });

  it("leaves other automations and hand-made threads untouched", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const other = services.addAutomation(store, {
      projectId: "p1",
      name: "Other",
      prompt: "other",
      provider: "claude",
      preset: "hourly",
    });
    const handmade = services.createThread(store, {
      projectId: "p1",
      title: "Manual",
    });
    assert.equal(handmade.automationId, null);
    const otherThread = await fireAuto(other.id);
    assert.equal(otherThread.automationId, other.id);

    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION + 5; i++) {
      await fireAuto(created.id);
    }

    assert.ok(store.getThread(handmade.id));
    assert.equal(store.getThread(handmade.id).automationId, null);
    assert.ok(store.getThread(otherThread.id));
    assert.equal(store.getThread(otherThread.id).automationId, other.id);
    assert.equal(
      store.getThreads().filter((t) => t.automationId === created.id).length,
      MAX_THREADS_PER_AUTOMATION,
    );
    assert.equal(
      store.getThreads().filter((t) => t.automationId === other.id).length,
      1,
    );
  });

  it("listAutomationRuns returns only this automation's threads, newest first", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const other = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "other",
      provider: "claude",
      preset: "hourly",
    });
    const handmade = services.createThread(store, {
      projectId: "p1",
      title: "Sweep",
    });
    const otherThread = await fireAuto(other.id);
    const first = await fireAuto(created.id);
    const second = await fireAuto(created.id);
    store.getThread(second.id).status = "working";
    store.getThread(first.id).status = "done";

    const listed = listAutomationRuns(store, created.id);
    assert.equal(listed.automationId, created.id);
    assert.deepEqual(
      listed.runs.map((r) => r.threadId),
      [second.id, first.id],
    );
    assert.equal(listed.runs[0].status, "working");
    assert.equal(listed.runs[1].status, "done");
    assert.equal(listed.runs[0].startedAt, second.createdAt);
    assert.equal(
      listed.runs.some((r) => r.threadId === handmade.id),
      false,
    );
    assert.equal(
      listed.runs.some((r) => r.threadId === otherThread.id),
      false,
    );
    assert.equal(listed.retentionLimitReached, false);
  });

  it("listAutomationRuns ignores another project's automation with the same name", async () => {
    store.setProjects([
      ...store.getProjects(),
      { id: "p2", slug: "acme/other", name: "other", path: tmpDir },
    ]);
    store.saveNow();
    const mine = services.addAutomation(store, {
      projectId: "p1",
      name: "Nightly",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const theirs = services.addAutomation(store, {
      projectId: "p2",
      name: "Nightly",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const mineThread = await fireAuto(mine.id);
    const theirThread = await fireAuto(theirs.id);
    const listed = listAutomationRuns(store, mine.id);
    assert.deepEqual(
      listed.runs.map((r) => r.threadId),
      [mineThread.id],
    );
    assert.equal(
      listed.runs.some((r) => r.threadId === theirThread.id),
      false,
    );
  });

  it("listAutomationRuns ignores a same-id thread on another project", async () => {
    store.setProjects([
      ...store.getProjects(),
      { id: "p2", slug: "acme/other", name: "other", path: tmpDir },
    ]);
    store.saveNow();
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const mine = await fireAuto(created.id);
    const stray = services.createThread(store, {
      projectId: "p2",
      title: "Sweep",
      automationId: created.id,
    });
    const listed = listAutomationRuns(store, created.id);
    assert.deepEqual(
      listed.runs.map((r) => r.threadId),
      [mine.id],
    );
    assert.equal(
      listed.runs.some((r) => r.threadId === stray.id),
      false,
    );
  });

  it("listAutomationRuns keeps association after rename", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const thread = await fireAuto(created.id);
    services.updateAutomation(store, { id: created.id, name: "Renamed sweep" });
    const listed = listAutomationRuns(store, created.id);
    assert.deepEqual(
      listed.runs.map((r) => r.threadId),
      [thread.id],
    );
  });

  it("listAutomationRuns passes quota-wait through and includes a live working run", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const parked = await fireAuto(created.id);
    parked.status = "quota-wait";
    const live = await fireAuto(created.id);
    live.status = "working";
    const listed = listAutomationRuns(store, created.id);
    assert.equal(listed.runs[0].threadId, live.id);
    assert.equal(listed.runs[0].status, "working");
    assert.equal(listed.runs[1].threadId, parked.id);
    assert.equal(listed.runs[1].status, "quota-wait");
  });

  it("listAutomationRuns sets retentionLimitReached at exactly the cap with no deletes", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const ids = [];
    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION; i++) {
      const thread = await fireAuto(created.id);
      ids.push(thread.id);
    }
    const listed = listAutomationRuns(store, created.id);
    assert.equal(listed.runs.length, MAX_THREADS_PER_AUTOMATION);
    assert.equal(listed.retentionLimitReached, true);
    assert.deepEqual(
      listed.runs.map((r) => r.threadId).sort(),
      [...ids].sort(),
    );
    for (const id of ids) {
      assert.ok(store.getThread(id), "exactly-cap fires are all still retained");
    }
  });

  it("listAutomationRuns still lists only retained threads past the cap", async () => {
    const created = services.addAutomation(store, {
      projectId: "p1",
      name: "Sweep",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const ids = [];
    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION + 3; i++) {
      const thread = await fireAuto(created.id);
      ids.push(thread.id);
    }
    const listed = listAutomationRuns(store, created.id);
    assert.equal(listed.runs.length, MAX_THREADS_PER_AUTOMATION);
    assert.equal(listed.retentionLimitReached, true);
    assert.equal(
      listed.runs.some((r) => r.threadId === ids[0]),
      false,
    );
    const kept = store.getThread(ids[ids.length - 1]);
    kept.status = "failed";
    assert.equal(
      listAutomationRuns(store, created.id).runs[0].status,
      "failed",
    );
  });

  it("listAutomationRuns throws for an unknown automation and does not mint a thread", () => {
    const before = store.getThreads().length;
    assert.throws(
      () => listAutomationRuns(store, "missing"),
      /Unknown automation: missing/,
    );
    assert.equal(store.getThreads().length, before);
  });

  function writeShared(row, overlay = {}) {
    fs.writeFileSync(
      path.join(tmpDir, "solenta.json"),
      JSON.stringify({ automations: [row] }, null, 2),
    );
    const id = `shared:p1:${row.id}`;
    store.setAutomations([
      {
        id,
        projectId: "p1",
        scope: "project",
        name: row.name,
        prompt: row.prompt,
        provider: row.provider,
        preset: row.preset,
        hour: row.hour ?? null,
        trigger: row.trigger || null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: Date.now() - 1000,
        lastError: null,
        ...overlay,
      },
    ]);
    return id;
  }

  it("tick does not fire an untrusted shared automation", async () => {
    writeShared({
      id: "nightly",
      name: "Nightly",
      prompt: "go",
      provider: "claude",
      preset: "hourly",
    });
    const started = [];
    const sched = startScheduler({
      store,
      runner: {
        startRun: async (input) => {
          started.push(input);
          return { runId: "r" };
        },
      },
      intervalMs: 60 * 60 * 1000,
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.equal(started.length, 0);
  });

  it("tick GCs orphan shared overlays", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "solenta.json"),
      JSON.stringify({ automations: [] }, null, 2),
    );
    store.setAutomations([
      {
        id: "shared:p1:gone",
        projectId: "p1",
        scope: "project",
        name: "Gone",
        prompt: "x",
        provider: "claude",
        preset: "hourly",
        hour: null,
        enabled: true,
        lastRunAt: null,
        nextRunAt: Date.now() - 1000,
        lastError: null,
      },
    ]);
    const sched = startScheduler({
      store,
      runner: { startRun: async () => ({ runId: "r" }) },
      intervalMs: 60 * 60 * 1000,
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.equal(store.getAutomations().length, 0);
  });

  it("runNow on untrusted shared rejects; hash trusts and fires once without enabling", async () => {
    const id = writeShared(
      {
        id: "nightly",
        name: "Nightly",
        prompt: "go",
        provider: "claude",
        preset: "hourly",
      },
      { enabled: false, nextRunAt: Date.now() + 86_400_000 },
    );
    const { readAutomations } = require("../automations-file.js");
    const hash = readAutomations(tmpDir).hash;
    const started = [];
    const ctx = {
      store,
      runner: {
        startRun: async (input) => {
          started.push(input);
          return { runId: "r" };
        },
      },
    };
    await assert.rejects(() => runNow(ctx, { id }), /not trusted/);
    assert.equal(started.length, 0);
    const after = await runNow(ctx, { id, hash });
    assert.equal(started.length, 1);
    assert.equal(after.enabled, false);
    assert.equal(store.getAutomation(id).enabled, false);
    assert.equal(store.getProject("p1").automationsTrust, hash);
  });

  it("runNow fires the merged file prompt, not a stale overlay", async () => {
    const id = writeShared(
      {
        id: "nightly",
        name: "Nightly",
        prompt: "From file",
        provider: "claude",
        preset: "hourly",
      },
      { prompt: "Stale", enabled: false, nextRunAt: Date.now() + 86_400_000 },
    );
    const { readAutomations } = require("../automations-file.js");
    const hash = readAutomations(tmpDir).hash;
    const started = [];
    const after = await runNow(
      {
        store,
        runner: {
          startRun: async (input) => {
            started.push(input);
            return { runId: "r" };
          },
        },
      },
      { id, hash },
    );
    assert.equal(started.length, 1);
    assert.match(started[0].prompt, /^From file\n/);
    assert.equal(after.enabled, false);
    assert.equal(store.getAutomation(id).enabled, false);
    assert.equal(store.getAutomation(id).prompt, "Stale");
  });

  it("listAutomationRuns returns empty runs for a file-only shared row", () => {
    fs.writeFileSync(
      path.join(tmpDir, "solenta.json"),
      JSON.stringify(
        {
          automations: [
            {
              id: "nightly",
              name: "Nightly",
              prompt: "go",
              provider: "claude",
              preset: "hourly",
            },
          ],
        },
        null,
        2,
      ),
    );
    const id = "shared:p1:nightly";
    assert.equal(store.getAutomation(id), null);
    const listed = listAutomationRuns(store, id);
    assert.equal(listed.automationId, id);
    assert.deepEqual(listed.runs, []);
    assert.equal(listed.retentionLimitReached, false);
  });
});

describe("preset once (#1812)", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-once-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: tmpDir },
    ]);
    store.saveNow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOnce(runAt) {
    return services.addAutomation(store, {
      projectId: "p1",
      name: "Reminder",
      prompt: "ping me",
      provider: "claude",
      preset: "once",
      runAt,
    });
  }

  function makeDueAt(nextRunAt) {
    const runAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = makeOnce(runAt);
    store.setAutomations([
      { ...store.getAutomation(created.id), nextRunAt },
    ]);
    store.saveNow();
    return created;
  }

  it("create: hour is null, nextRunAt is the parsed runAt", () => {
    const runAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = makeOnce(runAt);
    assert.equal(created.preset, "once");
    assert.equal(created.runAt, runAt);
    assert.equal(created.hour, null);
    assert.equal(created.nextRunAt, new Date(runAt).getTime());
    assert.equal(created.enabled, true);
  });

  it("rejects a runAt in the past, and a missing one", () => {
    assert.throws(
      () => makeOnce(new Date(Date.now() - 1000).toISOString()),
      /future/,
    );
    assert.throws(() => makeOnce(""), /runAt is required/);
  });

  it("fires at runAt and disables itself (does not fire twice)", async () => {
    const created = makeDueAt(Date.now() - 1000);
    const started = [];
    const sched = startScheduler({
      store,
      runner: { startRun: async (input) => started.push(input) },
      intervalMs: 60 * 60 * 1000,
    });
    try {
      await sched.tick();
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.equal(started.length, 1, "fires exactly once across two ticks");
    const after = store.getAutomation(created.id);
    assert.equal(after.enabled, false);
    assert.ok(after.lastRunAt);
    assert.equal(after.runAt, created.runAt, "runAt is kept for the row's history");
  });

  it("missed beyond the grace window: disabled without firing, lastRunAt stays null", async () => {
    const created = makeDueAt(Date.now() - (ONCE_GRACE_MS + 60_000));
    const started = [];
    const sched = startScheduler({
      store,
      runner: { startRun: async (input) => started.push(input) },
      intervalMs: 60 * 60 * 1000,
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.equal(started.length, 0, "a long-missed once never fires");
    const after = store.getAutomation(created.id);
    assert.equal(after.enabled, false);
    assert.equal(after.lastRunAt, null);
  });

  it("fires on startup within the grace window", async () => {
    const created = makeDueAt(Date.now() - (ONCE_GRACE_MS - 60_000));
    const started = [];
    const sched = startScheduler({
      store,
      runner: { startRun: async (input) => started.push(input) },
      intervalMs: 60 * 60 * 1000,
    });
    try {
      await sched.tick();
    } finally {
      sched.stop();
    }
    assert.equal(started.length, 1, "a catch-uppable once still fires once");
    assert.ok(store.getAutomation(created.id).lastRunAt);
  });

  it("editing an already-fired once keeps its (now past) runAt without re-validating it", () => {
    const created = makeDueAt(Date.now() - 1000);
    // Simulate time having passed since the fire: runAt itself is now past,
    // same as it would genuinely be well after the automation fired.
    const pastRunAt = new Date(Date.now() - 1000).toISOString();
    store.setAutomations([
      {
        ...store.getAutomation(created.id),
        runAt: pastRunAt,
        enabled: false,
        lastRunAt: Date.now(),
      },
    ]);
    store.saveNow();
    const renamed = services.updateAutomation(store, {
      id: created.id,
      name: "Reminder (renamed)",
    });
    assert.equal(renamed.name, "Reminder (renamed)");
    assert.equal(renamed.runAt, pastRunAt);
    // Explicitly resubmitting that same past runAt is still rejected.
    assert.throws(
      () => services.updateAutomation(store, { id: created.id, runAt: pastRunAt }),
      /future/,
    );
  });
});
