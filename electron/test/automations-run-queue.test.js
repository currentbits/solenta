"use strict";

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
const { runNow, startScheduler, settleAutomationRuns, listAutomationRuns,
  MAX_THREADS_PER_AUTOMATION } = require("../automations.js");
const { rmTree } = require("./support/rmTree.js");

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("automation lifecycle through the real global run queue", () => {
  let dir, store, runner, project, scheduler, previousEnv;

  beforeEach(async () => {
    previousEnv = { CODER_AGENT_CMD: process.env.CODER_AGENT_CMD, CODER_SIMULATE: process.env.CODER_SIMULATE };
    delete process.env.CODER_SIMULATE;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-auto-runq-"));
    // A real provider child holds each turn until the test releases its file.
    // Queue admission, transcript writes, and terminal events all use createRunner.
    const fixture = path.join(dir, "provider.cjs");
    fs.writeFileSync(fixture, `
      const fs = require("node:fs"), path = require("node:path");
      const dir = ${JSON.stringify(dir)};
      const key = process.argv.at(-1).split(/\\r?\\n/)[0];
      fs.writeFileSync(path.join(dir, key + ".started"), "");
      setInterval(() => {
        const file = path.join(dir, key + ".finish");
        if (!fs.existsSync(file)) return;
        const { code, text } = JSON.parse(fs.readFileSync(file, "utf8"));
        process.stdout.write(text, () => process.exit(code));
      }, 10);
    `);
    process.env.CODER_AGENT_CMD = `${process.execPath} ${fixture}`;
    store = new Store(path.join(dir, "store.json"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    project = await services.addProject(store, repo);
    store.setSettings({ maxConcurrentRuns: 1 });
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn() {} });
  });

  afterEach(async () => {
    scheduler?.stop();
    scheduler = null;
    for (const t of store.getThreads()) store.updateThread(t.id, { runQueue: null });
    runner.stopAll();
    await rmTree(dir);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function automation(extra = {}) {
    return services.addAutomation(store, { projectId: project.id, name: "Queued automation",
      prompt: "fire", provider: "claude", preset: "hourly", ...extra });
  }

  async function blockSlot() {
    const t = services.createThread(store, { projectId: project.id, title: "Blocker" });
    await runner.startRun({ threadId: t.id, prompt: "blocker" });
    await waitFor(() => fs.existsSync(path.join(dir, "blocker.started")));
    return t.id;
  }

  async function finish(threadId, key, code = 0, text = "Finished") {
    const file = path.join(dir, `${key}.finish`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ code, text }));
    fs.renameSync(`${file}.tmp`, file);
    await waitFor(() => store.getThread(threadId).status === (code ? "failed" : "done"));
  }

  it("keeps a queued fire pending until admission and counts its actual completion once", async () => {
    const blocker = await blockSlot();
    const auto = automation({ memory: "old notes", stage: "observe" });
    store.setAutomations([{ ...store.getAutomation(auto.id), consecutiveFailures: 2 }]);
    await runNow({ store, runner }, auto.id);
    const id = store.getAutomation(auto.id).pendingRunThreadId;
    assert.ok(store.getThread(id).runQueue);
    // Upgrade an existing queued automation that predates per-fire tracking.
    const { pendingRuns, ...legacy } = store.getAutomation(auto.id);
    store.setAutomations([legacy]);
    assert.equal(settleAutomationRuns({ store }), false);
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, id);
    assert.equal(store.getAutomation(auto.id).consecutiveFailures, 2);
    assert.equal(store.getAutomation(auto.id).memory, "old notes");
    assert.equal(store.getAutomation(auto.id).stage, "observe");

    await finish(blocker, "blocker");
    await waitFor(() => fs.existsSync(path.join(dir, "fire.started")));
    assert.equal(store.getThread(id).runQueue, null);
    assert.equal(store.getThread(id).status, "working", JSON.stringify(store.getAutomation(auto.id)));
    settleAutomationRuns({ store });
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, id);
    await finish(id, "fire", 0, "Done <automation-memory>new notes</automation-memory>");
    assert.equal(settleAutomationRuns({ store }), true);
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, null);
    assert.equal(store.getAutomation(auto.id).consecutiveFailures, 0);
    assert.equal(store.getAutomation(auto.id).memory, "new notes");
    assert.equal(settleAutomationRuns({ store }), false);
    assert.equal(store.getMessages(id).filter((m) => m.role === "user").length, 1);
    assert.equal(listAutomationRuns(store, auto.id).runs[0].status, "done");
  });

  it("preserves every repeated scheduled fire beyond retention and settles each failure", async () => {
    const blocker = await blockSlot();
    const auto = automation();
    let now = Date.now();
    scheduler = startScheduler({ store, runner, intervalMs: 3600000, now: () => now });
    const ids = [];
    for (let i = 0; i < MAX_THREADS_PER_AUTOMATION + 2; i++) {
      services.updateAutomation(store, { id: auto.id, prompt: `fire-${i}` });
      store.setAutomations([{ ...store.getAutomation(auto.id), nextRunAt: now }]);
      await scheduler.tick();
      ids.push(store.getAutomation(auto.id).pendingRunThreadId);
      now += 3600000;
    }
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(store.getThread(id)?.runQueue, "retention must keep queued work");
    assert.equal(listAutomationRuns(store, auto.id).runs.length, ids.length);
    assert.equal(store.getAutomation(auto.id).consecutiveFailures, 0);
    store.saveNow();
    const reloaded = new Store(path.join(dir, "store.json"));
    settleAutomationRuns({ store: reloaded });
    assert.equal(reloaded.getAutomation(auto.id).pendingRunThreadId, ids.at(-1));

    await finish(blocker, "blocker");
    // Fail the first three, without another fire replacing the newest pointer.
    for (let i = 0; i < 3; i++) {
      await waitFor(() => fs.existsSync(path.join(dir, `fire-${i}.started`)));
      await finish(ids[i], `fire-${i}`, 1, `Failure ${i}`);
      await waitFor(() => store.getThread(ids[i + 1]).status === "working");
      settleAutomationRuns({ store });
      assert.equal(store.getAutomation(auto.id).consecutiveFailures, i + 1);
      assert.equal(store.getAutomation(auto.id).pendingRunThreadId, ids.at(-1));
    }
    assert.equal(store.getAutomation(auto.id).enabled, false);
    assert.equal(settleAutomationRuns({ store }), false);
    for (let i = 3; i < ids.length; i++) {
      await finish(ids[i], `fire-${i}`);
      settleAutomationRuns({ store });
    }
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, null);
    assert.equal(store.getAutomation(auto.id).pendingRuns.length, 0);
    services.updateAutomation(store, { id: auto.id, prompt: "after" });
    await runNow({ store, runner }, auto.id);
    assert.equal(listAutomationRuns(store, auto.id).runs.length, MAX_THREADS_PER_AUTOMATION);
    assert.equal(store.getThread(ids[0]), null);
    for (const id of ids.slice(3)) {
      assert.equal(store.getMessages(id).filter((m) => m.role === "user").length, 1);
    }
  });

  for (const scope of ["private", "project"]) {
    it(`${scope} history keeps queued fires distinct after switching from a fixed destination`, async () => {
      const target = services.createThread(store, { projectId: project.id, title: "Fixed" });
      services.setProvider(store, { threadId: target.id, provider: "claude", model: null });
      const auto = automation({ scope, sessionMode: "continue", destinationThreadId: target.id });
      await runNow({ store, runner }, auto.id);
      await finish(target.id, "fire");
      settleAutomationRuns({ store });
      const fixed = listAutomationRuns(store, auto.id).runs[0];
      services.updateAutomation(store, { id: auto.id, sessionMode: "new-thread" });
      const blocker = await blockSlot();
      const ids = [];
      for (let i = 0; i < MAX_THREADS_PER_AUTOMATION + 1; i++) {
        services.updateAutomation(store, { id: auto.id, prompt: `mixed-${i}` });
        await runNow({ store, runner }, auto.id);
        ids.push(store.getAutomation(auto.id).pendingRunThreadId);
      }
      const queued = listAutomationRuns(store, auto.id).runs;
      assert.equal(queued.length, ids.length);
      assert.equal(new Set(queued.map((r) => r.id)).size, ids.length);
      assert.ok(queued.every((r) => r.pending && r.runId === null));
      const first = queued.find((r) => r.threadId === ids[0]);
      assert.ok(first.id);
      assert.ok(fixed.runId);
      await finish(blocker, "blocker");
      await waitFor(() => fs.existsSync(path.join(dir, "mixed-0.started")));
      settleAutomationRuns({ store });
      const admitted = listAutomationRuns(store, auto.id).runs.find((r) => r.id === first.id);
      assert.equal(admitted.pending, true);
      assert.equal(admitted.status, "working");
      assert.ok(admitted.runId);
      assert.notEqual(admitted.runId, fixed.runId);
      for (let i = 0; i < ids.length; i++) {
        await finish(ids[i], `mixed-${i}`, i === 1 ? 1 : 0,
          `Result ${i} <automation-memory>notes-${i}</automation-memory>`);
        settleAutomationRuns({ store });
        const history = listAutomationRuns(store, auto.id).runs;
        for (const id of ids.slice(i + 1)) {
          assert.equal(history.find((r) => r.threadId === id).pending, true);
        }
        if (i === 1) {
          assert.equal(store.getAutomation(auto.id).consecutiveFailures, 1);
          assert.equal(history.find((r) => r.threadId === ids[i]).status, "failed");
        }
      }
      const completed = listAutomationRuns(store, auto.id).runs;
      assert.ok(completed.every((r) => !r.pending));
      assert.equal(store.getAutomation(auto.id).pendingRunThreadId, null);
      assert.equal(store.getAutomation(auto.id).memory, `notes-${ids.length - 1}`);
      assert.equal(settleAutomationRuns({ store }), false);
      services.updateAutomation(store, { id: auto.id, prompt: "after" });
      await runNow({ store, runner }, auto.id);
      assert.equal(listAutomationRuns(store, auto.id).runs.length, MAX_THREADS_PER_AUTOMATION);
    });
  }

  it("settles a queued fire cancelled before admission and an admission that fails preflight", async () => {
    const blocker = await blockSlot();
    const auto = automation();
    await runNow({ store, runner }, auto.id);
    const cancelled = store.getAutomation(auto.id).pendingRunThreadId;
    await runner.stopRun({ threadId: cancelled });
    assert.equal(settleAutomationRuns({ store }), true);
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, null);
    assert.equal(fs.existsSync(path.join(dir, "fire.started")), false);

    await runNow({ store, runner }, auto.id);
    const failed = store.getAutomation(auto.id).pendingRunThreadId;
    store.setProjects([]);
    await finish(blocker, "blocker");
    await waitFor(() => store.getThread(failed).status === "failed");
    assert.equal(store.getThread(failed).runQueue, null);
    settleAutomationRuns({ store });
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, null);
    assert.equal(store.getAutomation(auto.id).consecutiveFailures, 1);
    assert.equal(fs.existsSync(path.join(dir, "fire.started")), false);
    assert.equal(settleAutomationRuns({ store }), false);
  });

  it("a later launch failure does not discard an earlier queued fire", async () => {
    const blocker = await blockSlot();
    const auto = automation();
    await runNow({ store, runner }, auto.id);
    const queued = store.getAutomation(auto.id).pendingRunThreadId;
    store.setProjects([]);
    await assert.rejects(runNow({ store, runner }, auto.id), /Unknown project/);
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, queued);
    assert.equal(store.getAutomation(auto.id).pendingRuns.length, 1);
    assert.equal(store.getAutomation(auto.id).consecutiveFailures, 1);
    store.setProjects([project]);
    await finish(blocker, "blocker");
    await finish(queued, "fire");
    settleAutomationRuns({ store });
    assert.equal(store.getAutomation(auto.id).pendingRunThreadId, null);
    assert.equal(store.getAutomation(auto.id).consecutiveFailures, 0);
  });

  for (const mode of ["continue", "fresh"]) {
    it(`fixed ${mode} destinations still skip full queues without changing context`, async () => {
      await blockSlot();
      const target = services.createThread(store, { projectId: project.id, title: "Human" });
      services.setProvider(store, { threadId: target.id, provider: "claude", model: null });
      store.updateThread(target.id, { sessionId: "human-session" });
      store.appendMessage(target.id, { id: "human", role: "assistant", text: "Human context", createdAt: 1 });
      const auto = automation({ sessionMode: mode, destinationThreadId: target.id });
      const before = store.getMessages(target.id).slice();
      await assert.rejects(runNow({ store, runner }, auto.id), /run slot.*skipped/);
      scheduler = startScheduler({ store, runner, intervalMs: 3600000 });
      for (let i = 0; i < 4; i++) {
        store.setAutomations([{ ...store.getAutomation(auto.id), nextRunAt: 0 }]);
        await scheduler.tick();
      }
      assert.equal(store.getThread(target.id).sessionId, "human-session");
      assert.equal(store.getThread(target.id).contextBoundaryId, undefined);
      assert.equal(store.getThread(target.id).runQueue, undefined);
      assert.deepEqual(store.getMessages(target.id), before);
      assert.equal(store.getAutomation(auto.id).consecutiveFailures, 0);
      assert.equal(store.getAutomation(auto.id).enabled, true);
      assert.equal(listAutomationRuns(store, auto.id).runs.length, 0);
    });
  }
});
