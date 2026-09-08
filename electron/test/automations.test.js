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
    assert.equal(started[0].prompt, "do the thing");
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
});
