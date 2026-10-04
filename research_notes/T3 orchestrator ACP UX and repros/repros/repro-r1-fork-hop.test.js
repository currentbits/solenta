"use strict";

/**
 * Repro R1 (commit 615b38a0): an orchestrator thread's first-prompt fork hop
 * (runner.js:8318-8394) awaits startWithPoolFailover with NO active entry
 * for the lead, and the branch never checks fromNotice. So during the hop:
 *  (a) a second send forks a second worker,
 *  (b) a notice delivered to the lead is forked as a worker task,
 *  (c) Stop on the lead has nothing to stop.
 *
 * The hop is held open with a hanging memory-bootstrap prefetch on the
 * worker's first turn (the same seam stop-during-prepare.test.js uses).
 * Convention: asserts the CORRECT behaviour, so it FAILS while R1 is real.
 * Run: node --test electron/test/repro-r1-fork-hop.test.js
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
function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("R1: orchestrator fork hop", () => {
  let tmpDir, store, runner, lead, prevSim, boots;

  beforeEach(async () => {
    prevSim = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-r1-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    const project = await services.addProject(store, repo);
    lead = services.createThread(store, { projectId: project.id, title: "New Thread" });
    store.updateThread(lead.id, { pendingFork: true });
    store.saveNow();
    boots = [];
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
      // Every first-turn prefetch hangs until the test releases it: this is
      // the window in which the lead's hop is awaiting the worker's start.
      bootstrapMemory: () => new Promise((resolve) => boots.push(resolve)),
    });
  });

  afterEach(async () => {
    for (const b of boots) b({});
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevSim === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSim;
  });

  const workersOf = () => store.getThreads().filter((t) => t.handoffFrom === lead.id);
  const firstUserText = (id) => {
    const m = (store.getMessages(id) || []).find((x) => x.role === "user");
    return m ? String(m.text) : null;
  };
  const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e.message }));

  it("(a) a second send during the hop must not fork a second worker", async () => {
    const first = settle(runner.startRun({ threadId: lead.id, prompt: "build the parser" }));
    await waitFor(() => boots.length === 1); // hop is now awaiting worker 1's start
    const facts = { leadActiveDuringHop: runner.isRunning(lead.id), leadStatusDuringHop: store.getThread(lead.id).status };
    const second = settle(runner.startRun({ threadId: lead.id, prompt: "also add tests" }));
    await new Promise((r) => setTimeout(r, 50));
    for (const b of boots) b({});
    await new Promise((r) => setTimeout(r, 50));
    for (const b of boots) b({});
    facts.first = await first;
    facts.second = await second;
    facts.workers = workersOf().map((w) => firstUserText(w.id));
    console.log("R1(a) facts:", JSON.stringify(facts));
    assert.equal(facts.workers.length, 1, `two workers forked: ${JSON.stringify(facts.workers)}`);
  });

  it("(b) a notice arriving during the hop must not be forked as a worker task", async () => {
    const first = settle(runner.startRun({ threadId: lead.id, prompt: "build the parser" }));
    await waitFor(() => boots.length === 1);
    const line = `[peer from w9 ("backend")] API contract is in contract.md`;
    runner.deliverNotice({ threadId: lead.id, line });
    await waitFor(() => boots.length >= 2, { timeoutMs: 1000 }).catch(() => {});
    for (const b of boots) b({});
    await new Promise((r) => setTimeout(r, 50));
    for (const b of boots) b({});
    await first;
    await new Promise((r) => setTimeout(r, 50));
    const workers = workersOf().map((w) => ({ id: w.id, title: w.title, task: firstUserText(w.id) }));
    console.log("R1(b) workers:", JSON.stringify(workers));
    const noticeForked = workers.filter((w) => (w.task || "").includes("API contract is in contract.md"));
    assert.equal(noticeForked.length, 0, `notice became a worker task: ${JSON.stringify(noticeForked)}`);
  });

  it("(c) Stop on the lead during the hop must leave no worker launched", async () => {
    const first = settle(runner.startRun({ threadId: lead.id, prompt: "build the parser" }));
    await waitFor(() => boots.length === 1);
    const stopResult = await runner.stopRun({ threadId: lead.id });
    for (const b of boots) b({});
    const firstResult = await first;
    await new Promise((r) => setTimeout(r, 100));
    const facts = {
      stopResult: stopResult ?? null,
      firstResult,
      workers: workersOf().map((w) => ({
        task: firstUserText(w.id),
        status: store.getThread(w.id).status,
        running: runner.isRunning(w.id),
        events: (store.getMessages(w.id) || []).filter((m) => m.role === "event").map((m) => m.text),
      })),
      leadPendingFork: store.getThread(lead.id).pendingFork,
      leadEvents: (store.getMessages(lead.id) || []).filter((m) => m.role === "event").map((m) => m.text),
    };
    console.log("R1(c) facts:", JSON.stringify(facts));
    const launched = facts.workers.filter((w) => w.running || w.status === "working" || w.status === "done");
    assert.equal(launched.length, 0, "a worker ran after the user pressed Stop");
  });
  it("(d) Stop on the lead during a /committee fan-out must not start the remaining workers", async () => {
    const prev = {};
    for (const k of ["CODER_GROK_BIN", "CODER_CODEX_BIN", "CODER_CLAUDE_BIN"]) {
      prev[k] = process.env[k];
      process.env[k] = process.execPath; // parse accepts @provider only when "installed"
    }
    try {
      store.updateThread(lead.id, { pendingFork: false, title: "Lead" });
      const first = settle(runner.startRun({ threadId: lead.id, prompt: "/committee @grok @codex why does the reconnect test flake" }));
      await waitFor(() => boots.length === 1); // worker 1 is preparing; worker 2 is forked, not started
      await runner.stopRun({ threadId: lead.id });
      for (let i = 0; i < 5; i++) {
        for (const b of boots) b({});
        await new Promise((r) => setTimeout(r, 30));
      }
      const firstResult = await first;
      await new Promise((r) => setTimeout(r, 100));
      const workers = workersOf().map((w) => ({
        provider: w.provider,
        status: store.getThread(w.id).status,
        ran: (store.getMessages(w.id) || []).some((m) => m.role === "assistant"),
        stopped: (store.getMessages(w.id) || []).some((m) => m.role === "event" && m.text === "Run stopped"),
      }));
      console.log("R1(d) facts:", JSON.stringify({ firstResult, workers }));
      const ranAfterStop = workers.filter((w) => w.ran || w.status === "working");
      assert.equal(ranAfterStop.length, 0, "a committee worker started after Stop");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
