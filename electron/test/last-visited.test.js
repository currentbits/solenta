/**
 * Round 43: lastVisitedAt stamping for unread indicators.
 *
 * Callers of getThreadDetail (must stay honest):
 * - ipc threads:get → markVisited default true
 * - runner.pushDetail → markVisited false (background must not mark read)
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("lastVisitedAt (round 43)", () => {
  let tmpDir;
  let store;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-visit-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread stamps lastVisitedAt equal to createdAt (not unread)", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Fresh",
    });
    assert.equal(typeof thread.lastVisitedAt, "number");
    assert.equal(thread.lastVisitedAt, thread.createdAt);
    assert.equal(thread.lastVisitedAt, thread.updatedAt);
    assert.equal(store.getThread(thread.id).lastVisitedAt, thread.createdAt);
  });

  it("getThreadDetail (threads:get) does not schedule a flush (#636)", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Idle click",
    });
    store.updateThread(thread.id, { lastVisitedAt: 1 });
    store.saveNow();
    assert.equal(store._timer, null, "precondition: no flush armed");

    const detail = services.getThreadDetail(store, thread.id);

    assert.ok(
      detail.thread.lastVisitedAt > 1,
      "selection still stamps lastVisitedAt in memory",
    );
    assert.equal(
      store._timer,
      null,
      "visit stamp must not arm a whole-store rewrite",
    );
    assert.equal(
      store._dirty,
      true,
      "stamp must stay dirty so the exit hook / next real flush persist it",
    );
  });

  it("getThreadDetail stamps lastVisitedAt and does NOT bump updatedAt", async () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Visit me",
    });
    // Backdate visit so a re-get is observable; leave updatedAt alone.
    store.updateThread(thread.id, { lastVisitedAt: 1 });
    store.saveNow();
    const beforeUpdated = store.getThread(thread.id).updatedAt;
    assert.equal(store.getThread(thread.id).lastVisitedAt, 1);

    // Yield so Date.now() can advance past create time on fast clocks.
    await new Promise((r) => setTimeout(r, 5));
    const beforeCall = Date.now();
    const detail = services.getThreadDetail(store, thread.id);
    const after = store.getThread(thread.id);

    assert.ok(
      detail.thread.lastVisitedAt >= beforeCall,
      "stamp must be ~now on IPC get (default markVisited)",
    );
    assert.equal(
      after.updatedAt,
      beforeUpdated,
      "visiting must not bump updatedAt (would re-unread + re-sort)",
    );
    assert.equal(after.lastVisitedAt, detail.thread.lastVisitedAt);
  });

  it("getThreadDetail({ markVisited: false }) does not stamp (threads.peek)", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Background",
    });
    store.updateThread(thread.id, { lastVisitedAt: 42 });
    store.saveNow();

    const detail = services.getThreadDetail(store, thread.id, null, {
      markVisited: false,
    });
    assert.equal(detail.thread.lastVisitedAt, 42);
    assert.equal(store.getThread(thread.id).lastVisitedAt, 42);
  });

  it("runner pushDetail (internal refresh) does not stamp lastVisitedAt", async () => {
    // Load-bearing: pushDetail is the real internal caller of getThreadDetail.
    // A background stream on a non-selected thread must never mark it read.
    const prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    let runner;
    try {
      const core = await loadCore();
      const pushes = [];
      runner = createRunner({
        store,
        core,
        pushFn: (channel, payload) => {
          pushes.push({ channel, payload });
        },
        tickMs: 15,
      });

      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Streaming",
      });
      store.updateThread(thread.id, { lastVisitedAt: 99 });
      store.saveNow();
      assert.equal(store.getThread(thread.id).lastVisitedAt, 99);

      await runner.startRun({
        threadId: thread.id,
        prompt: "stream without marking visited",
      });

      await waitFor(() =>
        pushes.some((p) => p.channel === "thread:updated"),
      );

      assert.equal(
        store.getThread(thread.id).lastVisitedAt,
        99,
        "pushDetail must pass markVisited:false so stream refresh never marks read",
      );

      // Control: the IPC path (default markVisited) still stamps.
      const detail = services.getThreadDetail(store, thread.id);
      assert.ok(detail.thread.lastVisitedAt > 99);
    } finally {
      if (runner) runner.stopAll();
      if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
      else process.env.CODER_SIMULATE = prevSimulate;
    }
  });

  it("lastVisitedAt persists across save/reload", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Persist",
    });
    store.updateThread(thread.id, { lastVisitedAt: 1234567890 });
    store.saveNow();

    const reloaded = new Store(path.join(tmpDir, "store.json"));
    assert.equal(reloaded.getThread(thread.id).lastVisitedAt, 1234567890);
  });

  it("migration null survives reload from disk without lastVisitedAt key", () => {
    const filePath = path.join(tmpDir, "legacy.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        projects: [],
        threads: [
          {
            id: "legacy-1",
            projectId: "p",
            title: "Old",
            branch: null,
            prNumber: null,
            status: "idle",
            createdAt: 10,
            updatedAt: 20,
          },
        ],
        messagesByThread: {},
        workLogByThread: {},
      }),
      "utf8",
    );
    const loaded = new Store(filePath);
    assert.equal(loaded.getThread("legacy-1").lastVisitedAt, null);
    loaded.saveNow();
    const again = new Store(filePath);
    assert.equal(again.getThread("legacy-1").lastVisitedAt, null);
  });
});
