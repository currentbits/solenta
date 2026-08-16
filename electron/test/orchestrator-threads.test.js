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

    const project = services.addProject(store, repo);
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
});
