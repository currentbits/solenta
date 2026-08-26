"use strict";

// Thread/project/run/app lifecycle cleanup for the simulator service (#248).
// Everything platform- or process-specific is injected, so this file runs
// unchanged on macOS, Linux, and Windows with no Xcode present.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const ipc = require("../ipc.js");
const { createIOSSimulatorService } = require("../ios-simulator.js");

const DEVICE_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const DEV_DIR = "/Applications/Xcode.app/Contents/Developer";

const SIMCTL_LIST = {
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      name: "iOS 26.0",
      isAvailable: true,
    },
  ],
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      {
        udid: DEVICE_UDID,
        name: "iPhone 17",
        state: "Shutdown",
        isAvailable: true,
      },
    ],
  },
};

/** @type {string[]} */
let tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function cleanupTmpDirs() {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
}

async function settleAsync(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function journalPath(userDataPath) {
  return path.join(userDataPath, "ios-simulator-lease.json");
}

function readJournal(userDataPath) {
  return JSON.parse(fs.readFileSync(journalPath(userDataPath), "utf8"));
}

function journalExists(userDataPath) {
  return fs.existsSync(journalPath(userDataPath));
}

function mp4Fixture() {
  const body = Buffer.alloc(96);
  body.writeUInt32BE(1000, 12);
  body.writeUInt32BE(2000, 16);
  const mvhd = Buffer.alloc(8 + body.length);
  mvhd.writeUInt32BE(8 + body.length, 0);
  mvhd.write("mvhd", 4, 4);
  body.copy(mvhd, 8);
  const moov = Buffer.alloc(8 + mvhd.length);
  moov.writeUInt32BE(8 + mvhd.length, 0);
  moov.write("moov", 4, 4);
  mvhd.copy(moov, 8);
  const ftypBody = Buffer.alloc(12);
  ftypBody.write("isom", 0, 4);
  ftypBody.write("isom", 8, 4);
  const ftyp = Buffer.alloc(8 + ftypBody.length);
  ftyp.writeUInt32BE(8 + ftypBody.length, 0);
  ftyp.write("ftyp", 4, 4);
  ftypBody.copy(ftyp, 8);
  return Buffer.concat([ftyp, moov]);
}

/** Two projects so releaseProject can be shown to be project-scoped. */
function makeLeaseStore() {
  const projects = {
    p1: { id: "p1", slug: "owner/repo", name: "repo", path: "/tmp/repo" },
    p2: { id: "p2", slug: "owner/other", name: "other", path: "/tmp/other" },
  };
  const threads = {
    t1: { id: "t1", projectId: "p1", title: "One" },
    t2: { id: "t2", projectId: "p1", title: "Two" },
    t9: { id: "t9", projectId: "p2", title: "Other project" },
  };
  return {
    getThread: (id) => threads[id] ?? null,
    getProject: (id) => projects[id] ?? null,
  };
}

function makeAdapter(overrides = {}) {
  /** @type {Array<string | string[]>} */
  const calls = [];
  const adapter = {
    activeDeveloperDir: async () => {
      calls.push("activeDeveloperDir");
      return `${DEV_DIR}\n`;
    },
    xcodeVersion: async (developerDir) => {
      calls.push(["xcodeVersion", developerDir]);
      return "Xcode 26.0\nBuild version 17A123\n";
    },
    firstLaunchStatus: async (developerDir) => {
      calls.push(["firstLaunchStatus", developerDir]);
      return "";
    },
    findSimctl: async (developerDir) => {
      calls.push(["findSimctl", developerDir]);
      return "/usr/bin/simctl";
    },
    listDevices: async (developerDir) => {
      calls.push(["listDevices", developerDir]);
      return JSON.stringify(SIMCTL_LIST);
    },
    readBundleId: async () => "com.example.App\n",
    install: async () => "",
    boot: async (developerDir, udid) => {
      calls.push(["boot", developerDir, udid]);
      return "";
    },
    bootStatus: async (developerDir, udid) => {
      calls.push(["bootStatus", developerDir, udid]);
      return "";
    },
    shutdown: async (developerDir, udid) => {
      calls.push(["shutdown", developerDir, udid]);
      if (overrides.shutdownGate) await overrides.shutdownGate;
      if (overrides.shutdownError) throw overrides.shutdownError;
      return "";
    },
    // Erasing a device is not part of any cleanup path; a call here is a bug.
    erase: async (developerDir, udid) => {
      calls.push(["erase", developerDir, udid]);
      return "";
    },
    launch: async () => "com.example.App: 4321\n",
    openUrl: async () => "",
    screenshot: async (developerDir, udid, output) => {
      calls.push(["screenshot", developerDir, udid, output]);
      await fs.promises.writeFile(output, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return "";
    },
    recordVideo: (developerDir, udid, output) => {
      calls.push(["recordVideo", developerDir, udid, output]);
      return overrides.recordVideo(developerDir, udid, output);
    },
    inspectProcess: async () => "",
  };
  return { adapter, calls };
}

/**
 * Fake `simctl io recordVideo` handle: SIGINT writes the MP4 and resolves
 * `closed`, exactly like the real recorder.
 */
function makeRecorder({ pid = 5150 } = {}) {
  const state = { started: 0, interrupts: 0, outputPath: null };
  const recordVideo = (_developerDir, _udid, output) => {
    state.started += 1;
    state.outputPath = output;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    return Object.freeze({
      pid,
      closed,
      interrupt() {
        state.interrupts += 1;
        void fs.promises
          .writeFile(output, mp4Fixture())
          .then(() => resolveClosed({ code: 0, signal: null }));
      },
    });
  };
  return { state, recordVideo };
}

function makeFakeArtifactStore() {
  const dir = makeTmpDir("ios-lifecycle-art-");
  const stageCalls = [];
  const commitCalls = [];
  const discardCalls = [];
  let n = 0;
  return {
    stageCalls,
    commitCalls,
    discardCalls,
    async stage(opts) {
      n += 1;
      stageCalls.push(opts);
      return { token: `token-${n}`, path: path.join(dir, `staged-${n}.bin`) };
    },
    async commitBatch(batch) {
      commitCalls.push(batch);
      return batch.items.map((item, index) => ({
        id: `artifact-${commitCalls.length}-${index}`,
        threadId: batch.threadId,
        runId: batch.runId ?? null,
        kind: item.kind,
        mimeType: item.mimeType,
        name: item.name,
      }));
    },
    async discard(token) {
      discardCalls.push(token);
    },
  };
}

/** Manual virtual timers: nothing fires unless a test asks for it. */
function makeFakeTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimer(fn, ms) {
      nextId += 1;
      pending.set(nextId, { fn, at: ms });
      return nextId;
    },
    clearTimer(id) {
      if (id != null) pending.delete(id);
    },
    pendingCount: () => pending.size,
  };
}

