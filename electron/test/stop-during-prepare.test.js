"use strict";

/**
 * Issue #1228: Stop during startRun's first-turn prefetch must abort the
 * launch. Real createRunner + Store, injected runAgentFn, deferred
 * bootstrapMemory. No live CLI.
 *
 * Run: node --test electron/test/stop-during-prepare.test.js
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

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
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

function emptyBoot() {
  return {
    conventions: [],
    strategies: [],
    knowledge: [],
    tasks: [],
  };
}

/** One held bootstrapMemory call. */
function heldBootstrap() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const bootstrapMemory = async () => {
    entered += 1;
    await gate;
    return emptyBoot();
  };
  return {
    bootstrapMemory,
    release() {
      release();
    },
    entered: () => entered,
  };
}

/** FIFO held bootstrapMemory calls so an older launch can be released first. */
function queuedBootstrap() {
  const waiters = [];
  const bootstrapMemory = async () => {
    await new Promise((resolve) => {
      waiters.push(resolve);
    });
    return emptyBoot();
  };
  return {
    bootstrapMemory,
    pending: () => waiters.length,
    releaseNext() {
      const resolve = waiters.shift();
      if (!resolve) throw new Error("no pending bootstrap");
      resolve();
    },
  };
}

describe("stop during startRun preparation (#1228)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let spawns;
  let spawnPrompts;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e process.exit(0)`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-stop-prepare-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
    spawns = 0;
    spawnPrompts = [];

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
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

  function makeRunner(bootstrapMemory) {
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      bootstrapMemory,
      runAgentFn: ({ prompt, onDone }) => {
        spawns += 1;
        spawnPrompts.push(String(prompt || ""));
        setImmediate(() => onDone(0, "ok", ""));
        return { kill() {} };
      },
    });
    return runner;
  }

  it("Stop during held bootstrap prevents spawn and settles idle", async () => {
    const boot = heldBootstrap();
    makeRunner(boot.bootstrapMemory);
    const thread = store.getThreads()[0];

    const started = runner.startRun({
      threadId: thread.id,
      prompt: "first turn",
    });
    await waitFor(() => boot.entered() === 1);
    assert.equal(store.getThread(thread.id).status, "working");
    assert.equal(runner.isRunning(thread.id), true);
    assert.equal(spawns, 0);
    await assert.rejects(
      () => runner.startRun({ threadId: thread.id, prompt: "second" }),
      /already active/i,
    );

    await runner.stopRun({ threadId: thread.id });
    assert.equal(runner.isRunning(thread.id), false);
    assert.equal(store.getThread(thread.id).status, "idle");
    assert.ok(store.getThread(thread.id).stoppedAt);
    assert.ok(
      store
        .getMessages(thread.id)
        .some((m) => m.role === "event" && /Run stopped/i.test(m.text)),
      "Stop must settle the visible run once",
    );

    boot.release();
    await started;
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(spawns, 0);
    assert.equal(runner.isRunning(thread.id), false);
    const after = store.getThread(thread.id);
    assert.equal(after.status, "idle");
    assert.equal(after.sessionId || null, null);
    services.deleteThread(
      store,
      { threadId: thread.id },
      { isRunning: (id) => runner.isRunning(id) },
    );
    assert.equal(store.getThread(thread.id), null);
  });

  it("a cancelled older launch cannot spawn alongside a newer run", async () => {
    const boot = queuedBootstrap();
    makeRunner(boot.bootstrapMemory);
    const thread = store.getThreads()[0];

    const first = runner.startRun({
      threadId: thread.id,
      prompt: "older launch",
    });
    await waitFor(() => boot.pending() === 1);
    await runner.stopRun({ threadId: thread.id });
    assert.equal(runner.isRunning(thread.id), false);

    const second = runner.startRun({
      threadId: thread.id,
      prompt: "newer launch",
    });
    await waitFor(() => boot.pending() === 2);
    assert.equal(store.getThread(thread.id).status, "working");
    assert.equal(runner.isRunning(thread.id), true);

    boot.releaseNext();
    await first;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(spawns, 0, "cancelled older launch must not spawn");
    assert.equal(
      store.getThread(thread.id).status,
      "working",
      "older continuation must not overwrite the newer run",
    );
    assert.equal(runner.isRunning(thread.id), true);

    boot.releaseNext();
    await second;
    await waitFor(() => spawns === 1);
    assert.equal(spawns, 1);
    assert.ok(
      spawnPrompts[0].includes("newer launch"),
      "only the newer prompt may reach the provider",
    );
  });

  it("deleteThread is rejected while preparation is pending", async () => {
    const boot = heldBootstrap();
    makeRunner(boot.bootstrapMemory);
    const thread = store.getThreads()[0];
    const started = runner.startRun({
      threadId: thread.id,
      prompt: "do not delete",
    });
    await waitFor(() => boot.entered() === 1);
    assert.equal(runner.isRunning(thread.id), true);

    assert.throws(
      () =>
        services.deleteThread(
          store,
          { threadId: thread.id },
          { isRunning: (id) => runner.isRunning(id) },
        ),
      /run is active/i,
    );
    assert.ok(store.getThread(thread.id));

    await runner.stopRun({ threadId: thread.id });
    boot.release();
    await started;
    assert.equal(spawns, 0);
  });

  it("stopAll invalidates pending starts so no provider spawns after cleanup", async () => {
    const boot = heldBootstrap();
    makeRunner(boot.bootstrapMemory);
    const thread = store.getThreads()[0];
    const started = runner.startRun({
      threadId: thread.id,
      prompt: "about to quit",
    });
    await waitFor(() => boot.entered() === 1);
    assert.equal(runner.isRunning(thread.id), true);

    runner.stopAll();
    assert.equal(runner.isRunning(thread.id), false);

    boot.release();
    await started;
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(spawns, 0);
    assert.equal(runner.isRunning(thread.id), false);
    const after = store.getThread(thread.id);
    assert.equal(after.status, "idle");
    assert.ok(
      store
        .getMessages(thread.id)
        .some(
          (m) =>
            m.role === "event" &&
            /Run stopped|interrupted by app quit/i.test(m.text),
        ),
    );
  });

  it("normal first-turn preparation starts exactly once", async () => {
    makeRunner(async () => emptyBoot());
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => spawns === 1);
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(spawns, 1);
  });

  it("unavailable memory fail-opens and still starts when not cancelled", async () => {
    makeRunner(async () => {
      throw new Error("memory down");
    });
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "go anyway" });
    await waitFor(() => spawns === 1);
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(spawns, 1);
  });
});
