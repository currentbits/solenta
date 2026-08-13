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

describe("automation CRUD + scheduler", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setProjects([
      { id: "p1", slug: "acme/app", name: "app", path: tmpDir },
    ]);
    store.save();
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
    store.save();

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
    assert.equal(started[0].prompt, "do the thing");
    const thread = store.getThreads()[0];
    assert.ok(thread);
    assert.equal(thread.title, "Hourly sweep");
    assert.equal(thread.provider, "claude");
    assert.equal(started[0].threadId, thread.id);
    const after = store.getAutomation(created.id);
    assert.ok(after.lastRunAt);
    assert.ok(after.nextRunAt > Date.now());
    assert.equal(after.lastError, null);
    assert.ok(broadcasts.some((b) => b[0] === "threads:changed"));
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
});