function makeHarness(deps = {}) {
  const userDataPath = makeTmpDir("ios-lifecycle-");
  const recorder = deps.recorder ?? makeRecorder();
  const { adapter, calls } = makeAdapter({
    recordVideo: recorder.recordVideo,
    ...deps.adapterOverrides,
  });
  const artifactStore = makeFakeArtifactStore();
  const timers = makeFakeTimers();
  /** @type {string[]} */
  const warnings = [];
  const service = createIOSSimulatorService({
    store: makeLeaseStore(),
    userDataPath,
    worktreeBase: path.join(userDataPath, "worktrees"),
    platform: "darwin",
    processAdapter: adapter,
    artifactStore,
    randomUUID: (() => {
      let i = 0;
      return () => {
        i += 1;
        return `uuid-${i}`;
      };
    })(),
    logger: { warn: (msg) => warnings.push(String(msg)) },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    signalPid: () => {},
  });
  return {
    service,
    calls,
    recorder,
    artifactStore,
    timers,
    warnings,
    userDataPath,
  };
}

async function attachedHarness(deps = {}) {
  const harness = makeHarness(deps);
  const attached = await harness.service.attach({
    threadId: deps.threadId ?? "t1",
    deviceUdid: DEVICE_UDID,
  });
  return { ...harness, generation: attached.generation };
}

