/**
 * #346 merge queue must use the #947 landing contract.
 * Worker→lead integrate is not final. Issues close only on promote.
 *
 * Run: node --test electron/test/merge-queue-landing.test.js
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
const {
  enqueue,
  integrateNext,
  promote,
} = require("../mergeQueue.js");
const { onThreadPrState } = require("../postmerge.js");
const issues = require("../issues.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function head(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function drain() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function installCompleteSpy() {
  const orig = issues.completeIssue;
  const seen = [];
  issues.completeIssue = async (projectPath, number, opts) => {
    seen.push({ projectPath, number, comment: opts && opts.comment });
    return { ok: true };
  };
  return {
    seen,
    restore() {
      issues.completeIssue = orig;
    },
  };
}

describe("merge queue landing (#346 / #947)", () => {
  let tmpDir;
  let store;
  let project;
  let lead;
  let worktreeBase;
  let spy;

  function workOn(thread, file, body) {
    const t = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
    });
    fs.writeFileSync(path.join(t.worktreePath, file), body);
    git(t.worktreePath, ["add", "-A"]);
    git(t.worktreePath, ["commit", "-m", `add ${file}`]);
    return store.getThread(thread.id);
  }

  function forkWorker(title, issueNumber) {
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    store.updateThread(worker.id, {
      title,
      status: "done",
      ...(issueNumber != null ? { issueNumber } : {}),
    });
    store.save();
    return store.getThread(worker.id);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mergeq-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

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
    store.save();
    spy = installCompleteSpy();
  });

  afterEach(async () => {
    if (spy) spy.restore();
    try {
      for (const t of store.getThreads()) {
        if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
          try {
            git(project.path, ["worktree", "remove", "--force", t.worktreePath]);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    // Debounced shard flushes still create files after the test returns.
    // saveNow cancels that timer; flushPending waits until its tmp files are gone.
    if (store && tmpDir && fs.existsSync(tmpDir)) {
      store.saveNow();
      await store.flushPending();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("A→lead integrate leaves issue 123 open, writes a receipt, and does not move main", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker("A", 123), "a.txt", "a\n");
    const workerSha = head(worker.worktreePath);
    const mainBefore = head(project.path);

    enqueue(store, { leadThreadId: lead.id, workerThreadId: worker.id });
    const step = integrateNext({
      store,
      leadThreadId: lead.id,
      broadcast: () => {},
    });
    await drain();

    assert.equal(step.kind, "integrated");
    assert.equal(head(project.path), mainBefore, "main HEAD must not move");
    assert.ok(!fs.existsSync(path.join(project.path, "a.txt")));
    assert.ok(fs.existsSync(path.join(leadWt.worktreePath, "a.txt")));
    assert.deepEqual(
      spy.seen.map((c) => c.number),
      [],
      "completeIssue must not run on queue integrate",
    );

    const workerAfter = store.getThread(worker.id);
    assert.equal(workerAfter.worktreePath, null);
    assert.equal(workerAfter.branch, null);

    const receipts = store.getThread(lead.id).integrationReceipts;
    assert.ok(Array.isArray(receipts) && receipts.length === 1);
    assert.equal(receipts[0].workerId, worker.id);
    assert.equal(receipts[0].sourceSha, workerSha);
    assert.equal(receipts[0].leadId, lead.id);
    assert.ok(receipts[0].leadShaAfter);
    assert.equal(receipts[0].issueNumber, 123);
    assert.deepEqual(receipts[0].includedIssueIds, [123]);
  });

  it("final promote closes included worker issue IDs once via completeThreadIssue", async () => {
    workOn(lead, "lead.txt", "lead\n");
    store.updateThread(lead.id, { issueNumber: 200 });
    const worker = workOn(forkWorker("A", 123), "a.txt", "a\n");

    enqueue(store, { leadThreadId: lead.id, workerThreadId: worker.id });
    integrateNext({ store, leadThreadId: lead.id, broadcast: () => {} });
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);

    const result = promote({
      store,
      leadThreadId: lead.id,
      approved: true,
      broadcast: () => {},
    });
    await drain();

    assert.equal(result.kind, "final");
    const closed = spy.seen.map((c) => c.number).sort((a, b) => a - b);
    assert.deepEqual(closed, [123, 200]);
    assert.ok(fs.existsSync(path.join(project.path, "a.txt")));
    assert.ok(store.getThread(lead.id).integrationLanded);

    spy.seen.length = 0;
    await onThreadPrState(store, lead.id, "MERGED", Date.now());
    await drain();
    assert.deepEqual(
      spy.seen.map((c) => c.number),
      [],
      "retry / PR re-report must not close included issues again",
    );
  });

  it("promote without approval or a failed check gate leaves issues open", async () => {
    workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker("A", 123), "a.txt", "a\n");
    enqueue(store, { leadThreadId: lead.id, workerThreadId: worker.id });
    integrateNext({ store, leadThreadId: lead.id, broadcast: () => {} });
    await drain();
    const mainAfterIntegrate = head(project.path);

    assert.throws(
      () =>
        promote({
          store,
          leadThreadId: lead.id,
          broadcast: () => {},
        }),
      /user's decision|approved/i,
    );
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);
    assert.equal(head(project.path), mainAfterIntegrate);

    assert.throws(
      () =>
        promote({
          store,
          leadThreadId: lead.id,
          approved: true,
          checkCommand: "false",
          broadcast: () => {},
        }),
      /check|gate|verify/i,
    );
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);
    assert.equal(head(project.path), mainAfterIntegrate);
    assert.ok(!fs.existsSync(path.join(project.path, "a.txt")));
  });

  it("nested lead integrate keeps child issues open until the root promote", async () => {
    const rootWt = workOn(lead, "lead.txt", "lead\n");
    store.updateThread(lead.id, { issueNumber: 300 });
    const mid = services.forkWorkerThread(store, { threadId: lead.id });
    store.updateThread(mid.id, {
      title: "Mid",
      status: "done",
      issueNumber: 301,
    });
    workOn(mid, "mid.txt", "mid\n");
    const child = services.forkWorkerThread(store, { threadId: mid.id });
    store.updateThread(child.id, {
      title: "Child",
      status: "done",
      issueNumber: 302,
    });
    workOn(child, "child.txt", "child\n");

    enqueue(store, { leadThreadId: mid.id, workerThreadId: child.id });
    integrateNext({ store, leadThreadId: mid.id, broadcast: () => {} });
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);

    enqueue(store, { leadThreadId: lead.id, workerThreadId: mid.id });
    integrateNext({ store, leadThreadId: lead.id, broadcast: () => {} });
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);
    assert.ok(fs.existsSync(path.join(rootWt.worktreePath, "child.txt")));
    assert.ok(!fs.existsSync(path.join(project.path, "child.txt")));

    promote({
      store,
      leadThreadId: lead.id,
      approved: true,
      broadcast: () => {},
    });
    await drain();
    const closed = spy.seen.map((c) => c.number).sort((a, b) => a - b);
    assert.deepEqual(closed, [300, 301, 302]);
  });

  it("does not invent historical issue numbers from old transcripts", async () => {
    workOn(lead, "lead.txt", "lead\n");
    const worker = forkWorker("A");
    store.setMessages(worker.id, [
      {
        id: "m1",
        role: "user",
        text: "see issue #83 for context from last month",
        createdAt: 1,
      },
    ]);
    workOn(worker, "hist.txt", "hist\n");

    enqueue(store, { leadThreadId: lead.id, workerThreadId: worker.id });
    integrateNext({ store, leadThreadId: lead.id, broadcast: () => {} });
    await drain();

    const receipts = store.getThread(lead.id).integrationReceipts || [];
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].issueNumber, null);
    assert.deepEqual(receipts[0].includedIssueIds, []);
    assert.deepEqual(spy.seen.map((c) => c.number), []);
  });
});
