/**
 * Issue #948: orchestration workers start from a recorded snapshot of the
 * lead's committed HEAD, not from main / ThreadInfo.baseBranch.
 *
 * Run: node --test electron/test/worker-snapshot.test.js
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
const { crewIntegration } = require("../crewIntegration.js");

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

describe("orchestration worker start snapshot (#948)", () => {
  let tmpDir;
  let store;
  let project;
  let lead;
  let worktreeBase;
  let repo;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtsnap-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

    repo = path.join(tmpDir, "app");
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

  function setupLeadApi() {
    const leadWt = setupWorktree({
      store,
      threadId: lead.id,
      worktreeBase,
    });
    fs.writeFileSync(path.join(leadWt.worktreePath, "api.txt"), "from lead\n");
    git(leadWt.worktreePath, ["add", "api.txt"]);
    git(leadWt.worktreePath, ["commit", "-m", "lead api"]);
    return store.getThread(lead.id);
  }

  function materialize(threadId) {
    return setupWorktree({
      store,
      threadId,
      worktreeBase,
    });
  }

  it("records the lead HEAD at fork and the worker worktree contains that commit", () => {
    const leadWt = setupLeadApi();
    const snap = head(leadWt.worktreePath);
    const branch = store.getThread(lead.id).branch;

    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    const stored = store.getThread(worker.id);
    assert.equal(stored.leadSnapshotSha, snap);
    assert.equal(stored.leadSnapshotBranch, branch);
    assert.notEqual(stored.leadSnapshotDirty, true);
    assert.equal(stored.baseBranch, null, "start ref is not the merge destination");
    assert.equal(stored.handoffFrom, lead.id);
    assert.equal(stored.pendingWorktree, true);
    assert.equal(stored.worktreePath, null, "lazy: nothing on disk until setup");

    const wt = materialize(worker.id);
    assert.equal(head(wt.worktreePath), snap);
    assert.equal(
      fs.readFileSync(path.join(wt.worktreePath, "api.txt"), "utf8"),
      "from lead\n",
    );
    assert.equal(store.getThread(worker.id).baseBranch, null);
  });

  it("materializes from the recorded SHA even if the lead advances after fork", () => {
    const leadWt = setupLeadApi();
    const snap = head(leadWt.worktreePath);

    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    assert.equal(store.getThread(worker.id).leadSnapshotSha, snap);

    fs.writeFileSync(path.join(leadWt.worktreePath, "later.txt"), "newer\n");
    git(leadWt.worktreePath, ["add", "later.txt"]);
    git(leadWt.worktreePath, ["commit", "-m", "lead advanced"]);
    const later = head(leadWt.worktreePath);
    assert.notEqual(later, snap);

    const wt = materialize(worker.id);
    assert.equal(head(wt.worktreePath), snap);
    assert.ok(fs.existsSync(path.join(wt.worktreePath, "api.txt")));
    assert.ok(!fs.existsSync(path.join(wt.worktreePath, "later.txt")));
  });

  it("a later dependent worker sees the newer integrated snapshot", () => {
    const leadWt = setupLeadApi();
    const firstSnap = head(leadWt.worktreePath);
    const first = services.forkWorkerThread(store, { threadId: lead.id });

    fs.writeFileSync(path.join(leadWt.worktreePath, "v2.txt"), "second wave\n");
    git(leadWt.worktreePath, ["add", "v2.txt"]);
    git(leadWt.worktreePath, ["commit", "-m", "integrated next"]);
    const secondSnap = head(leadWt.worktreePath);
    const second = services.forkWorkerThread(store, { threadId: lead.id });

    assert.equal(store.getThread(first.id).leadSnapshotSha, firstSnap);
    assert.equal(store.getThread(second.id).leadSnapshotSha, secondSnap);
    assert.notEqual(firstSnap, secondSnap);

    const firstWt = materialize(first.id);
    const secondWt = materialize(second.id);
    assert.ok(!fs.existsSync(path.join(firstWt.worktreePath, "v2.txt")));
    assert.ok(fs.existsSync(path.join(secondWt.worktreePath, "v2.txt")));
  });

  it("does not leak or commit dirty lead edits", () => {
    const leadWt = setupLeadApi();
    const snap = head(leadWt.worktreePath);
    fs.writeFileSync(path.join(leadWt.worktreePath, "dirty.txt"), "uncommitted\n");
    assert.ok(git(leadWt.worktreePath, ["status", "--porcelain"]));

    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    const stored = store.getThread(worker.id);
    assert.equal(stored.leadSnapshotSha, snap);
    assert.equal(stored.leadSnapshotDirty, true);
    assert.equal(head(leadWt.worktreePath), snap, "lead was not auto-committed");
    assert.ok(
      fs.existsSync(path.join(leadWt.worktreePath, "dirty.txt")),
      "lead dirty file stays on the lead",
    );

    const wt = materialize(worker.id);
    assert.equal(head(wt.worktreePath), snap);
    assert.ok(!fs.existsSync(path.join(wt.worktreePath, "dirty.txt")));
    assert.match(
      git(leadWt.worktreePath, ["status", "--porcelain"]),
      /dirty\.txt/,
    );
  });

  it("fails actionably when the recorded snapshot is missing, and does not start on main", () => {
    setupLeadApi();
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    store.updateThread(worker.id, {
      leadSnapshotSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    store.save();
    const mainHead = head(repo);

    assert.throws(
      () => materialize(worker.id),
      /snapshot|refusing to fall back to main/i,
    );
    assert.equal(store.getThread(worker.id).worktreePath, null);
    assert.equal(head(repo), mainHead);
  });

  it("fails actionably when an orch worker has no recorded snapshot", () => {
    const worker = services.createThread(store, {
      projectId: project.id,
      title: "Handmade worker",
    });
    store.updateThread(worker.id, {
      orchWorker: true,
      pendingWorktree: true,
      handoffFrom: lead.id,
    });
    store.save();

    assert.throws(
      () => materialize(worker.id),
      /no recorded lead snapshot|refusing to fall back to main/i,
    );
    assert.equal(store.getThread(worker.id).worktreePath, null);
  });

  it("refuses to fork a worktree worker when the lead has no committed HEAD", async () => {
    const empty = path.join(tmpDir, "empty");
    fs.mkdirSync(empty);
    git(empty, ["init"]);
    const emptyProject = await services.addProject(store, empty);
    const emptyLead = services.createThread(store, {
      projectId: emptyProject.id,
      title: "Empty lead",
    });
    const before = services.listThreads(store).length;
    assert.throws(
      () => services.forkWorkerThread(store, { threadId: emptyLead.id }),
      /will not start from main|no committed HEAD/i,
    );
    assert.equal(services.listThreads(store).length, before);
  });

  it("leaves ordinary independent threads and no-worktree workers on the default start", () => {
    const mainHead = head(repo);
    git(repo, ["checkout", "-b", "coder/feature-checkout"]);
    fs.writeFileSync(path.join(repo, "feature-only.txt"), "on feature\n");
    git(repo, ["add", "feature-only.txt"]);
    git(repo, ["commit", "-m", "feature"]);

    const independent = services.createThread(store, {
      projectId: project.id,
      title: "Plain worktree",
    });
    assert.equal(independent.leadSnapshotSha, undefined);
    const plain = materialize(independent.id);
    assert.equal(head(plain.worktreePath), mainHead);
    assert.ok(!fs.existsSync(path.join(plain.worktreePath, "feature-only.txt")));

    const userFork = services.forkThread(store, {
      threadId: lead.id,
      worktree: true,
    });
    assert.equal(store.getThread(userFork.id).leadSnapshotSha, undefined);
    assert.equal(store.getThread(userFork.id).orchWorker, undefined);

    const optedOut = services.forkWorkerThread(store, {
      threadId: lead.id,
      worktree: false,
    });
    assert.equal(store.getThread(optedOut.id).pendingWorktree, undefined);
    assert.equal(store.getThread(optedOut.id).leadSnapshotSha, undefined);
    assert.equal(store.getThread(optedOut.id).orchWorker, true);
  });

  it("exposes the source branch and SHA on the lead worker list, separate from the merge destination", () => {
    const leadWt = setupLeadApi();
    const snap = head(leadWt.worktreePath);
    const branch = store.getThread(lead.id).branch;
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    materialize(worker.id);

    const view = crewIntegration(store, { threadId: lead.id });
    const row = view.workers.find((w) => w.workerId === worker.id);
    assert.ok(row);
    assert.equal(row.sourceSha, snap);
    assert.equal(row.sourceBranch, branch);
    assert.equal(view.finalTarget, "main");
    assert.equal(store.getThread(worker.id).baseBranch, null);
    assert.equal(store.getThread(worker.id).handoffFrom, lead.id);
  });
});

describe("refresh worker onto lead snapshot", () => {
  let tmpDir;
  let store;
  let project;
  let lead;
  let worktreeBase;
  let repo;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtrefresh-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

    repo = path.join(tmpDir, "app");
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

  function setupLeadApi() {
    const leadWt = setupWorktree({
      store,
      threadId: lead.id,
      worktreeBase,
    });
    fs.writeFileSync(path.join(leadWt.worktreePath, "api.txt"), "from lead\n");
    git(leadWt.worktreePath, ["add", "api.txt"]);
    git(leadWt.worktreePath, ["commit", "-m", "lead api"]);
    return store.getThread(lead.id);
  }

  function materialize(threadId) {
    return setupWorktree({
      store,
      threadId,
      worktreeBase,
    });
  }

  function advanceLead(leadWt, name, body) {
    fs.writeFileSync(path.join(leadWt.worktreePath, name), body);
    git(leadWt.worktreePath, ["add", name]);
    git(leadWt.worktreePath, ["commit", "-m", `lead ${name}`]);
    return head(leadWt.worktreePath);
  }

  it("retargets an idle materialized worker onto the lead HEAD without changing baseBranch", () => {
    const leadWt = setupLeadApi();
    const first = head(leadWt.worktreePath);
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    const wt = materialize(worker.id);
    assert.equal(head(wt.worktreePath), first);

    const later = advanceLead(leadWt, "later.txt", "newer\n");
    assert.notEqual(later, first);

    const updated = services.refreshWorkerSnapshot(store, {
      threadId: worker.id,
    });
    assert.equal(updated.leadSnapshotSha, later);
    assert.equal(updated.leadSnapshotBranch, store.getThread(lead.id).branch);
    assert.notEqual(updated.leadSnapshotDirty, true);
    assert.equal(updated.baseBranch, null);
    assert.equal(head(wt.worktreePath), later);
    assert.equal(
      fs.readFileSync(path.join(wt.worktreePath, "later.txt"), "utf8"),
      "newer\n",
    );
    assert.equal(store.getThread(worker.id).baseBranch, null);
  });

  it("rebases the worker's unique commits onto the new snapshot", () => {
    const leadWt = setupLeadApi();
    const first = head(leadWt.worktreePath);
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    const wt = materialize(worker.id);
    fs.writeFileSync(path.join(wt.worktreePath, "worker.txt"), "mine\n");
    git(wt.worktreePath, ["add", "worker.txt"]);
    git(wt.worktreePath, ["commit", "-m", "worker unique"]);

    const later = advanceLead(leadWt, "later.txt", "newer\n");
    services.refreshWorkerSnapshot(store, { threadId: worker.id });

    assert.equal(store.getThread(worker.id).leadSnapshotSha, later);
    assert.equal(store.getThread(worker.id).baseBranch, null);
    assert.equal(
      fs.readFileSync(path.join(wt.worktreePath, "worker.txt"), "utf8"),
      "mine\n",
    );
    assert.equal(
      fs.readFileSync(path.join(wt.worktreePath, "later.txt"), "utf8"),
      "newer\n",
    );
    assert.equal(git(wt.worktreePath, ["merge-base", "HEAD", later]), later);
    assert.notEqual(head(wt.worktreePath), later);
    assert.notEqual(head(wt.worktreePath), first);
  });

  it("updates a pending worker's recorded snapshot so later setup starts there", () => {
    const leadWt = setupLeadApi();
    const first = head(leadWt.worktreePath);
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    assert.equal(store.getThread(worker.id).worktreePath, null);
    assert.equal(store.getThread(worker.id).leadSnapshotSha, first);

    const later = advanceLead(leadWt, "later.txt", "newer\n");
    services.refreshWorkerSnapshot(store, { threadId: worker.id });
    assert.equal(store.getThread(worker.id).leadSnapshotSha, later);
    assert.equal(store.getThread(worker.id).worktreePath, null);
    assert.equal(store.getThread(worker.id).baseBranch, null);

    const wt = materialize(worker.id);
    assert.equal(head(wt.worktreePath), later);
    assert.ok(fs.existsSync(path.join(wt.worktreePath, "later.txt")));
  });

  it("does not copy dirty lead edits and notes inherits committed work only", () => {
    const leadWt = setupLeadApi();
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    materialize(worker.id);

    const later = advanceLead(leadWt, "later.txt", "newer\n");
    fs.writeFileSync(path.join(leadWt.worktreePath, "dirty.txt"), "uncommitted\n");
    assert.ok(git(leadWt.worktreePath, ["status", "--porcelain"]));

    const updated = services.refreshWorkerSnapshot(store, {
      threadId: worker.id,
    });
    assert.equal(updated.leadSnapshotSha, later);
    assert.equal(updated.leadSnapshotDirty, true);
    assert.equal(head(leadWt.worktreePath), later, "lead was not auto-committed");
    assert.ok(fs.existsSync(path.join(leadWt.worktreePath, "dirty.txt")));

    const wt = store.getThread(worker.id);
    assert.ok(!fs.existsSync(path.join(wt.worktreePath, "dirty.txt")));
    assert.match(
      git(leadWt.worktreePath, ["status", "--porcelain"]),
      /dirty\.txt/,
    );
  });

  it("refuses a running worker and leaves the old snapshot", () => {
    const leadWt = setupLeadApi();
    const first = head(leadWt.worktreePath);
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    const wt = materialize(worker.id);
    store.updateThread(worker.id, { status: "working" });
    store.save();
    advanceLead(leadWt, "later.txt", "newer\n");

    assert.throws(
      () => services.refreshWorkerSnapshot(store, { threadId: worker.id }),
      /idle|not running|working/i,
    );
    const stored = store.getThread(worker.id);
    assert.equal(stored.leadSnapshotSha, first);
    assert.equal(head(wt.worktreePath), first);
    assert.ok(!fs.existsSync(path.join(wt.worktreePath, "later.txt")));
  });

  it("fails actionably when the lead has no committed HEAD, and does not fall back to main", () => {
    const empty = path.join(tmpDir, "empty");
    fs.mkdirSync(empty);
    git(empty, ["init"]);
    return services.addProject(store, empty).then((emptyProject) => {
      const emptyLead = services.createThread(store, {
        projectId: emptyProject.id,
        title: "Empty lead",
      });
      const worker = services.createThread(store, {
        projectId: emptyProject.id,
        title: "Worker",
      });
      store.updateThread(worker.id, {
        orchWorker: true,
        pendingWorktree: true,
        handoffFrom: emptyLead.id,
        leadSnapshotSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      });
      store.save();
      const mainHead = head(repo);
      assert.throws(
        () => services.refreshWorkerSnapshot(store, { threadId: worker.id }),
        /no committed HEAD|will not start from main|refusing to fall back to main/i,
      );
      assert.equal(
        store.getThread(worker.id).leadSnapshotSha,
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      );
      assert.equal(head(repo), mainHead);
    });
  });

  it("leaves a parallel worker on its original snapshot", () => {
    const leadWt = setupLeadApi();
    const first = head(leadWt.worktreePath);
    const kept = services.forkWorkerThread(store, { threadId: lead.id });
    const refreshed = services.forkWorkerThread(store, { threadId: lead.id });
    materialize(kept.id);
    materialize(refreshed.id);

    const later = advanceLead(leadWt, "later.txt", "newer\n");
    services.refreshWorkerSnapshot(store, { threadId: refreshed.id });

    assert.equal(store.getThread(kept.id).leadSnapshotSha, first);
    assert.equal(store.getThread(refreshed.id).leadSnapshotSha, later);
    assert.ok(
      !fs.existsSync(path.join(store.getThread(kept.id).worktreePath, "later.txt")),
    );
    assert.ok(
      fs.existsSync(
        path.join(store.getThread(refreshed.id).worktreePath, "later.txt"),
      ),
    );
  });

  it("refuses ordinary independent threads and no-worktree workers", () => {
    setupLeadApi();
    const independent = services.createThread(store, {
      projectId: project.id,
      title: "Plain",
    });
    assert.throws(
      () =>
        services.refreshWorkerSnapshot(store, { threadId: independent.id }),
      /orchestration worker|worktree worker/i,
    );

    const optedOut = services.forkWorkerThread(store, {
      threadId: lead.id,
      worktree: false,
    });
    assert.throws(
      () => services.refreshWorkerSnapshot(store, { threadId: optedOut.id }),
      /worktree/i,
    );
    assert.equal(store.getThread(optedOut.id).leadSnapshotSha, undefined);
  });

  it("exposes the new source branch and SHA on the lead worker list", () => {
    const leadWt = setupLeadApi();
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    materialize(worker.id);
    const later = advanceLead(leadWt, "later.txt", "newer\n");
    const branch = store.getThread(lead.id).branch;
    services.refreshWorkerSnapshot(store, { threadId: worker.id });

    const view = crewIntegration(store, { threadId: lead.id });
    const row = view.workers.find((w) => w.workerId === worker.id);
    assert.ok(row);
    assert.equal(row.sourceSha, later);
    assert.equal(row.sourceBranch, branch);
    assert.equal(view.finalTarget, "main");
    assert.equal(store.getThread(worker.id).baseBranch, null);
  });

  it("leaves the recorded snapshot unchanged when rebase conflicts", () => {
    const leadWt = setupLeadApi();
    const first = head(leadWt.worktreePath);
    const worker = services.forkWorkerThread(store, { threadId: lead.id });
    const wt = materialize(worker.id);
    fs.writeFileSync(path.join(wt.worktreePath, "api.txt"), "worker edit\n");
    git(wt.worktreePath, ["add", "api.txt"]);
    git(wt.worktreePath, ["commit", "-m", "worker edits api"]);

    fs.writeFileSync(path.join(leadWt.worktreePath, "api.txt"), "lead edit\n");
    git(leadWt.worktreePath, ["add", "api.txt"]);
    git(leadWt.worktreePath, ["commit", "-m", "lead edits api"]);
    const later = head(leadWt.worktreePath);

    assert.throws(
      () => services.refreshWorkerSnapshot(store, { threadId: worker.id }),
      /WORKTREE_REBASE_CONFLICT/,
    );
    const stored = store.getThread(worker.id);
    assert.equal(stored.leadSnapshotSha, first);
    assert.notEqual(stored.leadSnapshotSha, later);
    assert.equal(
      fs.readFileSync(path.join(wt.worktreePath, "api.txt"), "utf8"),
      "worker edit\n",
    );
  });
});