async function bootedHarness(deps = {}) {
  const harness = await attachedHarness(deps);
  await harness.service.boot({
    threadId: deps.threadId ?? "t1",
    generation: harness.generation,
  });
  return harness;
}

function adapterCallNames(calls) {
  return calls.map((call) => (Array.isArray(call) ? call[0] : call));
}

describe("createIOSSimulatorService releaseThread", () => {
  afterEach(cleanupTmpDirs);

  it("stops the recording, shuts down a device it booted, and clears the journal", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const result = await harness.service.releaseThread({ threadId: "t1" });
    assert.equal(result.released, true);
    assert.equal(result.stoppedRecording, true);
    assert.equal(result.shutDownDevice, true);
    assert.equal(result.journalCleared, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.artifactStore.commitCalls.length, 1);
    assert.equal(journalExists(harness.userDataPath), false);
    assert.equal(adapterCallNames(harness.calls).includes("erase"), false);
    const status = await harness.service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, false);
    assert.equal(harness.timers.pendingCount(), 0);
  });

  it("leaves another thread's lease and recording untouched", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const result = await harness.service.releaseThread({ threadId: "t2" });
    assert.equal(result.released, false);
    assert.equal(harness.recorder.state.interrupts, 0);
    assert.equal(
      adapterCallNames(harness.calls).filter((n) => n === "shutdown").length,
      0,
    );
    assert.equal(readJournal(harness.userDataPath).ownerThreadId, "t1");
    const stopped = await harness.service.stopRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    assert.ok(stopped.video);
  });

  it("never shuts down or erases a device it did not boot", async () => {
    const harness = await attachedHarness();
    const result = await harness.service.releaseThread({ threadId: "t1" });
    assert.equal(result.released, true);
    assert.equal(result.shutDownDevice, false);
    const names = adapterCallNames(harness.calls);
    assert.equal(names.includes("shutdown"), false);
    assert.equal(names.includes("erase"), false);
    assert.equal(journalExists(harness.userDataPath), false);
  });

  it("revokes ownership synchronously before its first await", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "r1",
    });
    const release = harness.service.releaseThread({ threadId: "t1" });
    // Same tick as the release call: the stale owner must already be gone.
    await assert.rejects(
      harness.service.stopRecording({
        threadId: "t1",
        generation: harness.generation,
      }),
      (err) => err.code === "lease_stale",
    );
    await assert.rejects(
      harness.service.boot({ threadId: "t1", generation: harness.generation }),
      (err) => err.code === "lease_stale",
    );
    const result = await release;
    assert.equal(result.released, true);
    assert.equal(result.stoppedRecording, true);
  });

  it("retains the journal when the device shutdown fails", async () => {
    const harness = await bootedHarness({
      adapterOverrides: { shutdownError: new Error("Operation not permitted") },
    });
    const result = await harness.service.releaseThread({ threadId: "t1" });
    assert.equal(result.released, true);
    assert.equal(result.shutDownDevice, false);
    assert.equal(result.journalCleared, false);
    assert.equal(journalExists(harness.userDataPath), true);
    assert.equal(readJournal(harness.userDataPath).bootedBySolenta, true);
    for (const message of harness.warnings) {
      assert.equal(message.includes(harness.userDataPath), false);
      assert.equal(message.includes("Operation not permitted"), false);
    }
  });

  it("does not clear a journal a new owner wrote while cleanup was running", async () => {
    let openGate = () => {};
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const harness = await bootedHarness({
      adapterOverrides: { shutdownGate: gate },
    });
    const release = harness.service.releaseThread({ threadId: "t1" });
    await settleAsync();
    const attached = await harness.service.attach({
      threadId: "t2",
      deviceUdid: DEVICE_UDID,
    });
    openGate();
    const result = await release;
    assert.equal(result.released, true);
    assert.equal(result.journalCleared, false);
    assert.equal(journalExists(harness.userDataPath), true);
    const journal = readJournal(harness.userDataPath);
    assert.equal(journal.ownerThreadId, "t2");
    assert.equal(journal.generation, attached.generation);
  });

  it("ignores a missing thread id and never rejects", async () => {
    const harness = await attachedHarness();
    const result = await harness.service.releaseThread({});
    assert.equal(result.released, false);
    assert.equal(journalExists(harness.userDataPath), true);
  });
});

