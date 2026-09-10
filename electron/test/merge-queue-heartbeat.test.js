/**
 * #346 heartbeat + recycle tick.
 *
 * heartbeatLane is already in mergeQueue.js. This suite covers the missing
 * CoderApi IPC, the runner/lead beat while a lane is claimed, and the
 * recycle tick that must not start until those beats exist. Recycle never
 * closes issues.
 *
 * Run: node --test electron/test/merge-queue-heartbeat.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");

const CHANNEL = "mergeQueue:heartbeatLane";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function stubElectron() {
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        BrowserWindow: { getAllWindows: () => [] },
        shell: {},
        nativeTheme: { themeSource: "system" },
        ipcMain: { handle() {} },
        dialog: {},
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
  return () => {
    Module._load = origLoad;
  };
}

describe("mergeQueue:heartbeatLane on CoderApi (#346)", () => {
  it("lists heartbeatLane on the CoderApi table", async () => {
    const { IPC_CHANNELS, ipcChannelName } = await import(
      pathToFileURL(path.join(__dirname, "../../src/shared/ipcChannels.ts")).href
    );
    const table = new Set(IPC_CHANNELS.map(ipcChannelName));
    assert.ok(table.has(CHANNEL), `IPC_CHANNELS missing ${CHANNEL}`);
  });

  it("registers a mergeQueue:heartbeatLane handler", () => {
    const unstub = stubElectron();
    try {
      delete require.cache[require.resolve("../ipc.js")];
      const { IPC_HANDLERS } = require("../ipc.js");
      assert.equal(typeof IPC_HANDLERS[CHANNEL], "function");
      assert.equal(
        typeof IPC_HANDLERS["mergeQueue:completeIssue"],
        "undefined",
        "must not add a second issue closer",
      );
    } finally {
      unstub();
    }
  });
});

describe("heartbeatLane IPC behavior (#346)", () => {
  let tmpDir;
  let store;
  let project;
  let ctx;
  let origComplete;
  let closed;
  let unstub;

  beforeEach(async () => {
    unstub = stubElectron();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mq-beat-"));
    const { Store } = require("../store.js");
    const services = require("../services.js");
    const issues = require("../issues.js");
    origComplete = issues.completeIssue;
    closed = [];
    issues.completeIssue = async (projectPath, number) => {
      closed.push({ projectPath, number });
      return { ok: true };
    };

    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Lane",
    });
    store.updateThread(thread.id, {
      issueNumber: 346,
      lane: { n: 1, port: 3001, claimedAt: 1, lastBeat: 1 },
    });
    store.save();
    ctx = { store, worktreeBase: path.join(tmpDir, "worktrees"), broadcast() {} };
  });

  afterEach(() => {
    const issues = require("../issues.js");
    issues.completeIssue = origComplete;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    unstub();
  });

  it("stamps lastBeat and does not close issues", async () => {
    delete require.cache[require.resolve("../ipc.js")];
    const { IPC_HANDLERS } = require("../ipc.js");
    const thread = store.getThreads()[0];
    const beat = await IPC_HANDLERS[CHANNEL](ctx, {
      threadId: thread.id,
      now: 9_000,
    });
    assert.equal(beat.n, 1);
    assert.equal(beat.lastBeat, 9_000);
    assert.equal(store.getThread(thread.id).lane.lastBeat, 9_000);
    assert.deepEqual(closed, []);
  });

  it("returns null when the thread has no lane", async () => {
    delete require.cache[require.resolve("../ipc.js")];
    const { IPC_HANDLERS } = require("../ipc.js");
    const services = require("../services.js");
    const bare = services.createThread(store, {
      projectId: project.id,
      title: "Bare",
    });
    const beat = await IPC_HANDLERS[CHANNEL](ctx, { threadId: bare.id });
    assert.equal(beat, null);
  });
});

describe("recycle tick after heartbeats (#346)", () => {
  it("createWedgedLaneWatchdog recycles wedged lanes and never closes issues", () => {
    const {
      createWedgedLaneWatchdog,
      DEFAULT_WEDGE_MS,
      WEDGE_WATCHDOG_INTERVAL_MS,
    } = require("../mergeQueue.js");
    assert.equal(DEFAULT_WEDGE_MS, 30 * 60 * 1000);
    assert.equal(WEDGE_WATCHDOG_INTERVAL_MS, DEFAULT_WEDGE_MS);

    const seen = [];
    const timers = {
      timeouts: [],
      intervals: [],
      setTimeoutFn: (fn, ms) => {
        const handle = { ms, fn, unref() {} };
        timers.timeouts.push(handle);
        return handle;
      },
      setIntervalFn: (fn, ms) => {
        const handle = { ms, fn, unref() {} };
        timers.intervals.push(handle);
        return handle;
      },
      clearTimeoutFn() {},
      clearIntervalFn() {},
    };
    const watchdog = createWedgedLaneWatchdog({
      store: { getProjects: () => [{ id: "p1" }] },
      now: () => 42,
      ...timers,
      recycleFn: (opts) => {
        seen.push(opts);
        return [];
      },
    });
    watchdog.start();
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, WEDGE_WATCHDOG_INTERVAL_MS);
    timers.intervals[0].fn();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].projectId, "p1");
    assert.equal(seen[0].now, 42);
    watchdog.stop();
  });

  it("recycle tick is wired in main and recycle bodies never close issues", () => {
    const src = fs.readFileSync(path.join(__dirname, "../mergeQueue.js"), "utf8");
    const recycleFn = src.slice(src.indexOf("function recycleWedgedLanes"));
    const recycleBody = recycleFn.slice(0, recycleFn.indexOf("\nfunction "));
    const watchdogFn = src.slice(src.indexOf("function createWedgedLaneWatchdog"));
    assert.equal(
      /completeIssue|completeThreadIssue/.test(recycleBody),
      false,
      "recycleWedgedLanes must not close issues",
    );
    assert.equal(
      /completeIssue|completeThreadIssue/.test(watchdogFn),
      false,
      "createWedgedLaneWatchdog must not close issues",
    );
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.match(main, /createWedgedLaneWatchdog/);
    assert.match(main, /wedgedLaneWatchdog\.start\(\)/);
    assert.match(main, /wedgedLaneWatchdog\.stop\(\)/);
  });
});

describe("runner heartbeats a claimed lane (#346)", () => {
  let tmpDir;
  let store;
  let runner;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e process.exit(0)`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-lane-beat-"));
    const { Store } = require("../store.js");
    const services = require("../services.js");
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "Lane thread",
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

  it("beats a claimed lane on startRun and while active, not after stop", async () => {
    const { createRunner } = require("../runner.js");
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, {
      lane: { n: 1, port: 3001, claimedAt: 0, lastBeat: 0 },
    });
    store.save();

    runner = createRunner({
      store,
      core: {
        createWorkflow() {
          return { id: "wf" };
        },
        tick(workflow) {
          return workflow;
        },
        isComplete() {
          return false;
        },
        isFailed() {
          return false;
        },
        isStuck() {
          return false;
        },
      },
      pushFn: () => {},
      tickMs: 15,
      now: () => 1_000,
      runAgentFn: () => ({ kill() {} }),
    });

    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    assert.equal(
      store.getThread(thread.id).lane.lastBeat,
      1_000,
      "startRun must heartbeat a claimed lane",
    );

    runner.heartbeatActiveLanes({ now: 5_000 });
    assert.equal(store.getThread(thread.id).lane.lastBeat, 5_000);

    await runner.stopRun({ threadId: thread.id });
    runner.heartbeatActiveLanes({ now: 9_000 });
    assert.equal(
      store.getThread(thread.id).lane.lastBeat,
      5_000,
      "stopped runs must not keep the lane alive",
    );
  });
});
