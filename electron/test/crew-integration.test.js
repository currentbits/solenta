/**
 * Lead Integration (#954): git.integrateWorker refusals, conflict leaves
 * the lead intact, receipts survive cleanup/archive, retry is idempotent.
 *
 * Run: node --test electron/test/crew-integration.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, gitTry } = require("../worktrees.js");
const {
  integrateWorker,
  crewIntegration,
} = require("../crewIntegration.js");

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

describe("crew integration (#954)", () => {
  let tmpDir;
  let store;
  let project;
  let lead;
  let worktreeBase;

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

  function forkWorker(title) {
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    store.updateThread(worker.id, { title, status: "done" });
    store.save();
    return store.getThread(worker.id);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-crewinteg-"));
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
  });

  afterEach(() => {
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

  it("refuses without a lead worktree (never falls through to main)", () => {
    const worker = workOn(forkWorker("A"), "a.txt", "a\n");
    const mainBefore = head(project.path);

    assert.throws(
      () =>
        integrateWorker({
          store,
          leadThreadId: lead.id,
          workerThreadId: worker.id,
        }),
      /Set up a lead worktree first/,
    );
    assert.equal(head(project.path), mainBefore);
    assert.ok(!fs.existsSync(path.join(project.path, "a.txt")));
    assert.ok(store.getThread(worker.id).worktreePath);
  });

  it("refuses unless the caller is the worker's handoffFrom", () => {
    workOn(lead, "lead.txt", "lead\n");
    const stranger = services.createThread(store, {
      projectId: project.id,
      title: "Stranger",
    });
    const worker = services.forkWorkerThread(store, { threadId: stranger.id });
    store.updateThread(worker.id, { status: "done" });
    workOn(store.getThread(worker.id), "x.txt", "x\n");

    assert.throws(
      () =>
        integrateWorker({
          store,
          leadThreadId: lead.id,
          workerThreadId: worker.id,
        }),
      /not this lead's worker/i,
    );
  });

  it("refuses while the worker is running", () => {
    workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker("A"), "a.txt", "a\n");
    store.updateThread(worker.id, { status: "working" });

    assert.throws(
      () =>
        integrateWorker({
          store,
          leadThreadId: lead.id,
          workerThreadId: worker.id,
        }),
      /running/i,
    );
    assert.throws(
      () =>
        integrateWorker({
          store,
          leadThreadId: lead.id,
          workerThreadId: worker.id,
          isRunning: (id) => id === worker.id,
        }),
      /running/i,
    );
  });

  it("integrates onto the lead branch, records a receipt, leaves main intact", () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker("A"), "a.txt", "a\n");
    const workerSha = head(worker.worktreePath);
    const mainBefore = head(project.path);
    const leadBefore = head(leadWt.worktreePath);

    const result = integrateWorker({
      store,
      leadThreadId: lead.id,
      workerThreadId: worker.id,
    });

    assert.equal(result.noop, false);
    assert.ok(result.receipt);
    assert.equal(result.receipt.workerId, worker.id);
    assert.equal(result.receipt.sourceSha, workerSha);
    assert.equal(result.receipt.leadId, lead.id);
    assert.ok(result.receipt.leadShaAfter);
    assert.notEqual(result.receipt.leadShaAfter, leadBefore);

    const leadAfter = store.getThread(lead.id);
    assert.ok(fs.existsSync(path.join(leadAfter.worktreePath, "a.txt")));
    assert.equal(head(leadAfter.worktreePath), result.receipt.leadShaAfter);
    assert.equal(head(project.path), mainBefore, "final target (main) did not move");
    assert.ok(!fs.existsSync(path.join(project.path, "a.txt")));

    const workerAfter = store.getThread(worker.id);
    assert.equal(workerAfter.worktreePath, null);
    assert.equal(workerAfter.branch, null);

    const receipts = leadAfter.integrationReceipts;
    assert.ok(Array.isArray(receipts));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].sourceSha, workerSha);
  });

  it("receipt survives reload and worker archive", () => {
    workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker("A"), "a.txt", "a\n");
    integrateWorker({
      store,
      leadThreadId: lead.id,
      workerThreadId: worker.id,
    });
    store.updateThread(worker.id, { archived: true, status: "done" });
    store.saveNow();

    const reloaded = new Store(store.filePath);
    const view = crewIntegration(reloaded, { threadId: lead.id });
    const row = view.workers.find((w) => w.workerId === worker.id);
    assert.ok(row, "archived worker still listed");
    assert.equal(row.state, "integrated");
    assert.equal(row.archived, true);
    assert.equal(view.landed, false);
    assert.ok(view.receipts.some((r) => r.workerId === worker.id));
  });

  it("conflict leaves the lead HEAD intact and marks the worker conflicted", () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    // Fork before the lead diverges so the worker stays on the original
    // snapshot (#948). Parallel edits of README.md then conflict on integrate.
    const worker = forkWorker("B");
    const wt = setupWorktree({
      store,
      threadId: worker.id,
      worktreeBase,
    });

    fs.writeFileSync(path.join(leadWt.worktreePath, "README.md"), "lead side\n");
    git(leadWt.worktreePath, ["add", "README.md"]);
    git(leadWt.worktreePath, ["commit", "-m", "lead edit"]);
    const leadSha = head(leadWt.worktreePath);

    fs.writeFileSync(path.join(wt.worktreePath, "README.md"), "worker side\n");
    git(wt.worktreePath, ["add", "README.md"]);
    git(wt.worktreePath, ["commit", "-m", "worker edit"]);
    store.updateThread(worker.id, { status: "done" });

    assert.throws(
      () =>
        integrateWorker({
          store,
          leadThreadId: lead.id,
          workerThreadId: worker.id,
        }),
      /MERGE_CONFLICT:/,
    );

    assert.equal(head(leadWt.worktreePath), leadSha);
    assert.equal(
      fs.readFileSync(path.join(leadWt.worktreePath, "README.md"), "utf8"),
      "lead side\n",
    );
    const still = store.getThread(worker.id);
    assert.ok(still.worktreePath);
    const unmerged = gitTry(still.worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    assert.match(unmerged.stdout || "", /README\.md/);

    const view = crewIntegration(store, { threadId: lead.id });
    const row = view.workers.find((w) => w.workerId === worker.id);
    assert.equal(row.state, "conflicted");
    assert.equal(view.landed, false);
  });

  it("retry of an Integrated row with the same source SHA is a no-op", () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const worker = workOn(forkWorker("A"), "a.txt", "a\n");
    const first = integrateWorker({
      store,
      leadThreadId: lead.id,
      workerThreadId: worker.id,
    });
    const leadSha = head(leadWt.worktreePath);

    const second = integrateWorker({
      store,
      leadThreadId: lead.id,
      workerThreadId: worker.id,
    });
    assert.equal(second.noop, true);
    assert.equal(second.receipt.sourceSha, first.receipt.sourceSha);
    assert.equal(head(leadWt.worktreePath), leadSha);
    assert.equal(store.getThread(lead.id).integrationReceipts.length, 1);
  });

  it("missing worker path with no receipt is Missing, never Landed", () => {
    workOn(lead, "lead.txt", "lead\n");
    const wt = workOn(forkWorker("A"), "a.txt", "a\n");
    const worker = wt;
    fs.rmSync(wt.worktreePath, { recursive: true, force: true });
    store.updateThread(worker.id, { worktreePath: null, branch: null });
    store.save();

    const view = crewIntegration(store, { threadId: lead.id });
    const row = view.workers.find((w) => w.workerId === worker.id);
    assert.equal(row.state, "missing");
    assert.notEqual(row.state, "landed");
    assert.notEqual(row.state, "integrated");
    assert.match(row.missingReason || "", /worktree/i);
  });

  it("crew task needs block Integrate on the dependent worker", () => {
    workOn(lead, "lead.txt", "lead\n");
    const b = workOn(forkWorker("B work"), "b.txt", "b\n");
    const c = workOn(forkWorker("C work"), "c.txt", "c\n");
    services.addCrewTasks(store, {
      threadId: lead.id,
      tasks: [{ title: "B work" }, { title: "C work", needs: ["t1"] }],
    });
    const list = store.getCrewTasks(lead.id);
    const t2 = list.find((t) => t.id === "t2");
    t2.status = "claimed";
    t2.owner = c.id;
    store.setCrewTasks(lead.id, list);
    store.save();

    const view = crewIntegration(store, { threadId: lead.id });
    const rowC = view.workers.find((w) => w.workerId === c.id);
    assert.equal(rowC.blocked, true);
    assert.deepEqual(rowC.needs, ["t1"]);
    const rowB = view.workers.find((w) => w.workerId === b.id);
    assert.equal(rowB.blocked, false);
  });

  it("Ready for review is not Integrated, and worker-to-lead does not flip Landed", () => {
    workOn(lead, "lead.txt", "lead\n");
    const a = workOn(forkWorker("A"), "a.txt", "a\n");

    let view = crewIntegration(store, { threadId: lead.id });
    const ready = view.workers.find((w) => w.workerId === a.id);
    assert.equal(ready.state, "ready");
    assert.equal(view.landed, false);

    integrateWorker({
      store,
      leadThreadId: lead.id,
      workerThreadId: a.id,
    });
    view = crewIntegration(store, { threadId: lead.id });
    const integrated = view.workers.find((w) => w.workerId === a.id);
    assert.equal(integrated.state, "integrated");
    assert.equal(view.landed, false);
  });

  it("combined verify is stale after the lead HEAD moves", () => {
    const leadWt = workOn(lead, "lead.txt", "lead\n");
    const sha = head(leadWt.worktreePath);
    store.updateThread(lead.id, {
      verify: {
        runId: "manual",
        command: "true",
        ok: true,
        exitCode: 0,
        timedOut: false,
        log: "",
        sha,
        durationMs: 1,
        at: Date.now(),
        attempt: 0,
      },
    });
    let view = crewIntegration(store, { threadId: lead.id });
    assert.equal(view.verifyStale, false);

    const worker = workOn(forkWorker("A"), "a.txt", "a\n");
    integrateWorker({
      store,
      leadThreadId: lead.id,
      workerThreadId: worker.id,
    });
    view = crewIntegration(store, { threadId: lead.id });
    assert.equal(view.verifyStale, true);
    assert.notEqual(view.leadHeadSha, sha);
  });
});
