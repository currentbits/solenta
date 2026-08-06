const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  setupWorktree,
  diff,
  mergeWorktree,
  removeWorktree,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("worktrees", () => {
  let tmpDir;
  let store;
  let repo;
  let project;
  let thread;
  let worktreeBase;
  let broadcasts;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wt-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");
    broadcasts = [];

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    // Ensure a real branch name for worktree base
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main/master
    }

    project = services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "My Feature Work",
    });
  });

  afterEach(() => {
    // Remove worktrees first so rm of tmpDir succeeds
    try {
      const list = git(repo, ["worktree", "list", "--porcelain"]);
      // best-effort cleanup via store paths
      const t = store.getThread(thread.id);
      if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
        try {
          git(repo, ["worktree", "remove", "--force", t.worktreePath]);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("setupWorktree creates branch and worktree, is idempotent", () => {
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.ok(updated.worktreePath);
    assert.ok(fs.existsSync(updated.worktreePath));
    assert.ok(fs.existsSync(path.join(updated.worktreePath, "README.md")));
    assert.ok(updated.branch);
    assert.match(updated.branch, /^coder\//);
    assert.ok(updated.branch.includes(thread.id.slice(0, 6)));
    assert.match(updated.branch, /my-feature-work/i);

    const branchInWt = git(updated.worktreePath, ["branch", "--show-current"]);
    assert.equal(branchInWt, updated.branch);

    assert.ok(broadcasts.some((b) => b.ch === "threads:changed"));

    const again = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });
    assert.equal(again.worktreePath, updated.worktreePath);
    assert.equal(again.branch, updated.branch);
  });

  it("diff reports modified and untracked files with patch", () => {
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    fs.writeFileSync(
      path.join(updated.worktreePath, "README.md"),
      "hello\nworld\n",
    );
    fs.writeFileSync(
      path.join(updated.worktreePath, "new-file.txt"),
      "line1\nline2\nline3\n",
    );
    // Untracked directory: -uall must list the inner file individually,
    // never a collapsed "?? newdir/" row.
    fs.mkdirSync(path.join(updated.worktreePath, "newdir"));
    fs.writeFileSync(
      path.join(updated.worktreePath, "newdir", "inner.txt"),
      "a\nb\n",
    );

    const result = diff({ store, threadId: thread.id });

    assert.ok(Array.isArray(result.files));
    assert.equal(typeof result.patch, "string");
    assert.equal(typeof result.truncated, "boolean");

    // Exact count: README.md + new-file.txt + newdir/inner.txt. Phantom or
    // mangled rows (e.g. "EADME.md" from trimming the XY column) must fail.
    assert.equal(
      result.files.length,
      3,
      `files=${JSON.stringify(result.files)}`,
    );
    const paths = result.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["README.md", "new-file.txt", "newdir/inner.txt"]);

    const readme = result.files.find((f) => f.path === "README.md");
    assert.ok(readme, `files=${JSON.stringify(result.files)}`);
    assert.match(readme.status, /M/);
    assert.ok(readme.additions >= 1);

    const untracked = result.files.find((f) => f.path === "new-file.txt");
    assert.ok(untracked, `files=${JSON.stringify(result.files)}`);
    assert.equal(untracked.status, "??");
    assert.equal(untracked.additions, 3);
    assert.equal(untracked.deletions, 0);

    const inner = result.files.find((f) => f.path === "newdir/inner.txt");
    assert.ok(inner, `files=${JSON.stringify(result.files)}`);
    assert.equal(inner.status, "??");
    assert.equal(inner.additions, 2);

    assert.ok(
      result.patch.includes("README.md") || result.patch.includes("hello"),
      `patch should mention README changes: ${result.patch.slice(0, 200)}`,
    );
  });

  it("mergeWorktree commits worktree changes, squash-merges, cleans up", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    fs.writeFileSync(path.join(wtPath, "feature.txt"), "from worktree\n");

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(merged.worktreePath, null);
    assert.equal(merged.branch, null);
    assert.ok(fs.existsSync(path.join(repo, "feature.txt")));
    assert.equal(
      fs.readFileSync(path.join(repo, "feature.txt"), "utf8"),
      "from worktree\n",
    );
    assert.ok(!fs.existsSync(wtPath));

    const branches = git(repo, ["branch"]);
    assert.ok(
      !branches.includes(branch),
      `branch ${branch} should be deleted: ${branches}`,
    );

    const log = git(repo, ["log", "-1", "--oneline"]);
    assert.match(log, /Merge worktree/i);
    assert.match(log, new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const stored = store.getThread(thread.id);
    assert.equal(stored.worktreePath, null);
    assert.equal(stored.branch, null);
    assert.ok(broadcasts.some((b) => b.ch === "threads:changed"));
  });

  it("mergeWorktree rejects on conflict and restores clean project checkout", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    // Divergent edits to the same file in project and worktree
    fs.writeFileSync(path.join(repo, "README.md"), "project side\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "project edit"]);

    fs.writeFileSync(path.join(setup.worktreePath, "README.md"), "worktree side\n");
    git(setup.worktreePath, ["add", "README.md"]);
    git(setup.worktreePath, ["commit", "-m", "worktree edit"]);

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          broadcast: () => {},
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          /conflict|CONFLICT|merge/i.test(err.message),
          `expected conflict message, got: ${err.message}`,
        );
        return true;
      },
    );

    // Project checkout restored clean
    const status = git(repo, ["status", "--porcelain"]);
    assert.equal(status, "", `project should be clean after abort: ${status}`);
    assert.equal(
      fs.readFileSync(path.join(repo, "README.md"), "utf8"),
      "project side\n",
    );

    // Worktree still present (nothing force-removed on failure)
    const still = store.getThread(thread.id);
    assert.ok(still.worktreePath);
    assert.ok(fs.existsSync(still.worktreePath));
  });

  it("removeWorktree without force rejects dirty worktree with WORKTREE_DIRTY", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    fs.writeFileSync(path.join(setup.worktreePath, "dirty.txt"), "uncommitted\n");

    assert.throws(
      () =>
        removeWorktree({
          store,
          threadId: thread.id,
          force: false,
          broadcast: () => {},
        }),
      (err) => {
        assert.ok(err instanceof Error);
        // Renderer detects via message.includes("WORKTREE_DIRTY:") after IPC wrap
        assert.ok(
          err.message.includes("WORKTREE_DIRTY:"),
          `message must contain WORKTREE_DIRTY: got ${err.message}`,
        );
        assert.ok(
          err.message.includes("dirty.txt"),
          `message must list the lost file: ${err.message}`,
        );
        return true;
      },
    );

    assert.ok(fs.existsSync(setup.worktreePath));
    const still = store.getThread(thread.id);
    assert.equal(still.worktreePath, setup.worktreePath);
  });

  it("removeWorktree without force rejects when project HEAD is detached", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    // Commit on worktree so there is something to lose
    fs.writeFileSync(path.join(wtPath, "orphan-me.txt"), "would be lost\n");
    git(wtPath, ["add", "orphan-me.txt"]);
    git(wtPath, ["commit", "-m", "unmerged feature"]);

    // Detach project checkout HEAD so default branch cannot be determined
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "--detach", headSha]);
    assert.equal(git(repo, ["branch", "--show-current"]), "");

    assert.throws(
      () =>
        removeWorktree({
          store,
          threadId: thread.id,
          force: false,
          broadcast: () => {},
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("WORKTREE_DIRTY:"),
          `must contain WORKTREE_DIRTY: got ${err.message}`,
        );
        // Lists recent commits on the branch (cannot prove merged)
        assert.ok(
          /unmerged:|unmerged feature|orphan/i.test(err.message),
          `must list branch commits: ${err.message}`,
        );
        return true;
      },
    );

    assert.ok(fs.existsSync(wtPath), "worktree must remain after reject");
    const still = store.getThread(thread.id);
    assert.equal(still.worktreePath, wtPath);
    assert.equal(still.branch, branch);

    // force still works while detached
    const removed = removeWorktree({
      store,
      threadId: thread.id,
      force: true,
      broadcast: () => {},
    });
    assert.equal(removed.worktreePath, null);
    assert.equal(removed.branch, null);
    assert.ok(!fs.existsSync(wtPath));
  });

  it("removeWorktree with force succeeds on dirty worktree", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    fs.writeFileSync(path.join(wtPath, "dirty.txt"), "uncommitted\n");

    const removed = removeWorktree({
      store,
      threadId: thread.id,
      force: true,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(removed.worktreePath, null);
    assert.equal(removed.branch, null);
    assert.ok(!fs.existsSync(wtPath));
    const branches = git(repo, ["branch"]);
    assert.ok(!branches.includes(branch));
    assert.ok(broadcasts.some((b) => b.ch === "threads:changed"));
  });

  it("removeWorktree on clean fully-merged worktree succeeds without force", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    // Commit a change in worktree, regular-merge into project so
    // defaultBranch..branch is empty (fully merged), leave worktree in place
    fs.writeFileSync(path.join(wtPath, "merged.txt"), "already merged\n");
    git(wtPath, ["add", "merged.txt"]);
    git(wtPath, ["commit", "-m", "feature"]);

    git(repo, ["merge", "--no-ff", "-m", "merge feature", branch]);

    const removed = removeWorktree({
      store,
      threadId: thread.id,
      force: false,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(removed.worktreePath, null);
    assert.equal(removed.branch, null);
    assert.ok(!fs.existsSync(wtPath));
    const branches = git(repo, ["branch"]);
    assert.ok(!branches.includes(branch));
  });
});
