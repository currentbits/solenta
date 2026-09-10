"use strict";

/**
 * Issue #1203: a failed or user-stopped turn must not auto-start a
 * queued follow-up. Successful done still drains. Retry of the failed
 * prompt must not consume the leftover via takeQueued.
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

function settle(ms = 250) {
  return new Promise((r) => setTimeout(r, ms));
}

function userTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "user")
    .map((m) => m.text);
}

function fakeAgentFailScript() {
  return "process.stderr.write('agent-stderr-line\\nmore-err');process.exit(3)";
}

function fakeAgentSuccessScript() {
  return "process.stdout.write('Hello');setTimeout(()=>{process.stdout.write('_ok');setTimeout(()=>process.exit(0),40)},40)";
}

function fakeAgentSlowScript() {
  return "setInterval(()=>{},500);setTimeout(()=>process.exit(0),60000)";
}

async function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-qdrain-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const core = await loadCore();
  const runner = createRunner({
    store,
    core,
    pushFn: () => {},
    tickMs: 15,
  });
  const repo = path.join(tmpDir, "app");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Queue Drain",
  });
  return { tmpDir, store, runner, thread };
}

function restoreEnv(prevSimulate, prevAgentCmd) {
  if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
  else process.env.CODER_SIMULATE = prevSimulate;
  if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
  else process.env.CODER_AGENT_CMD = prevAgentCmd;
}

describe("queued drain after failed / stopped (#1203)", () => {
  let prevSimulate;
  let prevAgentCmd;
  let fx;

  beforeEach(() => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
  });

  afterEach(() => {
    if (fx) {
      fx.runner.stopAll();
      fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      fx = null;
    }
    restoreEnv(prevSimulate, prevAgentCmd);
  });

  it("a successful done still drains the queued follow-up", async () => {
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "queued follow-up",
    });

    await waitFor(() => {
      const users = userTexts(store, thread.id);
      return (
        users.includes("queued follow-up") &&
        store.getThread(thread.id).queued == null
      );
    });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.deepEqual(userTexts(store, thread.id), [
      "first turn",
      "queued follow-up",
    ]);
    assert.equal(store.getThread(thread.id).queued, null);
  });

  it("sim stop leaves the queued follow-up parked", async () => {
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "queued follow-up",
    });
    await waitFor(() => runner.isRunning(thread.id));
    await runner.stopRun({ threadId: thread.id });
    await settle();

    const live = store.getThread(thread.id);
    assert.notEqual(live.status, "working");
    assert.equal(live.queued && live.queued.prompt, "queued follow-up");
    assert.deepEqual(userTexts(store, thread.id), ["first turn"]);
  });

  it("provider fail leaves the queued follow-up parked", async () => {
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "queued follow-up",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    await settle();

    const live = store.getThread(thread.id);
    assert.equal(live.status, "failed");
    assert.equal(live.queued && live.queued.prompt, "queued follow-up");
    assert.deepEqual(userTexts(store, thread.id), ["first turn"]);
  });

  it("real-agent stop leaves the queued follow-up parked", async () => {
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "queued follow-up",
    });
    await waitFor(() => store.getThread(thread.id).status === "working");
    await settle(80);
    await runner.stopRun({ threadId: thread.id });
    await settle();

    const live = store.getThread(thread.id);
    assert.notEqual(live.status, "working");
    assert.equal(live.queued && live.queued.prompt, "queued follow-up");
    assert.deepEqual(userTexts(store, thread.id), ["first turn"]);
  });

  it("retry with fromQueue does not consume the leftover follow-up", async () => {
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "queued follow-up",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    await settle();
    assert.equal(
      store.getThread(thread.id).queued &&
        store.getThread(thread.id).queued.prompt,
      "queued follow-up",
    );

    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;
    await runner.startRun({
      threadId: thread.id,
      prompt: "first turn",
      fromQueue: true,
    });
    await waitFor(() => store.getThread(thread.id).status === "working");

    const live = store.getThread(thread.id);
    assert.equal(live.queued && live.queued.prompt, "queued follow-up");
    assert.deepEqual(userTexts(store, thread.id), [
      "first turn",
      "first turn",
    ]);
    assert.ok(
      !userTexts(store, thread.id).includes("queued follow-up"),
      "retry must not fold the leftover into the prompt",
    );

    await runner.stopRun({ threadId: thread.id });
  });

  it("a later successful run still drains the parked follow-up", async () => {
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    services.setQueued(store, {
      threadId: thread.id,
      prompt: "queued follow-up",
    });
    await waitFor(() => store.getThread(thread.id).status === "failed");
    await settle();
    assert.equal(
      store.getThread(thread.id).queued &&
        store.getThread(thread.id).queued.prompt,
      "queued follow-up",
    );

    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;
    await runner.startRun({
      threadId: thread.id,
      prompt: "first turn",
      fromQueue: true,
    });
    await waitFor(() => {
      const users = userTexts(store, thread.id);
      return (
        users.includes("queued follow-up") &&
        store.getThread(thread.id).queued == null
      );
    });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.deepEqual(userTexts(store, thread.id), [
      "first turn",
      "first turn",
      "queued follow-up",
    ]);
  });
});
