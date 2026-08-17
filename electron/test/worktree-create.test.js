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

  beforeEach(async () => {
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

    project = await services.addProject(store, repo);
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

  it("marks the thread pendingWorktree without touching git (lazy, t3-style)", async () => {
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId: project.id,
      title: "New Thread",
      worktree: true,
    });

    // Nothing on disk until the first run: no dir, no branch, no registration.
    assert.equal(thread.pendingWorktree, true);
    assert.equal(thread.worktreePath, null);
    assert.equal(thread.branch, null);
    assert.ok(!fs.existsSync(worktreeBase));
    const branches = git(repo, ["branch", "--list", "coder/*"]);
    assert.equal(branches, "");

    // Persisted, and the renderer was notified.
    const persisted = store.getThread(thread.id);
    assert.equal(persisted.pendingWorktree, true);
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("pendingWorktree threads delete cleanly without a Git-tab detour", async () => {
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId: project.id,
      title: "New Thread",
      worktree: true,
    });
    // worktreePath is null, so deleteThread's worktree guard must not fire.
    services.deleteThread(store, { threadId: thread.id });
    assert.equal(services.listThreads(store).length, 0);
  });

  it("without the flag, creates a plain local thread", async () => {
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId: project.id,
      title: "New Thread",
    });
    assert.equal(thread.worktreePath, null);
    assert.equal(thread.branch, null);
  });

  it("rolls the thread back when worktreeBase is not configured", async () => {
    const blockedCtx = { ...ctx, worktreeBase: "" };

    await assert.rejects(
      () =>
        IPC_HANDLERS["threads:create"](blockedCtx, {
          projectId: project.id,
          title: "New Thread",
          worktree: true,
        }),
      /worktreeBase is not configured/,
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

  it("orchestrate marks pendingFork and never a worktree of its own", async () => {
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId: project.id,
      title: "New Thread",
      orchestrate: true,
      // Ignored: the WORKER holds the worktree, never the orchestrator.
      worktree: true,
    });

    assert.equal(thread.pendingFork, true);
    assert.equal(thread.pendingWorktree, undefined);
    assert.equal(thread.worktreePath, null);
    assert.ok(!fs.existsSync(worktreeBase));
  });

  it("orchestrate is rejected for remote projects, atomically", async () => {
    const remote = await services.addProject(store, repo);
    services.updateProject(store, remote.id, {
      remoteHost: "box",
      remotePath: "/srv/app",
    });
    const before = store.getThreads().length;

    await assert.rejects(
      () =>
        IPC_HANDLERS["threads:create"](ctx, {
          projectId: remote.id,
          title: "New Thread",
          orchestrate: true,
        }),
      /not available for remote projects/,
    );
    assert.equal(store.getThreads().length, before);
  });
});

describe("maybeRenameWorktreeBranch", () => {
  let tmpDir;
  let store;
  let worktreeBase;
  let repo;
  let project;

  beforeEach(async () => {
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

    project = await services.addProject(store, repo);
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
