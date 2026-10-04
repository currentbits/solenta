/**
 * Host-only CI workflow sign-off (#510) fails closed. Safety net for the
 * createRunner split (#1447): every path that is not an explicit Accept for
 * this exact thread and patch must leave the merge blocked, with nothing
 * written to the destination. orch-merge.test.js covers the happy path and
 * patch/destination invalidation; this file covers the refusals.
 *
 * Run: node --test electron/test/ci-workflow-signoff.test.js
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
const { createRunner } = require("../runner.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("CI workflow sign-off fails closed", () => {
  let tmpDir;
  let store;
  let project;
  let runner;
  let handlers;
  /** Last pendingPermission pushed per thread on thread:updated. */
  let pushed;

  function newRunner() {
    const r = createRunner({
      store,
      core: {},
      userDataPath: tmpDir,
      pushFn: (channel, payload) => {
        if (channel === "thread:updated") {
          pushed.set(payload.thread.id, payload.pendingPermission);
        }
      },
    });
    handlers = createToolHandlers({ store, runner: { ...r, isAutoTurn: () => false } });
    return r;
  }

  /** A lead with one done worker whose branch adds a workflow file. */
  function leadWithWorkflowWorker(title, body = "name: ci\n") {
    const lead = services.createThread(store, { projectId: project.id, title });
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    const wt = setupWorktree({
      store,
      threadId: worker.id,
      worktreeBase: path.join(tmpDir, "worktrees"),
    });
    const file = path.join(wt.worktreePath, ".github/workflows/ci.yml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    git(wt.worktreePath, ["add", "-A"]);
    git(wt.worktreePath, ["commit", "-m", "add workflow"]);
    store.updateThread(worker.id, { status: "done" });
    // Hold the queued human resume so no provider process starts.
    store.updateThread(lead.id, { status: "working" });
    const args = {
      threadId: lead.id, projectId: project.id, workerThreadId: worker.id,
      approved: true, expectedPath: project.path, expectedBranch: "main",
    };
    return { lead, worker, wt, file, args };
  }

  function landed() {
    return fs.existsSync(path.join(project.path, ".github/workflows/ci.yml"));
  }

  /** The merge is refused at the CI gate and main is untouched. */
  async function assertBlocked(args) {
    const before = git(project.path, ["rev-parse", "HEAD"]);
    await assert.rejects(() => handlers.thread_merge(args), /CI_WORKFLOW/);
    assert.equal(git(project.path, ["rev-parse", "HEAD"]), before);
    assert.equal(landed(), false);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ci-signoff-"));
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
    pushed = new Map();
    runner = newRunner();
  });

  afterEach(() => {
    runner.stopAll();
    store.saveNow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("holds a workflow patch for sign-off: card pushed, thread awaiting, nothing merged", async () => {
    const { lead, args } = leadWithWorkflowWorker("Lead");
    assert.equal(runner.getPendingPermission(lead.id), null);

    await assertBlocked(args);
    const card = pushed.get(lead.id);
    assert.equal(card?.toolName, "CI workflow merge");
    assert.equal(card.guardrail?.rule, "CI_WORKFLOW");
    assert.equal(card.acceptAlways, false);
    assert.match(card.input, /\+name: ci/);
    assert.equal(store.getThread(lead.id).awaitingInput, true);

    // Retrying without an answer re-asks the same card; it never self-grants.
    await assertBlocked(args);
    assert.equal(runner.getPendingPermission(lead.id).requestId, card.requestId);
  });

  it("deny clears the card and the next attempt asks again", async () => {
    const { lead, args } = leadWithWorkflowWorker("Lead");
    await assertBlocked(args);
    const first = runner.getPendingPermission(lead.id);

    runner.respondPermission({ threadId: lead.id, requestId: first.requestId, decision: "deny" });
    assert.equal(runner.getPendingPermission(lead.id), null);
    assert.equal(pushed.get(lead.id), null);
    assert.equal(store.getThread(lead.id).awaitingInput, false);
    assert.equal(store.getThread(lead.id).queued ?? null, null, "deny queues no resume");

    await assertBlocked(args);
    const second = runner.getPendingPermission(lead.id);
    assert.notEqual(second.requestId, first.requestId, "a denied id is never reused");
    // The old id cannot approve the fresh card.
    assert.throws(() => runner.respondPermission({
      threadId: lead.id, requestId: first.requestId, decision: "allow",
    }));
    await assertBlocked(args);
  });

  for (const decision of ["allowAlways", "allowForSession", "cancel", "accept", undefined]) {
    it(`decision ${String(decision)} is refused and leaves the card pending`, async () => {
      const { lead, args } = leadWithWorkflowWorker("Lead");
      await assertBlocked(args);
      const { requestId } = runner.getPendingPermission(lead.id);

      assert.throws(
        () => runner.respondPermission({ threadId: lead.id, requestId, decision }),
        /one-time Accept or Deny/,
      );
      assert.equal(runner.getPendingPermission(lead.id)?.requestId, requestId);
      assert.equal(store.getThread(lead.id).queued ?? null, null);
      await assertBlocked(args);
    });
  }

  it("a stale or mismatched request id does not sign off", async () => {
    const { lead, args } = leadWithWorkflowWorker("Lead");
    await assertBlocked(args);
    const { requestId } = runner.getPendingPermission(lead.id);

    for (const bad of ["not-the-id", "", undefined, requestId.toUpperCase()]) {
      // Falls through to the ordinary permission path, which has no run.
      assert.throws(() => runner.respondPermission({
        threadId: lead.id, requestId: bad, decision: "allow",
      }));
    }
    assert.equal(runner.getPendingPermission(lead.id)?.requestId, requestId);
    assert.equal(store.getThread(lead.id).awaitingInput, true);
    await assertBlocked(args);
  });

  it("stopping the lead's run leaves a pending sign-off unsigned", async () => {
    const { lead, args } = leadWithWorkflowWorker("Lead");
    await assertBlocked(args);
    const { requestId } = runner.getPendingPermission(lead.id);

    await runner.stopRun({ threadId: lead.id });
    await assertBlocked(args);
    assert.equal(runner.getPendingPermission(lead.id)?.requestId, requestId);
  });

  it("a restart forgets an approval: a fresh runner asks again", async () => {
    const { lead, args } = leadWithWorkflowWorker("Lead");
    await assertBlocked(args);
    runner.respondPermission({
      threadId: lead.id, requestId: runner.getPendingPermission(lead.id).requestId, decision: "allow",
    });

    runner.stopAll();
    runner = newRunner();
    assert.equal(runner.getPendingPermission(lead.id), null);
    await assertBlocked(args);
    assert.equal(runner.getPendingPermission(lead.id)?.toolName, "CI workflow merge");
  });

  it("an approval for one thread does not carry to another", async () => {
    const a = leadWithWorkflowWorker("Lead A");
    const b = leadWithWorkflowWorker("Lead B"); // identical workflow patch
    await assertBlocked(a.args);
    const cardA = runner.getPendingPermission(a.lead.id);

    // A's card id answered on B's thread is not B's sign-off.
    assert.throws(() => runner.respondPermission({
      threadId: b.lead.id, requestId: cardA.requestId, decision: "allow",
    }));
    runner.respondPermission({ threadId: a.lead.id, requestId: cardA.requestId, decision: "allow" });
    assert.equal(runner.getPendingPermission(a.lead.id), null);
    assert.equal(store.getThread(b.lead.id).queued ?? null, null);

    // B's merge of the same patch still needs B's own click.
    await assertBlocked(b.args);
    const cardB = runner.getPendingPermission(b.lead.id);
    assert.notEqual(cardB.requestId, cardA.requestId);
    // ...and asking on B did not consume or reset A's approval.
    const result = await handlers.thread_merge(a.args);
    assert.equal(result.merged, true);
    assert.equal(landed(), true);
  });

  it("an approval is consumed by a merge that fails after the gate; the identical retry asks again", async () => {
    const { lead, args } = leadWithWorkflowWorker("Lead");
    await assertBlocked(args);
    const first = runner.getPendingPermission(lead.id);
    runner.respondPermission({ threadId: lead.id, requestId: first.requestId, decision: "allow" });

    // The squash commit runs hooks, so this fails after the sign-off check.
    const hook = path.join(project.path, ".git/hooks/pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const before = git(project.path, ["rev-parse", "HEAD"]);
    await assert.rejects(() => handlers.thread_merge(args), /Failed to commit merge/);
    assert.equal(git(project.path, ["rev-parse", "HEAD"]), before);
    fs.rmSync(hook);

    // Same worker, same patch, same destination: the click was single use.
    await assertBlocked(args);
    const second = runner.getPendingPermission(lead.id);
    assert.equal(second?.toolName, "CI workflow merge");
    assert.notEqual(second.requestId, first.requestId);
  });

  it("an approval is single use and does not cover a changed patch", async () => {
    const { lead, file, wt, args } = leadWithWorkflowWorker("Lead");
    await assertBlocked(args);
    runner.respondPermission({
      threadId: lead.id, requestId: runner.getPendingPermission(lead.id).requestId, decision: "allow",
    });

    // The worker changes the workflow after the click: fresh card, still blocked.
    fs.writeFileSync(file, "name: ci\non: push\n");
    git(wt.worktreePath, ["commit", "-am", "change workflow"]);
    await assertBlocked(args);
    const card = runner.getPendingPermission(lead.id);
    assert.match(card.input, /\+on: push/);

    // Reverting to the approved patch does not revive the old approval.
    git(wt.worktreePath, ["reset", "--hard", "HEAD~1"]);
    await assertBlocked(args);
    assert.doesNotMatch(runner.getPendingPermission(lead.id).input, /\+on: push/);
  });
});
