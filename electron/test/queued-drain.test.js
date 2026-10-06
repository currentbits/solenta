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
const { rmTree } = require("./support/rmTree.js");

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

  afterEach(async () => {
    if (fx) {
      fx.runner.stopAll();
      await rmTree(fx.tmpDir);
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

function userRows(store, threadId) {
  return (store.getMessages(threadId) || []).filter((m) => m.role === "user");
}

function queueItems(store, threadId, items) {
  for (const prompt of items) services.setQueued(store, { threadId, prompt });
}

describe("queue drains one item per turn (#1501)", () => {
  let prevSimulate;
  let prevAgentCmd;
  let fx;

  beforeEach(() => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
  });

  afterEach(async () => {
    if (fx) {
      fx.runner.stopAll();
      await rmTree(fx.tmpDir);
      fx = null;
    }
    restoreEnv(prevSimulate, prevAgentCmd);
  });

  it("runs each queued item as its own turn, in order", async () => {
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    queueItems(store, thread.id, ["a", "b", "c"]);

    await waitFor(() => {
      const live = store.getThread(thread.id);
      return userTexts(store, thread.id).includes("c") && live.status === "done";
    });
    assert.deepEqual(userTexts(store, thread.id), ["first turn", "a", "b", "c"]);
    const runIds = userRows(store, thread.id).map((m) => m.runId);
    assert.equal(new Set(runIds).size, 4, "each item must be its own run");
    assert.equal(store.getThread(thread.id).queued, null);
  });

  it("a stop mid-queue keeps the rest queued", async () => {
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    queueItems(store, thread.id, ["a", "b", "c"]);
    // "a" spawns after the first turn lands, so it picks up the slow agent.
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSlowScript()}`;
    await waitFor(
      () =>
        userTexts(store, thread.id).includes("a") &&
        store.getThread(thread.id).status === "working",
    );
    await settle(80);
    await runner.stopRun({ threadId: thread.id });
    await settle();

    const live = store.getThread(thread.id);
    assert.notEqual(live.status, "working");
    assert.deepEqual(live.queued.items, ["b", "c"]);
    assert.equal(live.queued.prompt, "b\n\nc");
    assert.deepEqual(userTexts(store, thread.id), ["first turn", "a"]);
  });

  it("a failure mid-queue keeps the rest queued", async () => {
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    queueItems(store, thread.id, ["a", "b", "c"]);
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;
    await waitFor(
      () =>
        userTexts(store, thread.id).includes("a") &&
        store.getThread(thread.id).status === "failed",
    );
    await settle();

    const live = store.getThread(thread.id);
    assert.equal(live.status, "failed");
    assert.deepEqual(live.queued.items, ["b", "c"]);
    assert.deepEqual(userTexts(store, thread.id), ["first turn", "a"]);
  });

  it("a notice arriving mid-queue runs first and the queue resumes after it", async () => {
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    queueItems(store, thread.id, ["a", "b"]);
    runner.deliverNotice({ threadId: thread.id, line: "[peer from x] heads up" });

    await waitFor(() => {
      const live = store.getThread(thread.id);
      return userTexts(store, thread.id).includes("b") && live.status === "done";
    });
    const texts = userTexts(store, thread.id);
    const notice = texts.findIndex((t) => /heads up/.test(t));
    assert.ok(notice > 0, "the notice is delivered as its own turn");
    assert.ok(notice < texts.indexOf("a"), "the notice keeps priority over the queue");
    assert.deepEqual(
      texts.filter((t) => !/heads up/.test(t)),
      ["first turn", "a", "b"],
    );
    assert.equal(store.getThread(thread.id).queued, null);
    assert.notEqual(store.getThread(thread.id).status, "failed");
  });

  it("Send now on a parked queue resumes one item at a time", async () => {
    delete process.env.CODER_SIMULATE;
    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentFailScript()}`;
    fx = await makeFixture();
    const { store, runner, thread } = fx;

    await runner.startRun({ threadId: thread.id, prompt: "first turn" });
    queueItems(store, thread.id, ["a", "b"]);
    await waitFor(() => store.getThread(thread.id).status === "failed");
    await settle();
    assert.deepEqual(store.getThread(thread.id).queued.items, ["a", "b"]);

    process.env.CODER_AGENT_CMD = `${process.execPath} -e ${fakeAgentSuccessScript()}`;
    await runner.sendQueued({ threadId: thread.id });
    await waitFor(
      () =>
        userTexts(store, thread.id).includes("b") &&
        store.getThread(thread.id).status === "done",
    );
    assert.deepEqual(userTexts(store, thread.id), ["first turn", "a", "b"]);
    assert.equal(store.getThread(thread.id).queued, null);
  });
});

describe("takeQueuedHead / restoreQueuedHead (#1501)", () => {
  let tmpDir;
  afterEach(async () => {
    if (tmpDir) await rmTree(tmpDir);
    tmpDir = null;
  });

  async function storeWithThread() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-qhead-"));
    const store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id });
    return { store, threadId: thread.id };
  }

  it("takes the head with the attachments and leaves the rest", async () => {
    const { store, threadId } = await storeWithThread();
    const shot = { kind: "image", path: "/tmp/x.png", name: "x.png" };
    services.setQueued(store, { threadId, prompt: "a", attachments: [shot] });
    services.setQueued(store, { threadId, prompt: "b" });
    const head = services.takeQueuedHead(store, { threadId });
    assert.equal(head.prompt, "a");
    assert.deepEqual(head.attachments, [shot]);
    const rest = store.getThread(threadId).queued;
    assert.deepEqual(rest.items, ["b"]);
    assert.equal(rest.attachments, undefined);
  });

  it("a failed head goes back in front of anything queued since", async () => {
    const { store, threadId } = await storeWithThread();
    queueItems(store, threadId, ["a", "b"]);
    const head = services.takeQueuedHead(store, { threadId });
    services.setQueued(store, { threadId, prompt: "c" });
    services.restoreQueuedHead(store, { threadId, taken: head, error: "boom" });
    const q = store.getThread(threadId).queued;
    assert.deepEqual(q.items, ["a", "b", "c"]);
    assert.equal(q.prompt, "a\n\nb\n\nc");
    assert.equal(q.error, "boom");
  });

  it("each item drains with only the files it was queued with (#1512)", async () => {
    const { store, threadId } = await storeWithThread();
    const x = { kind: "image", path: "/tmp/x.png", name: "x.png" };
    const y = { kind: "folder", path: "/tmp/y", name: "y" };
    services.setQueued(store, { threadId, prompt: "a" });
    services.setQueued(store, { threadId, prompt: "b", attachments: [x, y] });
    services.setQueued(store, { threadId, prompt: "c", attachments: [y] });

    const a = services.takeQueuedHead(store, { threadId });
    assert.equal(a.prompt, "a");
    assert.equal(a.attachments, undefined, "a was queued without files");
    assert.deepEqual(store.getThread(threadId).queued.itemAttachments, [[x, y], [y]]);

    const b = services.takeQueuedHead(store, { threadId });
    assert.deepEqual(b.attachments, [x, y]);
    // b fails to start: it goes back in front with its own files.
    services.restoreQueuedHead(store, { threadId, taken: b, error: "boom" });
    const q = store.getThread(threadId).queued;
    assert.deepEqual(q.items, ["b", "c"]);
    assert.deepEqual(q.itemAttachments, [[x, y], [y]]);
    assert.deepEqual(q.attachments, [x, y, y]);

    services.takeQueuedHead(store, { threadId });
    const c = services.takeQueuedHead(store, { threadId });
    assert.deepEqual(c.attachments, [y]);
    assert.equal(store.getThread(threadId).queued, null);
  });

  it("an edit keeps per-item files and a reorder carries them along (#1512)", async () => {
    const { store, threadId } = await storeWithThread();
    const x = { kind: "image", path: "/tmp/x.png", name: "x.png" };
    services.setQueued(store, { threadId, prompt: "a", attachments: [x] });
    services.setQueued(store, { threadId, prompt: "b" });
    const swapped = services.setQueued(store, {
      threadId,
      prompt: "b\n\na",
      items: ["b", "a"],
      itemAttachments: [[], [x]],
      replace: true,
    });
    assert.deepEqual(swapped.queued.itemAttachments, [[], [x]]);
    const head = services.takeQueuedHead(store, { threadId });
    assert.equal(head.attachments, undefined);
  });
});