describe("createIOSSimulatorService releaseProject", () => {
  afterEach(cleanupTmpDirs);

  it("releases a lease held by a thread in that project", async () => {
    const harness = await bootedHarness();
    const result = await harness.service.releaseProject({ projectId: "p1" });
    assert.equal(result.released, true);
    assert.equal(result.shutDownDevice, true);
    assert.equal(journalExists(harness.userDataPath), false);
  });

  it("ignores a lease owned by a different project", async () => {
    const harness = await bootedHarness();
    const result = await harness.service.releaseProject({ projectId: "p2" });
    assert.equal(result.released, false);
    assert.equal(readJournal(harness.userDataPath).ownerProjectId, "p1");
    assert.equal(
      adapterCallNames(harness.calls).filter((n) => n === "shutdown").length,
      0,
    );
  });
});

describe("createIOSSimulatorService onRunTerminal", () => {
  afterEach(cleanupTmpDirs);

  it("stops the matching run's recording and keeps the lease attached", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "run-1",
    });
    const result = await harness.service.onRunTerminal({
      threadId: "t1",
      runId: "run-1",
      status: "done",
    });
    assert.equal(result.stopped, true);
    assert.equal(harness.recorder.state.interrupts, 1);
    assert.equal(harness.artifactStore.commitCalls.length, 1);
    const status = await harness.service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, true);
    assert.equal(status.isOwner, true);
    assert.equal(journalExists(harness.userDataPath), true);
    assert.equal(
      adapterCallNames(harness.calls).filter((n) => n === "shutdown").length,
      0,
    );
  });

  it("leaves another run's recording running", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "run-1",
    });
    const result = await harness.service.onRunTerminal({
      threadId: "t1",
      runId: "run-2",
      status: "done",
    });
    assert.equal(result.stopped, false);
    assert.equal(harness.recorder.state.interrupts, 0);
    assert.equal(harness.artifactStore.commitCalls.length, 0);
  });

  it("leaves a manual recording with no run id alone", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
    });
    for (const runId of ["run-1", null, ""]) {
      const result = await harness.service.onRunTerminal({
        threadId: "t1",
        runId,
        status: "stopped",
      });
      assert.equal(result.stopped, false);
    }
    assert.equal(harness.recorder.state.interrupts, 0);
  });

  it("leaves a recording owned by another thread alone", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "run-1",
    });
    const result = await harness.service.onRunTerminal({
      threadId: "t2",
      runId: "run-1",
      status: "failed",
    });
    assert.equal(result.stopped, false);
    assert.equal(harness.recorder.state.interrupts, 0);
  });

  it("is a no-op with no recording and never rejects", async () => {
    const harness = await bootedHarness();
    const result = await harness.service.onRunTerminal({
      threadId: "t1",
      runId: "run-1",
      status: "done",
    });
    assert.equal(result.stopped, false);
    const status = await harness.service.getStatus({ threadId: "t1" });
    assert.equal(status.attached, true);
  });

  it("revokes the matching recording synchronously before its first await", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "run-1",
    });
    const terminal = harness.service.onRunTerminal({
      threadId: "t1",
      runId: "run-1",
      status: "done",
    });
    // The recorder was already interrupted without yielding to the event loop.
    assert.equal(harness.recorder.state.interrupts, 1);
    await terminal;
  });
});

describe("createIOSSimulatorService shutdown", () => {
  afterEach(cleanupTmpDirs);

  it("finalizes the recording, releases the device, and clears the journal", async () => {
    const harness = await bootedHarness();
    await harness.service.startRecording({
      threadId: "t1",
      generation: harness.generation,
      runId: "run-1",
    });
    const result = await harness.service.shutdown();
    assert.equal(result.released, true);
    assert.equal(result.stoppedRecording, true);
    assert.equal(result.shutDownDevice, true);
    assert.equal(result.journalCleared, true);
    assert.equal(harness.artifactStore.commitCalls.length, 1);
    assert.equal(journalExists(harness.userDataPath), false);
    assert.equal(adapterCallNames(harness.calls).includes("erase"), false);
  });

  it("is idempotent and shares one promise", async () => {
    const harness = await bootedHarness();
    const first = harness.service.shutdown();
    const second = harness.service.shutdown();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    const third = await harness.service.shutdown();
    assert.deepEqual(third, a);
    assert.equal(
      adapterCallNames(harness.calls).filter((n) => n === "shutdown").length,
      1,
    );
  });

  it("resolves without a lease", async () => {
    const harness = makeHarness();
    const result = await harness.service.shutdown();
    assert.equal(result.released, false);
    assert.equal(result.shutDownDevice, false);
  });
});

