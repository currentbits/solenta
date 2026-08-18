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

function stallEvents(store, threadId) {
  return (store.getMessages(threadId) || []).filter(
    (m) =>
      m.role === "event" &&
      /No output from the .+ CLI for \d+ min/.test(String(m.text || "")),
  );
}

describe("turn watchdog + queued drain (issue #314)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let prevStallMs;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevStallMs = process.env.CODER_STALL_MS;
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_STALL_MS = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-stall-"));
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
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "Stall Thread",
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevStallMs === undefined) delete process.env.CODER_STALL_MS;
    else process.env.CODER_STALL_MS = prevStallMs;
  });

  it("flags a quiet working thread once and does not re-append", () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, {
      status: "working",
      runStartedAt: Date.now() - 60_000,
      lastEventAt: Date.now() - 60_000,
    });
    const updatedAt = store.getThread(thread.id).updatedAt;

    runner.checkStalls();
    const flagged = store.getThread(thread.id);
    assert.ok(flagged.stalledAt, "sweep must set stalledAt");
    assert.equal(stallEvents(store, thread.id).length, 1);

    runner.checkStalls();
    assert.equal(stallEvents(store, thread.id).length, 1);
    assert.equal(store.getThread(thread.id).stalledAt, flagged.stalledAt);
    // The event message is real activity; the stalledAt write itself is not.
    assert.ok(store.getThread(thread.id).updatedAt >= updatedAt);
  });

  it("does not flag a thread awaiting input", () => {
    const thread = store.getThreads()[0];
    store.updateThread(thread.id, {
      status: "working",
      awaitingInput: true,
      runStartedAt: Date.now() - 60_000,
      lastEventAt: Date.now() - 60_000,
    });
    runner.checkStalls();
    assert.equal(store.getThread(thread.id).stalledAt ?? null, null);
    assert.equal(stallEvents(store, thread.id).length, 0);
  });

  it("a fresh stream event clears stalledAt", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "keep going" });
    assert.ok(runner.isRunning(thread.id));

    store.updateThread(thread.id, {
      lastEventAt: Date.now() - 120_000,
    });
    runner.checkStalls();
    assert.ok(store.getThread(thread.id).stalledAt, "must flag before the next tick");

    await waitFor(() => store.getThread(thread.id).stalledAt == null, {
      timeoutMs: 4000,
    });
    assert.equal(store.getThread(thread.id).stalledAt, null);
    assert.ok(store.getThread(thread.id).lastEventAt > Date.now() - 5000);
  });

  it("a run terminal delivers a queued prompt exactly once", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "queued follow-up",
    });
    assert.equal(store.getThread(thread.id).queued.prompt, "queued follow-up");

    await waitFor(() => {
      const users = (store.getMessages(thread.id) || []).filter(
        (m) => m.role === "user" && m.text === "queued follow-up",
      );
      return users.length === 1 && store.getThread(thread.id).queued == null;
    });

    await waitFor(() => store.getThread(thread.id).status === "done");

    const users = (store.getMessages(thread.id) || []).filter(
      (m) => m.role === "user",
    );
    assert.deepEqual(
      users.map((m) => m.text),
      ["first turn", "queued follow-up"],
    );
    assert.equal(store.getThread(thread.id).queued, null);
  });

  it("a startRun that throws leaves the prompt queued with error", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "busy" });
    assert.ok(runner.isRunning(thread.id));

    services.setQueued(store, {
      threadId: thread.id,
      prompt: "hold this",
    });
    await runner.drainQueued(thread.id);

    const queued = store.getThread(thread.id).queued;
    assert.ok(queued, "prompt must stay queued");
    assert.equal(queued.prompt, "hold this");
    assert.ok(queued.error, "delivery error must be set");
    assert.match(queued.error, /already active/i);
  });
});
