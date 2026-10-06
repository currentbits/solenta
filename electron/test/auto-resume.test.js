"use strict";

/**
 * Opt-in resume after restart (issue #1512 I3).
 * Run: node --test electron/test/auto-resume.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store, normalizeSettings } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { RESUME_EVENT } = require("../runner-auto-resume.js");
const { rmTree } = require("./support/rmTree.js");

const FAST = { pollMs: 5, startGraceMs: 2000 };

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const texts = (store, id, role) =>
  (store.getMessages(id) || [])
    .filter((m) => m.role === role)
    .map((m) => String(m.text || ""));

describe("resume interrupted runs after restart (#1512 I3)", () => {
  let tmpDir;
  let storePath;
  let store;
  let runner;
  let core;
  let project;
  let prevSimulate;

  /** An interrupted thread with a resumable session; `patch` overrides. */
  function interrupted(title, patch = {}) {
    const t = services.createThread(store, { projectId: project.id, title });
    store.updateThread(t.id, {
      status: "failed",
      sessionId: `sess-${title}`,
      interruptedAt: Date.now() - 60_000,
      ...patch,
    });
    return t.id;
  }

  function enable() {
    services.setSettings(store, { resumeInterruptedRuns: true });
  }

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-auto-resume-"));
    storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
    core = await loadCore();
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15 });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  it("setting is opt-in and validated", () => {
    assert.equal(normalizeSettings({}).resumeInterruptedRuns, false);
    assert.equal(normalizeSettings({ resumeInterruptedRuns: "yes" }).resumeInterruptedRuns, false);
    assert.equal(normalizeSettings({ resumeInterruptedRuns: true }).resumeInterruptedRuns, true);
    assert.throws(
      () => services.setSettings(store, { resumeInterruptedRuns: 1 }),
      /must be a boolean/,
    );
  });

  it("does nothing while the setting is off", async () => {
    const id = interrupted("a");
    assert.deepEqual(await runner.resumeInterruptedRuns(FAST), []);
    assert.equal(store.getThread(id).autoResumedAt, undefined);
    assert.deepEqual(texts(store, id, "user"), []);
  });

  it("gives each interrupted thread one auto turn, with a transcript event", async () => {
    enable();
    const a = interrupted("a");
    const b = interrupted("b");
    const ids = await runner.resumeInterruptedRuns(FAST);
    assert.deepEqual(ids.sort(), [a, b].sort());
    for (const id of ids) {
      const users = (store.getMessages(id) || []).filter((m) => m.role === "user");
      assert.equal(users.length, 1);
      assert.match(users[0].text, /The app restarted while you were working\. Continue where you left off\./);
      assert.doesNotMatch(users[0].text, /Continue orchestrating/);
      assert.equal(users[0].fromNotice, true);
      assert.ok(texts(store, id, "event").includes(RESUME_EVENT));
      // A machine turn: never the user's approval for the merge gate.
      assert.equal(runner.isAutoTurn(id), true);
      const t = store.getThread(id);
      assert.equal(t.interruptedAt, null);
      assert.ok(t.autoResumedAt > 0);
    }
    // Same boot again: nothing left to resume.
    assert.deepEqual(await runner.resumeInterruptedRuns(FAST), []);
  });

  it("skips stale, sessionless, archived, trashed, settled and worktree-less threads", async () => {
    enable();
    const now = Date.now();
    interrupted("stale", { interruptedAt: now - 13 * 60 * 60 * 1000 });
    interrupted("nosession", { sessionId: null });
    interrupted("archived", { archived: true });
    interrupted("trashed", { trashedAt: now });
    interrupted("settled", { settledOverride: "settled" });
    interrupted("noworktree", { worktreePath: path.join(tmpDir, "gone") });
    interrupted("never", { interruptedAt: undefined });
    assert.deepEqual(await runner.resumeInterruptedRuns({ ...FAST, now }), []);
  });

  it("runs at most `concurrency` resumes at once and still resumes them all", async () => {
    enable();
    const ids = ["a", "b", "c", "d", "e"].map((n) => interrupted(n));
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, runner.listActiveThreadIds().length);
    }, 1);
    try {
      await runner.resumeInterruptedRuns({ ...FAST, concurrency: 2 });
    } finally {
      clearInterval(sampler);
    }
    assert.ok(peak >= 1 && peak <= 2, `peak ${peak}`);
    for (const id of ids) {
      assert.equal(texts(store, id, "user").length, 1, id);
    }
  });

  it("stamps interruptedAt on quit and crash, and a new run clears it", async () => {
    const id = services.createThread(store, { projectId: project.id, title: "q" }).id;
    await runner.startRun({ threadId: id, prompt: "work" });
    assert.equal(store.getThread(id).interruptedAt, null);
    runner.stopAll();
    assert.ok(store.getThread(id).interruptedAt > 0);

    // Crash path: still "working" on disk at load.
    store.updateThread(id, { status: "working", interruptedAt: null });
    store.saveNow();
    const reloaded = new Store(storePath);
    assert.equal(reloaded.getThread(id).status, "failed");
    assert.ok(reloaded.getThread(id).interruptedAt > 0);
  });

  it("never resumes twice, even when the resumed run crashes too; a human turn re-arms", async () => {
    enable();
    const id = interrupted("a");
    assert.deepEqual(await runner.resumeInterruptedRuns(FAST), [id]);

    // The resumed run is interrupted again.
    store.updateThread(id, { interruptedAt: Date.now(), status: "failed" });
    assert.deepEqual(await runner.resumeInterruptedRuns(FAST), []);

    // A human turn answers it; the next interruption is resumable again.
    await runner.startRun({ threadId: id, prompt: "carry on" });
    assert.equal(store.getThread(id).autoResumedAt, null);
    await waitFor(() => !runner.isRunning(id));
    store.updateThread(id, { interruptedAt: Date.now(), status: "failed" });
    assert.deepEqual(await runner.resumeInterruptedRuns(FAST), [id]);
  });

  it("the marker is on disk before any turn starts", async () => {
    enable();
    const id = interrupted("a");
    const pending = runner.resumeInterruptedRuns(FAST);
    // Simulated crash right after boot: a fresh load sees the marker.
    const raw = new Store(storePath);
    assert.ok(raw.getThread(id).autoResumedAt > 0);
    await pending;
  });

  it("stopRun drops a queued resume", async () => {
    enable();
    const a = interrupted("a");
    const b = interrupted("b");
    const pending = runner.resumeInterruptedRuns({ ...FAST, concurrency: 1 });
    // Whichever went first is running; stop the other before its turn.
    await waitFor(() => runner.listActiveThreadIds().length === 1);
    const queued = runner.isRunning(a) ? b : a;
    await runner.stopRun({ threadId: queued });
    await pending;
    assert.deepEqual(texts(store, queued, "user"), []);
    assert.ok(!texts(store, queued, "event").includes(RESUME_EVENT));
  });
});