// ---------------------------------------------------------------------------
// Durable thread/project lifecycle: release only after the metadata landed.
// ---------------------------------------------------------------------------

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function makeSimulatorSpy(overrides = {}) {
  const calls = [];
  return {
    calls,
    async releaseThread(input) {
      calls.push(["releaseThread", input.threadId]);
      if (overrides.releaseThreadError) throw overrides.releaseThreadError;
      return Object.freeze({ released: true });
    },
    async releaseProject(input) {
      calls.push(["releaseProject", input.projectId]);
      if (overrides.releaseProjectError) throw overrides.releaseProjectError;
      return Object.freeze({ released: true });
    },
    onRunTerminal(input) {
      calls.push(["onRunTerminal", input.threadId, input.runId, input.status]);
      return Promise.resolve(Object.freeze({ stopped: false }));
    },
    async shutdown() {
      calls.push(["shutdown"]);
      return Object.freeze({ released: false });
    },
  };
}

async function lifecycleCtx(deps = {}) {
  const tmp = makeTmpDir("ios-lifecycle-ipc-");
  const store = new Store(path.join(tmp, "store.json"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "alpha",
  });
  const simulator = deps.simulator ?? makeSimulatorSpy();
  /** @type {string[]} */
  const logs = [];
  const ctx = ipc.makeCtx({
    dialog: {},
    store,
    runner: {
      isRunning: deps.isRunning ?? (() => false),
      disposeClaudeSession: () => {},
    },
    broadcast: () => {},
    worktreeBase: "",
    userDataPath: tmp,
    getIosSimulator: () => simulator,
    log: (msg) => logs.push(String(msg)),
  });
  return { ctx, store, project, thread, simulator, logs, tmp };
}

describe("thread lifecycle releases simulator ownership", () => {
  afterEach(cleanupTmpDirs);

  it("releases the thread after a successful archive", async () => {
    const { ctx, simulator, thread } = await lifecycleCtx();
    await ipc.IPC_HANDLERS["threads:setArchived"](ctx, {
      threadId: thread.id,
      archived: true,
    });
    assert.deepEqual(simulator.calls, [["releaseThread", thread.id]]);
  });

  it("does not release when a thread is unarchived", async () => {
    const { ctx, simulator, thread } = await lifecycleCtx();
    await ipc.IPC_HANDLERS["threads:setArchived"](ctx, {
      threadId: thread.id,
      archived: false,
    });
    assert.deepEqual(simulator.calls, []);
  });

  it("releases the thread after a successful delete", async () => {
    const { ctx, simulator, store, thread } = await lifecycleCtx();
    await ipc.IPC_HANDLERS["threads:delete"](ctx, { threadId: thread.id });
    assert.equal(store.getThread(thread.id), null);
    assert.deepEqual(simulator.calls, [["releaseThread", thread.id]]);
  });

  it("does not release when the delete is refused", async () => {
    const { ctx, simulator, store, thread } = await lifecycleCtx({
      isRunning: () => true,
    });
    await assert.rejects(
      ipc.IPC_HANDLERS["threads:delete"](ctx, { threadId: thread.id }),
      /Cannot delete thread while a run is active/,
    );
    assert.ok(store.getThread(thread.id));
    assert.deepEqual(simulator.calls, []);
  });

  it("keeps a completed delete successful when the release fails", async () => {
    const simulator = makeSimulatorSpy({
      releaseThreadError: new Error("simulator exploded"),
    });
    const { ctx, store, thread, logs } = await lifecycleCtx({ simulator });
    await ipc.IPC_HANDLERS["threads:delete"](ctx, { threadId: thread.id });
    assert.equal(store.getThread(thread.id), null);
    await flushRelease();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /ios-simulator/);
    assert.equal(logs[0].includes("simulator exploded"), false);
  });

  it("releases the project after a successful removal", async () => {
    const { ctx, simulator, store, project } = await lifecycleCtx();
    await ipc.IPC_HANDLERS["projects:remove"](ctx, { projectId: project.id });
    assert.equal(store.getProject(project.id) ?? null, null);
    assert.deepEqual(simulator.calls, [["releaseProject", project.id]]);
  });

  it("does not release when the project removal is refused", async () => {
    const { ctx, simulator, store, project } = await lifecycleCtx({
      isRunning: () => true,
    });
    await assert.rejects(
      ipc.IPC_HANDLERS["projects:remove"](ctx, { projectId: project.id }),
      /Cannot remove a project while a run is active/,
    );
    assert.ok(store.getProject(project.id));
    assert.deepEqual(simulator.calls, []);
  });

  it("works with no simulator service wired in", async () => {
    const { ctx, store, thread } = await lifecycleCtx({ simulator: null });
    await ipc.IPC_HANDLERS["threads:delete"](ctx, { threadId: thread.id });
    assert.equal(store.getThread(thread.id), null);
  });
});

