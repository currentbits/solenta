/**
 * #947: worker→lead integration is not final landing.
 * Issues stay open until the combined change lands on the final target.
 *
 * Run: node --test electron/test/merge-issue-lifecycle.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, mergeWorktree } = require("../worktrees.js");
const { integrateWorker } = require("../crewIntegration.js");
const { onThreadPrState, runPostMergeCheck } = require("../postmerge.js");
const { createToolHandlers } = require("../orchServer.js");
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

describe("merge issue lifecycle (#947)", () => {
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

  function forkWorker(from, title, issueNumber) {
    const worker = services.forkWorkerThread(store, { threadId: from.id });
    store.updateThread(worker.id, {
      title,
      status: "done",
      ...(issueNumber != null ? { issueNumber } : {}),
    });
    store.save();
    return store.getThread(worker.id);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-issue-life-"));
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

  afterEach(() => {
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("A→lead via mergeWorktree(intoPath) leaves issue 123 open and main unchanged", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker(lead, "A", 94701), "a.txt", "a\n");
    const workerSha = head(worker.worktreePath);
    const mainBefore = head(project.path);

    mergeWorktree({
      store,
      threadId: worker.id,
      intoPath: leadWt.worktreePath,
      broadcast: () => {},
    });
    await drain();

    assert.equal(head(project.path), mainBefore, "main HEAD must not move");
    assert.ok(!fs.existsSync(path.join(project.path, "a.txt")));
    assert.deepEqual(
      spy.seen.map((c) => c.number),
      [],
      "completeIssue must not run on worker→lead staging",
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
    assert.equal(receipts[0].issueNumber, 94701);
    assert.deepEqual(receipts[0].includedIssueIds, [94701]);
  });

  it("lead→final target closes included worker issues once", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    store.updateThread(lead.id, { issueNumber: 94702 });
    const worker = workOn(forkWorker(lead, "A", 94703), "a.txt", "a\n");

    mergeWorktree({
      store,
      threadId: worker.id,
      intoPath: leadWt.worktreePath,
      broadcast: () => {},
    });
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);

    mergeWorktree({
      store,
      threadId: lead.id,
      broadcast: () => {},
    });
    await drain();

    const closed = spy.seen.map((c) => c.number).sort((a, b) => a - b);
    assert.deepEqual(closed, [94702, 94703]);
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

  it("failed final landing leaves included issues open", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker(lead, "A", 94704), "a.txt", "a\n");
    mergeWorktree({
      store,
      threadId: worker.id,
      intoPath: leadWt.worktreePath,
      broadcast: () => {},
    });
    await drain();

    fs.writeFileSync(path.join(project.path, "README.md"), "main side\n");
    git(project.path, ["add", "README.md"]);
    git(project.path, ["commit", "-m", "main edit"]);
    const leadFresh = store.getThread(lead.id);
    fs.writeFileSync(path.join(leadFresh.worktreePath, "README.md"), "lead side\n");
    git(leadFresh.worktreePath, ["add", "README.md"]);
    git(leadFresh.worktreePath, ["commit", "-m", "lead edit"]);

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: lead.id,
          broadcast: () => {},
        }),
      /MERGE_CONFLICT|conflicts/i,
    );
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);
    assert.equal(store.getThread(lead.id).integrationLanded, undefined);
  });

  it("receipt survives reload and worker cleanup", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker(lead, "A", 94705), "a.txt", "a\n");
    mergeWorktree({
      store,
      threadId: worker.id,
      intoPath: leadWt.worktreePath,
      broadcast: () => {},
    });

    store.updateThread(worker.id, { archived: true, status: "done" });
    store.saveNow();

    const reloaded = new Store(store.filePath);
    const receipts = reloaded.getThread(lead.id).integrationReceipts;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].issueNumber, 94705);
    assert.deepEqual(receipts[0].includedIssueIds, [94705]);
    assert.equal(reloaded.getThread(worker.id).worktreePath, null);
  });

  it("direct final merge still closes the thread's own issue", async () => {
    const solo = services.createThread(store, {
      projectId: project.id,
      title: "Solo",
      issueNumber: 94706,
    });
    workOn(solo, "solo.txt", "solo\n");
    mergeWorktree({
      store,
      threadId: solo.id,
      broadcast: () => {},
    });
    await drain();
    assert.deepEqual(
      spy.seen.map((c) => c.number),
      [94706],
    );
    assert.ok(fs.existsSync(path.join(project.path, "solo.txt")));
  });

  it("thread_merge onto the lead worktree does not close the worker issue", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker(lead, "A", 94707), "w.txt", "w\n");
    const handlers = createToolHandlers({
      store,
      runner: { isRunning: () => false },
      forkThread: services.forkThread,
      getProvider: () => ({ id: "claude" }),
    });
    const mainBefore = head(project.path);

    await handlers.thread_merge({
      threadId: lead.id,
      projectId: project.id,
      workerThreadId: worker.id,
      approved: true,
    });
    await drain();

    assert.equal(head(project.path), mainBefore);
    assert.deepEqual(spy.seen.map((c) => c.number), []);
    const receipts = store.getThread(lead.id).integrationReceipts;
    assert.ok(receipts && receipts.some((r) => r.issueNumber === 94707));
    assert.ok(fs.existsSync(path.join(leadWt.worktreePath, "w.txt")));
  });

  it("nested lead integration keeps child issues open until the root lands", async () => {
    const rootWt = workOn(lead, "root.txt", "root\n");
    const mid = workOn(forkWorker(lead, "Mid", 94708), "mid.txt", "mid\n");
    const child = workOn(forkWorker(mid, "Child", 94709), "child.txt", "child\n");

    mergeWorktree({
      store,
      threadId: child.id,
      intoPath: mid.worktreePath,
      broadcast: () => {},
    });
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);

    mergeWorktree({
      store,
      threadId: mid.id,
      intoPath: rootWt.worktreePath,
      broadcast: () => {},
    });
    await drain();
    assert.deepEqual(spy.seen.map((c) => c.number), []);

    const rootReceipts = store.getThread(lead.id).integrationReceipts;
    assert.ok(rootReceipts && rootReceipts.length >= 1);
    const carried = new Set();
    for (const r of rootReceipts) {
      if (r.issueNumber) carried.add(r.issueNumber);
      for (const n of r.includedIssueIds || []) carried.add(n);
    }
    assert.ok(carried.has(94709), "child issue must ride with the mid-lead");
    assert.ok(carried.has(94708), "mid-lead issue must ride too");

    mergeWorktree({
      store,
      threadId: lead.id,
      broadcast: () => {},
    });
    await drain();
    const closed = spy.seen.map((c) => c.number).sort((a, b) => a - b);
    assert.deepEqual(closed, [94708, 94709]);
  });

  it("PR MERGED on the lead closes included issues; failed verify does not", async () => {
    workOn(lead, "lead.txt", "lead\n");
    store.updateThread(lead.id, {
      issueNumber: 94710,
      integrationReceipts: [
        {
          workerId: "w-pr",
          sourceSha: "abc1234",
          leadId: lead.id,
          leadShaAfter: "def5678",
          at: Date.now(),
          issueNumber: 94711,
          includedIssueIds: [94711],
        },
      ],
    });
    store.save();

    await onThreadPrState(store, lead.id, "MERGED", Date.now());
    await drain();
    const closed = spy.seen.map((c) => c.number).sort((a, b) => a - b);
    assert.deepEqual(closed, [94710, 94711]);
    assert.equal(store.getThread(lead.id).integrationLanded.via, "pr");

    spy.seen.length = 0;
    store.updateThread(lead.id, {
      prState: "MERGED",
      verifyCommand: "false",
      postMergeVerify: {
        dueAt: 0,
        status: "scheduled",
        at: null,
        result: null,
        fixThreadId: null,
      },
    });
    await runPostMergeCheck(
      {
        store,
        prepareCheckout: async () => ({
          cwd: project.path,
          sha: "abc1234deadbeef",
          cleanup: async () => {},
        }),
        runVerify: async () => ({
          ok: false,
          exitCode: 1,
          timedOut: false,
          log: "nope\n",
          durationMs: 3,
          at: Date.now(),
        }),
        reopenIssue: async () => ({ ok: true }),
        spawnFix: async () => null,
      },
      store.getThread(lead.id),
      Date.now(),
    );
    await drain();
    assert.deepEqual(
      spy.seen.map((c) => c.number),
      [],
      "failed post-merge verify must not close included issues",
    );
  });

  it("integrateWorker still skips closure and stores the issue on the receipt", async () => {
    workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker(lead, "A", 94712), "i.txt", "i\n");
    const result = integrateWorker({
      store,
      leadThreadId: lead.id,
      workerThreadId: worker.id,
    });
    await drain();
    assert.equal(result.merged, true);
    assert.equal(result.receipt.issueNumber, 94712);
    assert.deepEqual(spy.seen.map((c) => c.number), []);
  });

  it("does not invent historical issue numbers from old transcripts", async () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = forkWorker(lead, "A");
    store.setMessages(worker.id, [
      {
        id: "m1",
        role: "user",
        text: "see issue #83 for context from last month",
        createdAt: 1,
      },
    ]);
    workOn(worker, "hist.txt", "hist\n");

    mergeWorktree({
      store,
      threadId: worker.id,
      intoPath: leadWt.worktreePath,
      broadcast: () => {},
    });
    await drain();

    const receipts = store.getThread(lead.id).integrationReceipts || [];
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].issueNumber, null);
    assert.deepEqual(receipts[0].includedIssueIds, []);
    assert.deepEqual(spy.seen.map((c) => c.number), []);
  });
});
