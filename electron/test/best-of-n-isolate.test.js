/**
 * Issue #1223: Best of N implementation candidates get isolated worktrees
 * from a shared committed start snapshot. Real-git fixture: two candidate
 * paths, independent edits, no live agents.
 *
 * Run: node --test electron/test/best-of-n-isolate.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree } = require("../worktrees.js");

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

describe("Best of N isolated fork (#1223)", () => {
  let tmpDir;
  let store;
  let project;
  let source;
  let worktreeBase;
  let repo;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-bon-iso-"));
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
    source = services.createThread(store, {
      projectId: project.id,
      title: "Race source",
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

  function materialize(threadId) {
    return setupWorktree({
      store,
      threadId,
      worktreeBase,
    });
  }

  it("two isolate forks share one captured start and keep independent trees", () => {
    const startSha = head(repo);
    const first = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
      isolate: true,
    });
    assert.equal(first.pendingWorktree, true);
    assert.equal(first.leadSnapshotSha, startSha);
    assert.equal(first.leadSnapshotBranch, "main");
    assert.notEqual(first.leadSnapshotDirty, true);
    assert.equal(first.baseBranch, null, "start ref is not the merge destination");
    assert.equal(first.orchWorker, undefined);
    assert.equal(first.worktreePath, null, "lazy: nothing on disk until setup");

    fs.writeFileSync(path.join(repo, "later.txt"), "source advanced\n");
    git(repo, ["add", "later.txt"]);
    git(repo, ["commit", "-m", "source advanced"]);
    const later = head(repo);
    assert.notEqual(later, startSha);

    const second = services.forkThread(store, {
      threadId: source.id,
      provider: "codex",
      isolate: true,
      leadSnapshotSha: first.leadSnapshotSha,
      leadSnapshotBranch: first.leadSnapshotBranch,
      leadSnapshotDirty: first.leadSnapshotDirty,
    });
    assert.equal(second.leadSnapshotSha, startSha);
    assert.equal(second.leadSnapshotBranch, "main");
    assert.notEqual(second.id, first.id);

    const a = materialize(first.id);
    const b = materialize(second.id);
    assert.equal(head(a.worktreePath), startSha);
    assert.equal(head(b.worktreePath), startSha);
    assert.notEqual(a.worktreePath, b.worktreePath);
    assert.notEqual(a.branch, b.branch);
    assert.notEqual(a.worktreePath, repo);
    assert.ok(!fs.existsSync(path.join(a.worktreePath, "later.txt")));
    assert.ok(!fs.existsSync(path.join(b.worktreePath, "later.txt")));

    fs.writeFileSync(path.join(a.worktreePath, "candidate-a.txt"), "from A\n");
    fs.writeFileSync(path.join(b.worktreePath, "candidate-b.txt"), "from B\n");
    assert.ok(!fs.existsSync(path.join(b.worktreePath, "candidate-a.txt")));
    assert.ok(!fs.existsSync(path.join(a.worktreePath, "candidate-b.txt")));
    assert.ok(!fs.existsSync(path.join(repo, "candidate-a.txt")));
    assert.ok(!fs.existsSync(path.join(repo, "candidate-b.txt")));
    assert.equal(head(repo), later);
  });

  it("does not copy, commit, or claim uncommitted source edits", () => {
    const startSha = head(repo);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n");
    assert.ok(git(repo, ["status", "--porcelain"]));

    const fork = services.forkThread(store, {
      threadId: source.id,
      isolate: true,
    });
    assert.equal(fork.leadSnapshotSha, startSha);
    assert.equal(fork.leadSnapshotDirty, true);
    assert.equal(head(repo), startSha, "source was not auto-committed");
    assert.ok(fs.existsSync(path.join(repo, "dirty.txt")));

    const wt = materialize(fork.id);
    assert.equal(head(wt.worktreePath), startSha);
    assert.ok(!fs.existsSync(path.join(wt.worktreePath, "dirty.txt")));
    assert.match(git(repo, ["status", "--porcelain"]), /dirty\.txt/);
  });

  it("copies stacked baseBranch as merge dest without using it as the start", () => {
    store.updateThread(source.id, { baseBranch: "develop" });
    store.save();
    const startSha = head(repo);
    const fork = services.forkThread(store, {
      threadId: source.id,
      isolate: true,
    });
    assert.equal(fork.baseBranch, "develop");
    assert.equal(fork.leadSnapshotSha, startSha);
    assert.notEqual(fork.leadSnapshotSha, fork.baseBranch);
    assert.equal(fork.leadSnapshotBranch, "main");
  });

  it("refuses Ask, remote, non-git, and unsupported scm before creating a thread", async () => {
    const before = services.listThreads(store).length;

    services.startAsk(store, { threadId: source.id });
    assert.throws(
      () => services.forkThread(store, { threadId: source.id, isolate: true }),
      /Ask threads stay in the shared checkout/,
    );
    assert.equal(services.listThreads(store).length, before);
    services.stopAsk(store, { threadId: source.id });

    const remote = services.updateProject(store, project.id, {
      remoteHost: "dev@box",
      remotePath: "/srv/app",
    });
    assert.equal(remote.remoteHost, "dev@box");
    assert.throws(
      () => services.forkThread(store, { threadId: source.id, isolate: true }),
      /remote projects cannot host git worktrees/,
    );
    assert.equal(services.listThreads(store).length, before);
    services.updateProject(store, project.id, { remoteHost: "", remotePath: "" });

    fs.mkdirSync(path.join(repo, ".jj"));
    assert.throws(
      () => services.forkThread(store, { threadId: source.id, isolate: true }),
      /Cannot isolate this fork: Jujutsu/,
    );
    assert.equal(services.listThreads(store).length, before);
    fs.rmSync(path.join(repo, ".jj"), { recursive: true, force: true });

    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    assert.throws(
      () => services.forkThread(store, { threadId: source.id, isolate: true }),
      /not a local git repository/,
    );
    assert.equal(services.listThreads(store).length, before);
  });

  it("keeps the first isolated candidate when a later fork fails", () => {
    const first = services.forkThread(store, {
      threadId: source.id,
      provider: "claude",
      isolate: true,
    });
    const before = services.listThreads(store).length;
    assert.throws(
      () =>
        services.forkThread(store, {
          threadId: source.id,
          provider: "not-a-provider",
          isolate: true,
          leadSnapshotSha: first.leadSnapshotSha,
        }),
      /Unknown provider: not-a-provider/,
    );
    assert.equal(services.listThreads(store).length, before);
    const kept = store.getThread(first.id);
    assert.ok(kept);
    assert.equal(kept.pendingWorktree, true);
    assert.equal(kept.leadSnapshotSha, first.leadSnapshotSha);
    assert.equal(kept.worktreePath, null);
  });

  it("does not change ordinary Fork, worktree:true chips, or worktree:false workers", () => {
    const plain = services.forkThread(store, { threadId: source.id });
    assert.equal(plain.pendingWorktree, undefined);
    assert.equal(plain.leadSnapshotSha, undefined);
    assert.equal(plain.orchWorker, undefined);

    const chip = services.forkThread(store, {
      threadId: source.id,
      worktree: true,
    });
    assert.equal(chip.pendingWorktree, true);
    assert.equal(chip.leadSnapshotSha, undefined);
    assert.equal(chip.orchWorker, undefined);

    const research = services.forkWorkerThread(store, {
      threadId: source.id,
      worktree: false,
    });
    assert.equal(research.orchWorker, true);
    assert.equal(research.pendingWorktree, undefined);
    assert.equal(research.leadSnapshotSha, undefined);
  });
});