/** Flush queued Promise.then/catch work so fire-and-forget release is observable. */
async function flushRelease() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("services durable paths release simulator ownership", () => {
  afterEach(cleanupTmpDirs);

  async function servicesFixture(simulatorOverrides = {}) {
    const tmp = makeTmpDir("ios-lifecycle-svc-");
    const store = new Store(path.join(tmp, "store.json"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "alpha",
    });
    const simulator = makeSimulatorSpy(simulatorOverrides);
    /** @type {string[]} */
    const logs = [];
    const opts = {
      getIosSimulator: () => simulator,
      log: (msg) => logs.push(String(msg)),
    };
    return { store, project, thread, simulator, logs, opts, tmp };
  }

  it("scheduleSimulatorRelease calls the method and swallows throws", async () => {
    const simulator = makeSimulatorSpy({
      releaseThreadError: new Error("boom secret token"),
    });
    /** @type {string[]} */
    const logs = [];
    await services.scheduleSimulatorRelease(
      { getIosSimulator: () => simulator, log: (m) => logs.push(String(m)) },
      "releaseThread",
      { threadId: "t-x" },
    );
    assert.deepEqual(simulator.calls, [["releaseThread", "t-x"]]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /ios-simulator: releaseThread cleanup failed/);
    assert.equal(logs[0].includes("boom secret token"), false);
  });

  it("scheduleSimulatorRelease is a no-op without a simulator", async () => {
    await services.scheduleSimulatorRelease(
      { getIosSimulator: () => null },
      "releaseThread",
      { threadId: "t-x" },
    );
  });

  it("setArchived releases only when archived is true", async () => {
    const { store, thread, simulator, opts } = await servicesFixture();
    services.setArchived(
      store,
      { threadId: thread.id, archived: true },
      opts,
    );
    await flushRelease();
    assert.deepEqual(simulator.calls, [["releaseThread", thread.id]]);

    simulator.calls.length = 0;
    services.setArchived(
      store,
      { threadId: thread.id, archived: false },
      opts,
    );
    await flushRelease();
    assert.deepEqual(simulator.calls, []);
  });

  it("setArchived stays sync and succeeds when release throws", async () => {
    const { store, thread, opts, logs } = await servicesFixture({
      releaseThreadError: new Error("simulator exploded"),
    });
    const updated = services.setArchived(
      store,
      { threadId: thread.id, archived: true },
      opts,
    );
    assert.equal(updated.archived, true);
    assert.equal(store.getThread(thread.id).archived, true);
    await flushRelease();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes("simulator exploded"), false);
  });

  it("deleteThread releases after a successful purge", async () => {
    const { store, thread, simulator, opts } = await servicesFixture();
    services.deleteThread(store, { threadId: thread.id }, opts);
    assert.equal(store.getThread(thread.id), null);
    await flushRelease();
    assert.deepEqual(simulator.calls, [["releaseThread", thread.id]]);
  });

  it("deleteThread does not release when refused for an active run", async () => {
    const { store, thread, simulator, opts } = await servicesFixture();
    assert.throws(
      () =>
        services.deleteThread(store, { threadId: thread.id }, {
          ...opts,
          isRunning: () => true,
        }),
      /Cannot delete thread while a run is active/,
    );
    assert.ok(store.getThread(thread.id));
    await flushRelease();
    assert.deepEqual(simulator.calls, []);
  });

  it("removeProject releases after a successful removal", async () => {
    const { store, project, simulator, opts } = await servicesFixture();
    await services.removeProject(store, { projectId: project.id }, opts);
    assert.equal(store.getProject(project.id) ?? null, null);
    await flushRelease();
    assert.deepEqual(simulator.calls, [["releaseProject", project.id]]);
  });

  it("removeProject does not release when refused for an active run", async () => {
    const { store, project, simulator, opts } = await servicesFixture();
    await assert.rejects(
      () =>
        services.removeProject(store, { projectId: project.id }, {
          ...opts,
          isRunning: () => true,
        }),
      /Cannot remove a project while a run is active/,
    );
    assert.ok(store.getProject(project.id));
    await flushRelease();
    assert.deepEqual(simulator.calls, []);
  });
});