describe("queued row migration (#1512)", () => {
  const { migrateThread } = require("../store-migrate.js");
  const shot = { kind: "image", path: "/tmp/x.png", name: "x.png" };

  it("moves an old row's files onto its first item", () => {
    const t = migrateThread({
      id: "t",
      queued: { prompt: "one\n\ntwo", items: ["one", "two"], attachments: [shot] },
    });
    assert.deepEqual(t.queued.items, ["one", "two"]);
    assert.deepEqual(t.queued.itemAttachments, [[shot], []]);
    assert.deepEqual(t.queued.attachments, [shot]);
  });

  it("splits a pre-items row once and keeps a current row as is", () => {
    const legacy = migrateThread({ id: "t", queued: { prompt: "one\n\ntwo" } });
    assert.deepEqual(legacy.queued.items, ["one", "two"]);
    assert.deepEqual(legacy.queued.itemAttachments, [[], []]);
    assert.equal(legacy.queued.attachments, undefined);
    const current = {
      prompt: "a\n\nb",
      items: ["a", "b"],
      itemAttachments: [[], [shot]],
      attachments: [shot],
    };
    assert.deepEqual(migrateThread({ id: "t", queued: current }).queued, current);
    assert.equal(migrateThread({ id: "t" }).queued, null);
  });
});
