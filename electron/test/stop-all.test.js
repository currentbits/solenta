"use strict";

/**
 * "Stop all running threads" (issue #1778): one IPC round trip
 * (runs:stopAll, electron/ipc-runs.js) stops every active run via
 * runner.listActiveThreadIds() + runner.stopRun, same as clicking Stop on
 * each thread individually.
 *
 * Run: node --test electron/test/stop-all.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const ipcRuns = require("../ipc-runs.js");
const { rmTree } = require("./support/rmTree.js");

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

/** Lingers until killed; no whitespace (CODER_AGENT_CMD splits on it). */
function fakeAgentSlowScript() {
  return "setInterval(()=>{},500);setTimeout(()=>process.exit(0),60000)";
}

describe("runs:stopAll", () => {
  let tmpDir;
  let store;
  let runner;
  let prevAgentCmd;

  beforeEach(async () => {
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-stopall-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "Thread A" });
    services.createThread(store, { projectId: project.id, title: "Thread B" });
    services.createThread(store, { projectId: project.id, title: "Thread C" });
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
  });

  it("stops every active run, leaves an untouched thread alone, and reports the count", async () => {
    const [a, b, c] = store.getThreads();

    await runner.startRun({ threadId: a.id, prompt: "work A" });
    await runner.startRun({ threadId: b.id, prompt: "work B" });
    // c is never started: a plain idle thread must not be touched.

    await waitFor(() => {
      const ta = store.getThread(a.id);
      const tb = store.getThread(b.id);
      return ta.status === "working" && tb.status === "working";
    });

    assert.deepEqual(
      new Set(runner.listActiveThreadIds()),
      new Set([a.id, b.id]),
    );

    const result = await ipcRuns["runs:stopAll"]({ runner });
    assert.deepEqual(result, { stopped: 2 });

    assert.deepEqual(runner.listActiveThreadIds(), []);
    assert.equal(store.getThread(a.id).status, "idle");
    assert.equal(store.getThread(b.id).status, "idle");
    // Thread C was never running; stopAll must not have touched it.
    assert.equal(store.getThread(c.id).status, "idle");
    assert.equal(store.getThread(c.id).stoppedAt, null);
  });

  it("is a no-op when nothing is running", async () => {
    const result = await ipcRuns["runs:stopAll"]({ runner });
    assert.deepEqual(result, { stopped: 0 });
  });
});
