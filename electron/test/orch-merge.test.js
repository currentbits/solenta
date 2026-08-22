/**
 * thread_merge: the orchestrator lands a finished worker's branch and cleans
 * up its worktree. Before this tool existed the crew's commits stayed on their
 * own branches forever (190 of 195 finished workers on the live store).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree } = require("../worktrees.js");
const { createToolHandlers } = require("../orchServer.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("thread_merge", () => {
  let tmpDir;
  let store;
  let project;
  let lead;
  let worker;
  let handlers;

  /** Give a thread a worktree and one commit in it. */
  function workOn(thread, file, body) {
    const t = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase: path.join(tmpDir, "worktrees"),
    });
    fs.writeFileSync(path.join(t.worktreePath, file), body);
    git(t.worktreePath, ["add", "-A"]);
    git(t.worktreePath, ["commit", "-m", `add ${file}`]);
    return t;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orchmerge-"));
    store = new Store(path.join(tmpDir, "store.json"));

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    project = await services.addProject(store, repo);
    lead = services.createThread(store, {
      projectId: project.id,
      title: "Lead",
    });
    worker = services.forkWorkerThread(store, { threadId: lead.id });
    store.saveNow();

    handlers = createToolHandlers({
      store,
      runner: { isRunning: () => false },
      forkThread: services.forkThread,
      getProvider: () => ({ id: "claude" }),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lands the worker on the lead's branch, not on main", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    workOn(worker, "worker.txt", "worker\n");
    store.updateThread(worker.id, { status: "done" });

    const res = await handlers.thread_merge({
      threadId: lead.id,
      projectId: project.id,
      workerThreadId: worker.id,
      approved: true,
    });

    assert.equal(res.merged, true);
    // The lead's worktree has the worker's file...
    assert.ok(fs.existsSync(path.join(leadWt.worktreePath, "worker.txt")));
    // ...and main does not: a lead on a branch must not push work onto main.
    assert.ok(!fs.existsSync(path.join(project.path, "worker.txt")));
    // Worktree + branch are gone, thread fields cleared.
    const after = store.getThread(worker.id);
    assert.equal(after.worktreePath, null);
    assert.equal(after.branch, null);
    const branches = git(project.path, ["branch", "--list", res.branch]);
    assert.equal(branches, "");
  });

  it("refuses to commit onto the default branch without the user", async () => {
    // No lead worktree: the merge target is the project checkout, so this
    // would commit straight onto main. 13 worker branches landed that way in
    // one day before the gate existed.
    workOn(worker, "worker.txt", "worker\n");
    store.updateThread(worker.id, { status: "done" });

    await assert.rejects(
      () =>
        handlers.thread_merge({
          threadId: lead.id,
          projectId: project.id,
          workerThreadId: worker.id,
        }),
      /the user's decision/,
    );
    assert.ok(!fs.existsSync(path.join(project.path, "worker.txt")));
    // Nothing was cleaned up either — the branch is still there to ask about.
    assert.ok(store.getThread(worker.id).worktreePath);
  });

  it("merges into the project checkout once the user has approved", async () => {
    workOn(worker, "worker.txt", "worker\n");
    store.updateThread(worker.id, { status: "done" });

    const res = await handlers.thread_merge({
      threadId: lead.id,
      projectId: project.id,
      workerThreadId: worker.id,
      approved: true,
    });

    assert.equal(res.merged, true);
    assert.ok(fs.existsSync(path.join(project.path, "worker.txt")));
  });

  it("ignores approved:true on a machine-delivered turn", async () => {
    // The worker-finished notice wakes the lead on an auto turn: the user has
    // not answered yet, so the claim cannot be true however the agent sets it.
    handlers = createToolHandlers({
      store,
      runner: { isRunning: () => false, isAutoTurn: () => true },
      forkThread: services.forkThread,
      getProvider: () => ({ id: "claude" }),
    });
    workOn(worker, "worker.txt", "worker\n");
    store.updateThread(worker.id, { status: "done" });

    await assert.rejects(
      () =>
        handlers.thread_merge({
          threadId: lead.id,
          projectId: project.id,
          workerThreadId: worker.id,
          approved: true,
        }),
      /machine-delivered/,
    );
    assert.ok(!fs.existsSync(path.join(project.path, "worker.txt")));
  });

  it("refuses to stage onto the lead's own branch unasked", async () => {
    // Every lead thread runs in a worktree, so the old "merging onto my own
    // branch is just staging" exemption meant the gate never once fired: the
    // user watched worktrees fold into their tree with nobody asking.
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    workOn(worker, "worker.txt", "worker\n");
    store.updateThread(worker.id, { status: "done" });

    await assert.rejects(
      () =>
        handlers.thread_merge({
          threadId: lead.id,
          projectId: project.id,
          workerThreadId: worker.id,
        }),
      /the user's decision/,
    );
    assert.ok(!fs.existsSync(path.join(leadWt.worktreePath, "worker.txt")));
    assert.ok(store.getThread(worker.id).worktreePath);
  });

  it("still lets a sub-lead fold its own crew onto its branch", async () => {
    // The exemption that survives: `worker` is itself a lead here, so folding
    // its sub-worker in is not landing anything — the user is asked when the
    // main thread merges `worker`.
    const subLeadWt = workOn(worker, "mid.txt", "mid\n");
    const sub = services.forkWorkerThread(store, { threadId: worker.id });
    workOn(sub, "sub.txt", "sub\n");
    store.updateThread(sub.id, { status: "done" });

    const res = await handlers.thread_merge({
      threadId: worker.id,
      projectId: project.id,
      workerThreadId: sub.id,
    });

    assert.equal(res.merged, true);
    assert.ok(fs.existsSync(path.join(subLeadWt.worktreePath, "sub.txt")));
    assert.ok(!fs.existsSync(path.join(project.path, "sub.txt")));
  });

  it("lands a whole crew in the order given, on one answer", async () => {
    // One question covers the crew: the user's answer holds for every merge in
    // the turn it starts, so the lead can sequence them itself.
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const second = services.forkWorkerThread(store, { threadId: lead.id });
    workOn(worker, "worker.txt", "worker\n");
    workOn(second, "second.txt", "second\n");
    store.updateThread(worker.id, { status: "done" });
    store.updateThread(second.id, { status: "done" });

    for (const id of [worker.id, second.id]) {
      const res = await handlers.thread_merge({
        threadId: lead.id,
        projectId: project.id,
        workerThreadId: id,
        approved: true,
      });
      assert.equal(res.merged, true);
    }

    assert.ok(fs.existsSync(path.join(leadWt.worktreePath, "worker.txt")));
    assert.ok(fs.existsSync(path.join(leadWt.worktreePath, "second.txt")));
  });

  it("refuses a running worker, a foreign thread and a non-worker", async () => {
    workOn(worker, "worker.txt", "worker\n");

    store.updateThread(worker.id, { status: "working" });
    await assert.rejects(
      () =>
        handlers.thread_merge({
          threadId: lead.id,
          projectId: project.id,
          workerThreadId: worker.id,
        }),
      /still running/,
    );

    // A thread the caller did not fork stays off limits.
    store.updateThread(worker.id, { status: "done", handoffFrom: "someone" });
    await assert.rejects(
      () =>
        handlers.thread_merge({
          threadId: lead.id,
          projectId: project.id,
          workerThreadId: worker.id,
        }),
      /not one of your workers/,
    );
  });

  // thread_pr is the other answer to the lead's question. Only the gate and
  // the guards are covered here — the push/gh half is createPr's own.
  it("refuses a pull request the user did not ask for", async () => {
    workOn(worker, "worker.txt", "worker\n");
    store.updateThread(worker.id, { status: "done" });

    await assert.rejects(
      () =>
        handlers.thread_pr({
          threadId: lead.id,
          projectId: project.id,
          workerThreadId: worker.id,
          title: "Worker work",
        }),
      /the user's decision/,
    );
  });

  it("has no branch to propose for a checkout worker", async () => {
    const shared = services.forkWorkerThread(store, {
      threadId: lead.id,
      worktree: false,
    });
    store.updateThread(shared.id, { status: "done" });

    await assert.rejects(
      () =>
        handlers.thread_pr({
          threadId: lead.id,
          projectId: project.id,
          workerThreadId: shared.id,
          title: "Worker work",
          approved: true,
        }),
      /no branch of its own/,
    );
  });

  it("reports nothing to merge for a checkout worker", async () => {
    const shared = services.forkWorkerThread(store, {
      threadId: lead.id,
      worktree: false,
    });
    store.updateThread(shared.id, { status: "done" });

    const res = await handlers.thread_merge({
      threadId: lead.id,
      projectId: project.id,
      workerThreadId: shared.id,
    });
    assert.equal(res.merged, false);
    assert.match(res.reason, /already there/);
  });
});