describe("runner run terminal notifies the simulator", () => {
  let runner = null;
  let prevSimulate;
  let prevAgentCmd;

  afterEach(() => {
    if (runner) {
      try {
        runner.stopAll();
      } catch {
        // ignore
      }
      runner = null;
    }
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    cleanupTmpDirs();
  });

  async function runnerHarness(runAgentFn, simulatorOverride) {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    delete process.env.CODER_SIMULATE;
    // Generic path. The name is never spawned (runAgentFn is injected) and is
    // deliberately space-free so command parsing is identical on Windows.
    process.env.CODER_AGENT_CMD = "solenta-fake-agent";
    const tmp = makeTmpDir("ios-lifecycle-runner-");
    const store = new Store(path.join(tmp, "store.json"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "alpha" });
    const core = await loadCore();
    const simulator = simulatorOverride ?? makeSimulatorSpy();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: tmp,
      runAgentFn,
      getIosSimulator: () => simulator,
    });
    return { store, simulator, thread: store.getThreads()[0] };
  }

  function waitFor(predicate, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          if (predicate()) return resolve(undefined);
        } catch (err) {
          return reject(err);
        }
        if (Date.now() - start > timeoutMs) {
          return reject(new Error("waitFor timed out"));
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it("reports the run id and status when a run completes", async () => {
    const { store, simulator, thread } = await runnerHarness(({ onDone }) => {
      setImmediate(() => onDone(0, "all good", ""));
      return { kill() {} };
    });
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "go",
    });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const terminals = simulator.calls.filter((c) => c[0] === "onRunTerminal");
    assert.deepEqual(terminals, [["onRunTerminal", thread.id, runId, "done"]]);
  });

  it("still knows the run id when a stop already cleared the active run", async () => {
    const { simulator, thread } = await runnerHarness(({ onChunk }) => {
      setImmediate(() => onChunk("partial"));
      return { kill() {} };
    });
    const { runId } = await runner.startRun({
      threadId: thread.id,
      prompt: "go",
    });
    await waitFor(() => runner.isRunning(thread.id));
    await runner.stopRun({ threadId: thread.id });
    const terminals = simulator.calls.filter((c) => c[0] === "onRunTerminal");
    assert.deepEqual(terminals, [
      ["onRunTerminal", thread.id, runId, "stopped"],
    ]);
  });

  it("never lets a simulator failure break the run path", async () => {
    const exploding = {
      onRunTerminal() {
        throw new Error("simulator exploded");
      },
    };
    const { store, thread } = await runnerHarness(
      ({ onDone }) => {
        setImmediate(() => onDone(0, "all good", ""));
        return { kill() {} };
      },
      exploding,
    );
    await runner.startRun({ threadId: thread.id, prompt: "go" });
    await waitFor(() => store.getThread(thread.id).status === "done");
  });
});
