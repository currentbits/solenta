const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { IPC_HANDLERS } = require("../ipc.js");
const { setupWorktree, maybeRenameWorktreeBranch } = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("threads:create with worktree", () => {
  let tmpDir;
  let store;
  let worktreeBase;
  let repo;
  let project;
  let broadcasts;
  let ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtcreate-"));
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

    project = services.addProject(store, repo);
    // The handler only touches store/worktreeBase/broadcast, so a plain
    // object is enough (no makeCtx side effects).
    ctx = {
      store,
      worktreeBase,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the thread with a worktree and placeholder branch", async () => {
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId: project.id,
      title: "New Thread",
      worktree: true,
    });

    const shortId = thread.id.slice(0, 6);
    assert.equal(thread.branch, `coder/new-thread-${shortId}`);
    assert.equal(thread.worktreePath, path.join(worktreeBase, thread.id));
    assert.ok(fs.existsSync(thread.worktreePath));

    const worktrees = git(repo, ["worktree", "list"]);
    assert.ok(worktrees.includes(thread.worktreePath));
    const branches = git(repo, ["branch", "--list"]);
    assert.ok(branches.includes(`coder/new-thread-${shortId}`));

    // Persisted, and the renderer was notified.
    const persisted = store.getThread(thread.id);
    assert.equal(persisted.worktreePath, thread.worktreePath);
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("without the flag, creates a plain local thread", async () => {
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId: project.id,
      title: "New Thread",
    });
    assert.equal(thread.worktreePath, null);
    assert.equal(thread.branch, null);
  });

  it("rolls the thread back when worktree creation fails", async () => {
    // Deterministic failure: worktreeBase is an existing file, so
    // setupWorktree's mkdirSync(recursive) throws before any git call.
    const blockedBase = path.join(tmpDir, "blocked-base");
    fs.writeFileSync(blockedBase, "not a dir\n");
    const blockedCtx = { ...ctx, worktreeBase: blockedBase };

    await assert.rejects(
      () =>
        IPC_HANDLERS["threads:create"](blockedCtx, {
          projectId: project.id,
          title: "New Thread",
          worktree: true,
        }),
    );
    // Atomic create: no half-created thread left behind.
    assert.equal(services.listThreads(store).length, 0);
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("rejects remote projects before touching the filesystem", async () => {
    services.updateProject(store, project.id, {
      remoteHost: "example.com",
      remotePath: "/srv/repo",
    });

    await assert.rejects(
      () =>
        IPC_HANDLERS["threads:create"](ctx, {
          projectId: project.id,
          title: "New Thread",
          worktree: true,
        }),
      /not available for remote projects/,
    );
    assert.equal(services.listThreads(store).length, 0);
  });
});

describe("maybeRenameWorktreeBranch", () => {
  let tmpDir;
  let store;
  let worktreeBase;
  let repo;
  let project;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtrename-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    project = services.addProject(store, repo);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createWorktreeThread(title) {
    const thread = services.createThread(store, {
      projectId: project.id,
      title,
    });
    return setupWorktree({ store, threadId: thread.id, worktreeBase });
  }

  it("renames the placeholder branch to match the promoted title", () => {
    const thread = createWorktreeThread("New Thread");
    const shortId = thread.id.slice(0, 6);
    assert.equal(thread.branch, `coder/new-thread-${shortId}`);

    const updated = maybeRenameWorktreeBranch({
      store,
      threadId: thread.id,
      newTitle: "Add login page",
    });
    assert.equal(updated.branch, `coder/add-login-page-${shortId}`);
    assert.equal(
      store.getThread(thread.id).branch,
      `coder/add-login-page-${shortId}`,
    );
    const current = git(thread.worktreePath, ["branch", "--show-current"]);
    assert.equal(current, `coder/add-login-page-${shortId}`);
    const branches = git(repo, ["branch", "--list"]);
    assert.ok(!branches.includes(`coder/new-thread-${shortId}`));
  });

  it("never touches a non-placeholder branch", () => {
    const thread = createWorktreeThread("My Feature Work");
    const before = thread.branch;
    assert.match(before, /^coder\/my-feature-work-/);

    const result = maybeRenameWorktreeBranch({
      store,
      threadId: thread.id,
      newTitle: "Something else",
    });
    assert.equal(result, null);
    assert.equal(store.getThread(thread.id).branch, before);
    assert.equal(
      git(thread.worktreePath, ["branch", "--show-current"]),
      before,
    );
  });

  it("no-ops for threads without a worktree", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    const result = maybeRenameWorktreeBranch({
      store,
      threadId: thread.id,
      newTitle: "Add login page",
    });
    assert.equal(result, null);
    assert.equal(store.getThread(thread.id).branch, null);
  });

  it("tolerates a deleted worktree dir without throwing", () => {
    const thread = createWorktreeThread("New Thread");
    fs.rmSync(thread.worktreePath, { recursive: true, force: true });

    const result = maybeRenameWorktreeBranch({
      store,
      threadId: thread.id,
      newTitle: "Add login page",
    });
    assert.equal(result, null);
    // Branch record untouched when git fails.
    assert.equal(store.getThread(thread.id).branch, thread.branch);
  });

  it("no-ops when the promoted title slugifies to the same branch", () => {
    const thread = createWorktreeThread("New Thread");
    const result = maybeRenameWorktreeBranch({
      store,
      threadId: thread.id,
      newTitle: "new thread",
    });
    assert.equal(result, null);
    assert.equal(store.getThread(thread.id).branch, thread.branch);
  });
});
