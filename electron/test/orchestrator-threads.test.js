/**
 * Orchestrator threads: the first prompt is forked to a worker instead of
 * running here (issue #202).
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

describe("orchestrator threads", () => {
  let tmpDir;
  let store;
  let core;
  let runner;
  let thread;
  let prevSimulate;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orchthread-"));
    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    store.updateThread(thread.id, { pendingFork: true });
    store.saveNow();
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    runner = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
  });

  /** @param {string} [userDataPath] omit to make the worker's worktree fail */
  function makeRunner(userDataPath) {
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
      userDataPath: userDataPath ?? "",
    });
    return runner;
  }

  const workersOf = (id) =>
    store.getThreads().filter((t) => t.handoffFrom === id);

  // Re-declared: runner.js does not export the cap (see issue #213).
  const MAX_WORKERS_PER_ORCHESTRATOR = 20;

  /**
   * Mint a worker on `orchId` and apply `patch`. Boot-time sweepCrew in
   * createRunner is the public path that exercises the real prune.
   */
  function mintWorker(orchId, patch) {
    const worker = services.forkWorkerThread(store, {
      threadId: orchId,
      worktree: false,
    });
    store.updateThread(worker.id, patch);
    store.appendMessage(worker.id, {
      id: `m-${worker.id}`,
      role: "assistant",
      text: "settled",
      createdAt: patch.createdAt ?? Date.now(),
    });
    return store.getThread(worker.id);
  }

  it("forks the first prompt to a worker instead of running here", async () => {
    await makeRunner(tmpDir).startRun({
      threadId: thread.id,
      prompt: "build the thing",
    });

    const workers = workersOf(thread.id);
    assert.equal(workers.length, 1);
    const worker = workers[0];
    assert.equal(worker.orchWorker, true);
    // The prompt reached the worker verbatim.
    const workerMsgs = store.getMessages(worker.id) || [];
    assert.ok(
      workerMsgs.some((m) => m.role === "user" && m.text === "build the thing"),
    );
    // The orchestrator never ran itself.
    const parent = store.getThread(thread.id);
    assert.equal(parent.pendingFork, false);
    assert.equal(parent.status, "idle");
    // Its transcript still records the prompt and names the worker.
    const parentMsgs = store.getMessages(thread.id) || [];
    assert.ok(
      parentMsgs.some((m) => m.role === "user" && m.text === "build the thing"),
    );
    assert.ok(
      parentMsgs.some(
        (m) => m.role === "event" && String(m.text).includes(worker.id),
      ),
    );
  });

  it("promotes the title before forking so the worker is not 'Fork: New Thread'", async () => {
    await makeRunner(tmpDir).startRun({
      threadId: thread.id,
      prompt: "build the thing",
    });
    assert.equal(store.getThread(thread.id).title, "build the thing");
    assert.equal(workersOf(thread.id)[0].title, "Fork: build the thing");
  });

  it("clears the flag: the second prompt runs the orchestrator itself", async () => {
    const r = makeRunner(tmpDir);
    await r.startRun({ threadId: thread.id, prompt: "build the thing" });
    assert.equal(workersOf(thread.id).length, 1);

    await r.startRun({ threadId: thread.id, prompt: "status?" });
    assert.equal(store.getThread(thread.id).status, "working");
    // No second worker: forking again is now the LLM's call, not the runner's.
    assert.equal(workersOf(thread.id).length, 1);
  });

  it("keeps pendingFork and leaves no orphan when the worker cannot start", async () => {
    // No userDataPath: the worker's lazy worktree cannot be materialized.
    await assert.rejects(
      makeRunner().startRun({ threadId: thread.id, prompt: "build the thing" }),
      /worktreeBase is not configured/,
    );
    assert.equal(store.getThread(thread.id).pendingFork, true);
    assert.equal(workersOf(thread.id).length, 0);
  });

  it("retains only the newest MAX workers per orchestrator and drops their messages", () => {
    const base = Date.now() - 60_000;
    const ids = [];
    for (let i = 0; i < MAX_WORKERS_PER_ORCHESTRATOR + 5; i++) {
      ids.push(
        mintWorker(thread.id, { status: "done", createdAt: base + i }).id,
      );
    }

    makeRunner(tmpDir);

    const mine = workersOf(thread.id);
    assert.equal(mine.length, MAX_WORKERS_PER_ORCHESTRATOR);
    const surviving = new Set(mine.map((t) => t.id));
    const expected = ids.slice(-MAX_WORKERS_PER_ORCHESTRATOR);
    assert.deepEqual([...surviving].sort(), [...expected].sort());
    for (const id of ids.slice(0, 5)) {
      assert.equal(surviving.has(id), false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(store.data.messagesByThread, id),
        false,
      );
    }
    for (const id of expected) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(store.data.messagesByThread, id),
        true,
      );
    }
  });

  it("does not purge working, worktree, or pinned workers past the cap", () => {
    const base = Date.now() - 60_000;
    const withWorktree = mintWorker(thread.id, {
      status: "done",
      createdAt: base,
      worktreePath: path.join(tmpDir, "wt"),
    });
    const working = mintWorker(thread.id, {
      status: "working",
      createdAt: base + 1,
    });
    const pinned = mintWorker(thread.id, {
      status: "done",
      createdAt: base + 2,
      pinnedAt: Date.now(),
    });

    for (let i = 0; i < MAX_WORKERS_PER_ORCHESTRATOR + 2; i++) {
      mintWorker(thread.id, { status: "done", createdAt: base + 10 + i });
    }

    makeRunner(tmpDir);

    assert.ok(store.getThread(withWorktree.id));
    assert.ok(store.getThread(working.id));
    assert.ok(store.getThread(pinned.id));
    // Newest MAX kept, plus the 3 skipped live/pinned/worktree threads
    // past the keep set.
    assert.equal(
      workersOf(thread.id).length,
      MAX_WORKERS_PER_ORCHESTRATOR + 3,
    );
  });

  it("leaves a non-worker and another orchestrator's crew untouched", () => {
    const handmade = services.createThread(store, {
      projectId: thread.projectId,
      title: "Manual",
    });
    const otherOrch = services.createThread(store, {
      projectId: thread.projectId,
      title: "Other orch",
    });
    const base = Date.now() - 60_000;
    const otherWorker = mintWorker(otherOrch.id, {
      status: "done",
      createdAt: base,
    });

    for (let i = 0; i < MAX_WORKERS_PER_ORCHESTRATOR + 5; i++) {
      mintWorker(thread.id, { status: "done", createdAt: base + i });
    }

    makeRunner(tmpDir);

    assert.ok(store.getThread(handmade.id));
    assert.equal(store.getThread(handmade.id).orchWorker, undefined);
    assert.ok(store.getThread(otherWorker.id));
    assert.equal(store.getThread(otherWorker.id).handoffFrom, otherOrch.id);
    assert.equal(workersOf(thread.id).length, MAX_WORKERS_PER_ORCHESTRATOR);
    assert.equal(workersOf(otherOrch.id).length, 1);
  });
});
