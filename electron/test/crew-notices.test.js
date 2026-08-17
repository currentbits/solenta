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

function userTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "user")
    .map((m) => String(m.text || ""));
}

function eventTexts(store, threadId) {
  return (store.getMessages(threadId) || [])
    .filter((m) => m.role === "event")
    .map((m) => String(m.text || ""));
}

describe("crew notices (issue #277)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-crew-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = await services.addProject(store, repo);
    services.createThread(store, {
      projectId: project.id,
      title: "Lead",
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

  it("deliverNotice is on the runner and a bad threadId is a silent no-op", () => {
    assert.equal(typeof runner.deliverNotice, "function");
    assert.equal(runner.deliverNotice({ threadId: "gone", line: "x" }), undefined);
    assert.equal(runner.deliverNotice({}), undefined);
    assert.equal(runner.deliverNotice(), undefined);
    const thread = store.getThreads()[0];
    assert.equal(store.getMessages(thread.id).length, 0);
  });

  it("delivers a queued notice to an idle thread as a run", async () => {
    const thread = store.getThreads()[0];
    const line = `[peer from w1 ("backend")] API contract is in contract.md`;
    assert.equal(runner.deliverNotice({ threadId: thread.id, line }), undefined);

    await waitFor(() => userTexts(store, thread.id).length > 0);
    const text = userTexts(store, thread.id)[0];
    assert.match(text, /\[peer from w1 \("backend"\)\]/);
    assert.match(text, /contract\.md/);
    assert.match(text, /Continue orchestrating; thread_status has full details\./);
    assert.doesNotMatch(text, /\[orchestration\] \[peer/);
    await waitFor(() => {
      const t = store.getThread(thread.id);
      return t && t.status === "done";
    });
  });

  it("queues a notice while the thread is running and flushes at its terminal", async () => {
    const thread = store.getThreads()[0];
    await runner.startRun({ threadId: thread.id, prompt: "busy working" });
    assert.equal(runner.isRunning(thread.id), true);

    runner.deliverNotice({
      threadId: thread.id,
      line: `[peer from w2 ("frontend")] unblocked`,
    });
    assert.deepEqual(userTexts(store, thread.id), ["busy working"]);

    await waitFor(() =>
      userTexts(store, thread.id).some((t) => t.includes("[peer from w2")),
    );
    const users = userTexts(store, thread.id);
    assert.equal(users[0], "busy working");
    assert.match(users[1], /\[peer from w2 \("frontend"\)\] unblocked/);
    assert.match(users[1], /Continue orchestrating/);
  });

  it("refuses delivery at CREW_AUTO_TURN_CAP and a user turn resets the counter", async () => {
    const timers = new Map();
    let nextTimerId = 0;
    const manual = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      setIntervalFn: (fn) => {
        const id = ++nextTimerId;
        timers.set(id, fn);
        return id;
      },
      clearIntervalFn: (id) => timers.delete(id),
    });
    const driveUntil = (pred) => {
      for (let i = 0; i < 4000 && !pred(); i++) {
        for (const fn of [...timers.values()]) fn();
      }
      if (!pred()) throw new Error("driveUntil exhausted");
    };
    try {
      const thread = store.getThreads()[0];
      assert.equal(services.CREW_AUTO_TURN_CAP, 25);

      for (let i = 0; i < services.CREW_AUTO_TURN_CAP; i++) {
        manual.deliverNotice({
          threadId: thread.id,
          line: `[peer from w ("t")] auto ${i + 1}`,
        });
        await Promise.resolve();
        driveUntil(() => store.getThread(thread.id).status === "done");
        assert.equal(
          store.getThread(thread.id).status,
          "done",
          `auto turn ${i + 1} should land`,
        );
      }

      manual.deliverNotice({
        threadId: thread.id,
        line: `[peer from w ("t")] one too many`,
      });
      await waitFor(() => store.getThread(thread.id).status === "failed");
      const last = (store.getMessages(thread.id) || []).at(-1);
      assert.equal(last.role, "event");
      assert.match(last.text, /\[peer from w \("t"\)\] one too many/);
      assert.match(last.text, /Not delivered: Crew auto-turn cap reached \(25/);
      assert.match(last.text, /A human turn resets it/);
      assert.equal(store.getThread(thread.id).lastError.includes("auto-turn cap"), true);
      const usersBefore = userTexts(store, thread.id).length;

      await manual.startRun({ threadId: thread.id, prompt: "human turn" });
      driveUntil(() => store.getThread(thread.id).status === "done");
      assert.equal(store.getThread(thread.id).status, "done");

      manual.deliverNotice({
        threadId: thread.id,
        line: `[peer from w ("t")] after human`,
      });
      await Promise.resolve();
      driveUntil(() =>
        userTexts(store, thread.id).some((t) => t.includes("after human")),
      );
      assert.ok(
        userTexts(store, thread.id).some((t) => t.includes("after human")),
        "a user turn must reset the cap so notices deliver again",
      );
      assert.ok(userTexts(store, thread.id).length > usersBefore);
    } finally {
      manual.stopAll();
    }
  });

  it("a failed run releases the crew-task claim", async () => {
    const failingCore = {
      ...core,
      tick() {
        throw new Error("simulated tick boom");
      },
    };
    const failRunner = createRunner({
      store,
      core: failingCore,
      pushFn() {},
      tickMs: 15,
    });
    try {
      const orch = store.getThreads()[0];
      const worker = services.forkThread(store, { threadId: orch.id });
      store.updateThread(worker.id, { orchWorker: true, title: "Worker A" });
      store.saveNow();
      services.addCrewTasks(store, {
        threadId: orch.id,
        tasks: [{ title: "wire the API" }],
      });
      const claimed = services.claimCrewTask(store, {
        threadId: worker.id,
        taskId: "t1",
      });
      assert.equal(claimed.task.owner, worker.id);

      await failRunner.startRun({ threadId: worker.id, prompt: "will fail" });
      await waitFor(() => {
        const t = store.getThread(worker.id);
        return t && t.status === "failed";
      });

      const after = services.listCrewTasks(store, { threadId: worker.id }).tasks;
      assert.equal(after.length, 1);
      assert.equal(after[0].status, "open", "claim must return to the pool");
      assert.equal(after[0].owner, null);
      assert.match(
        String(after[0].attempts[0].outcome || ""),
        /simulated tick boom|Run error/,
      );
    } finally {
      failRunner.stopAll();
    }
  });

  it("wires crewTaskNoteFor into the dispatch prompt", async () => {
    const thread = store.getThreads()[0];
    services.addCrewTasks(store, {
      threadId: thread.id,
      tasks: [{ title: "wire the API" }],
    });
    services.claimCrewTask(store, { threadId: thread.id, taskId: "t1" });

    const seen = [];
    const orig = services.crewTaskNoteFor;
    services.crewTaskNoteFor = (s, t) => {
      const note = orig(s, t);
      seen.push(note);
      return note;
    };
    try {
      await runner.startRun({ threadId: thread.id, prompt: "keep going" });
      await waitFor(() => {
        const t = store.getThread(thread.id);
        return t && (t.status === "done" || t.status === "failed");
      });
      assert.ok(seen.length >= 1, "startRun must call crewTaskNoteFor");
      assert.match(seen[0], /\[Crew task\]/);
      assert.match(seen[0], /t1: wire the API/);
    } finally {
      services.crewTaskNoteFor = orig;
    }
  });
});
