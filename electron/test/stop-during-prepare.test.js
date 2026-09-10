"use strict";

/**
 * #1228 / #1236: Honor Stop (and delete) while startRun is awaiting
 * first-turn prefetchBootstrapNote, before any provider spawn.
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

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 15 } = {}) {
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

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("stop during first-turn prepare (#1228)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  /** @type {ReturnType<typeof deferred>[]} */
  let hangingBoots;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e process.exit(0)`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-stop-prepare-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
    hangingBoots = [];

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
  });

  afterEach(() => {
    for (const boot of hangingBoots) {
      try {
        boot.resolve({});
      } catch {
        /* already settled */
      }
    }
    hangingBoots = [];
    if (runner) runner.stopAll();
    runner = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  function hangBoot() {
    const boot = deferred();
    hangingBoots.push(boot);
    return boot;
  }

  function makeRunner(opts) {
    const boot = hangBoot();
    let spawns = 0;
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      bootstrapMemory: () => boot.promise,
      runAgentFn: ({ onDone }) => {
        spawns += 1;
        if (opts && opts.finish) {
          setImmediate(() => onDone(0, "ok", ""));
        }
        return { kill() {} };
      },
    });
    return {
      boot,
      spawns: () => spawns,
      thread: store.getThreads()[0],
    };
  }

  it("stopRun during hanging bootstrap does not spawn; status idle; isRunning false", async () => {
    const { boot, spawns, thread } = makeRunner();
    const started = runner.startRun({
      threadId: thread.id,
      prompt: "first turn",
    });
    await waitFor(() => runner.isRunning(thread.id));
    assert.equal(store.getThread(thread.id).status, "working");
    assert.equal(spawns(), 0);

    await runner.stopRun({ threadId: thread.id });
    assert.equal(runner.isRunning(thread.id), false);
    assert.equal(store.getThread(thread.id).status, "idle");

    boot.resolve({});
    const result = await started;
    assert.ok(result && result.runId);
    assert.equal(spawns(), 0);
    assert.equal(store.getThread(thread.id).status, "idle");
    assert.equal(runner.isRunning(thread.id), false);
    assert.equal(store.getThread(thread.id).sessionId, null);
  });

  it("threads:delete during prepare is rejected by the active-run contract", async () => {
    const { boot, spawns, thread } = makeRunner();
    const started = runner.startRun({
      threadId: thread.id,
      prompt: "first turn",
    });
    await waitFor(() => runner.isRunning(thread.id));

    assert.throws(
      () =>
        services.deleteThread(
          store,
          { threadId: thread.id },
          { isRunning: (id) => runner.isRunning(id) },
        ),
      /Cannot delete thread while a run is active/,
    );
    assert.throws(
      () =>
        services.trashThread(
          store,
          { threadId: thread.id },
          { isRunning: (id) => runner.isRunning(id) },
        ),
      /Cannot delete thread while a run is active/,
    );
    assert.ok(store.getThread(thread.id));
    assert.equal(spawns(), 0);

    await runner.stopRun({ threadId: thread.id });
    boot.resolve({});
    await started;
    assert.equal(spawns(), 0);
  });

  it("gone thread after prepare does not spawn or TypeError", async () => {
    const { boot, spawns, thread } = makeRunner();
    const threadId = thread.id;
    const started = runner.startRun({
      threadId,
      prompt: "first turn",
    });
    await waitFor(() => runner.isRunning(threadId));

    store.removeThread(threadId);
    store.saveNow();
    assert.equal(store.getThread(threadId), null);

    boot.resolve({});
    await assert.doesNotReject(started);
    assert.equal(spawns(), 0);
    assert.equal(runner.isRunning(threadId), false);
  });

  it("stopAll during prepare does not spawn after bootstrap resolves", async () => {
    const { boot, spawns, thread } = makeRunner();
    const started = runner.startRun({
      threadId: thread.id,
      prompt: "first turn",
    });
    await waitFor(() => runner.isRunning(thread.id));
    runner.stopAll();
    assert.equal(runner.isRunning(thread.id), false);

    boot.resolve({});
    await started;
    assert.equal(spawns(), 0);
    assert.equal(store.getThread(thread.id).status, "idle");
  });

  it("cancelled older launch cannot spawn alongside a newer run", async () => {
    const boots = [];
    let spawns = 0;
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      bootstrapMemory: () => {
        const boot = deferred();
        boots.push(boot);
        hangingBoots.push(boot);
        return boot.promise;
      },
      runAgentFn: ({ onDone }) => {
        spawns += 1;
        setImmediate(() => onDone(0, "ok", ""));
        return { kill() {} };
      },
    });
    const thread = store.getThreads()[0];
    const first = runner.startRun({
      threadId: thread.id,
      prompt: "old launch",
    });
    await waitFor(() => boots.length === 1 && runner.isRunning(thread.id));
    await runner.stopRun({ threadId: thread.id });

    const second = runner.startRun({
      threadId: thread.id,
      prompt: "new launch",
    });
    await waitFor(() => boots.length === 2);
    boots[1].resolve({});
    await second;
    await waitFor(() => spawns === 1);

    boots[0].resolve({});
    await first;
    assert.equal(spawns, 1);
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("happy-path first turn still spawns once", async () => {
    const { boot, spawns, thread } = makeRunner({ finish: true });
    const started = runner.startRun({
      threadId: thread.id,
      prompt: "hello",
    });
    await waitFor(() => runner.isRunning(thread.id));
    boot.resolve({
      conventions: [],
      strategies: [],
      knowledge: [],
      tasks: [],
    });
    await started;
    await waitFor(() => spawns() === 1);
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(spawns(), 1);
  });

  it("unavailable memory fail-opens and still spawns when not cancelled", async () => {
    let spawns = 0;
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      bootstrapMemory: async () => {
        throw new Error("memory down");
      },
      runAgentFn: ({ onDone }) => {
        spawns += 1;
        setImmediate(() => onDone(0, "ok", ""));
        return { kill() {} };
      },
    });
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "hello" });
    await waitFor(() => spawns === 1);
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("follow-up turns skip bootstrapMemory and still spawn", async () => {
    let boots = 0;
    let spawns = 0;
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      bootstrapMemory: async () => {
        boots += 1;
        return {};
      },
      runAgentFn: ({ onDone }) => {
        spawns += 1;
        setImmediate(() => onDone(0, "ok", ""));
        return { kill() {} };
      },
    });
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, { sessionId: "sess-follow-up" });
    await runner.startRun({ threadId: thread.id, prompt: "again" });
    await waitFor(() => spawns === 1);
    assert.equal(boots, 0);
    await waitFor(() => store.getThread(thread.id).status === "done");
  });

  it("archive during prepare skips spawn without changing a later working archive policy", async () => {
    const { boot, spawns, thread } = makeRunner();
    const started = runner.startRun({
      threadId: thread.id,
      prompt: "first turn",
    });
    await waitFor(() => runner.isRunning(thread.id));
    services.setArchived(store, { threadId: thread.id, archived: true });
    boot.resolve({});
    await started;
    assert.equal(spawns(), 0);
    const live = store.getThread(thread.id);
    assert.equal(live.archived, true);
    assert.equal(live.status, "idle");
    assert.equal(runner.isRunning(thread.id), false);
  });
});
