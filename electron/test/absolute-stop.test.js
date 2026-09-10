"use strict";

/**
 * Remaining #315: Stop and thread-settle must kill this thread's leftover
 * Solenta-managed dev server. Settling a parent must not reap a live crew
 * worker (Stop still cascades; that contract lives in runner.test.js).
 *
 * Run: node --test electron/test/absolute-stop.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");

{
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        ipcMain: { handle() {} },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        shell: {},
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
}

const ipc = require("../ipc.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { start, stop, status } = require("../devservers.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const startAt = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - startAt > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Real sleeper so status().running is true and stop() has a pid to kill. */
function liveSpawn() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return child;
}

function startLiveServer(threadId, root) {
  const state = start(threadId, root, "dev", { spawn: liveSpawn });
  assert.equal(state.running, true, "fixture server must be running");
  assert.ok(status(threadId).running);
  return state;
}

describe("#315 absolute stop leftover sidecars", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  /** @type {string[]} */
  const started = [];

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-abs-stop-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ scripts: { dev: "node -e 'setInterval(()=>{},1000)'" } }),
    );
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "Parent",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    for (const id of started.splice(0)) {
      try {
        stop(id);
      } catch {
        // ignore
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  function repoRoot() {
    return path.join(tmpDir, "app");
  }

  it("settling a thread stops its leftover devserver and leaves others running", async () => {
    const a = store.getThreads()[0];
    const b = services.createThread(store, {
      projectId: a.projectId,
      title: "Other",
    });
    started.push(a.id, b.id);
    startLiveServer(a.id, repoRoot());
    startLiveServer(b.id, repoRoot());

    const ctx = ipc.makeCtx({
      dialog: {},
      store,
      runner,
      broadcast() {},
      worktreeBase: "",
      userDataPath: tmpDir,
    });
    await ipc.IPC_HANDLERS["threads:setSettled"](ctx, {
      threadId: a.id,
      override: "settled",
    });

    assert.equal(
      status(a.id).running,
      false,
      "settled thread must not leave a leftover server",
    );
    assert.equal(
      status(b.id).running,
      true,
      "settling one thread must not touch another thread's server",
    );
  });

  it("stopRun stops this thread's leftover devserver even when idle", async () => {
    const thread = store.getThreads()[0];
    started.push(thread.id);
    startLiveServer(thread.id, repoRoot());
    assert.equal(runner.isRunning(thread.id), false);

    await runner.stopRun({ threadId: thread.id });

    assert.equal(
      status(thread.id).running,
      false,
      "user Stop must kill the leftover server",
    );
  });

  it("settling an orchestrator does not stop a live crew worker", async () => {
    const orch = store.getThreads()[0];
    store.updateThread(orch.id, { title: "Orchestrator" });
    const worker = services.forkThread(store, { threadId: orch.id });
    store.updateThread(worker.id, { orchWorker: true, title: "Worker A" });
    store.saveNow();

    await runner.startRun({ threadId: worker.id, prompt: "worker task" });
    assert.equal(runner.isRunning(worker.id), true);

    const ctx = ipc.makeCtx({
      dialog: {},
      store,
      runner,
      broadcast() {},
      worktreeBase: "",
      userDataPath: tmpDir,
    });
    await ipc.IPC_HANDLERS["threads:setSettled"](ctx, {
      threadId: orch.id,
      override: "settled",
    });

    assert.equal(
      runner.isRunning(worker.id),
      true,
      "settle must not reap a live crew worker",
    );
    assert.equal(store.getThread(worker.id).status, "working");
    await runner.stopRun({ threadId: worker.id });
  });
});
