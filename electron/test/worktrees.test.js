const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, diff } = require("../worktrees.js");

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
});
