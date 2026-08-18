"use strict";

/**
 * Worktree junk collection (t3-comparison round):
 * - maybeCleanupMergedWorktree: reclaim worktree+branch once the PR merged
 *   (only when the tree is clean and everything local was pushed).
 * - refreshPrStates: an OPEN→MERGED flip triggers that cleanup.
 * - sweepOrphanWorktrees: boot-time GC for worktree dirs no thread references
 *   (clean ones only — never deletes uncommitted work).
 * - ensureWorktree: lazy creation at first run for pendingWorktree threads.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const {
  setupWorktree,
  refreshPrStates,
  maybeCleanupMergedWorktree,
  sweepOrphanWorktrees,
  ensureWorktree,
  clearMissingWorktree,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Repo + project + one worktree thread with a committed feature file.
 * Origin: github fetch URL (so PR paths engage) with a local bare push URL.
 */
async function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtclean-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const worktreeBase = path.join(tmpDir, "worktrees");

  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  try {
    git(repo, ["checkout", "-b", "main"]);
  } catch {
    /* already on main */
  }

  const bare = path.join(tmpDir, "remote.git");
  git(tmpDir, ["init", "--bare", bare]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  git(repo, ["remote", "set-url", "--push", "origin", bare]);

  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Merged PR thread",
  });
  const setup = setupWorktree({
    store,
    threadId: thread.id,
    worktreeBase,
    broadcast: () => {},
  });
  fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feat\n");
  git(setup.worktreePath, ["add", "feature.txt"]);
  git(setup.worktreePath, ["commit", "-m", "feature"]);

  return {
    tmpDir,
    store,
    project,
    threadId: thread.id,
    worktreePath: setup.worktreePath,
    branch: setup.branch,
    worktreeBase,
    repo,
  };
}

function pushBranch(fx) {
  git(fx.worktreePath, ["push", "-u", "origin", fx.branch]);
}

function seedPr(fx, state) {
  fx.store.updateThread(fx.threadId, {
    prNumber: 7,
    prUrl: "https://github.com/acme/demo/pull/7",
    prState: state,
  });
  fx.store.saveNow();
}

describe("maybeCleanupMergedWorktree", () => {
  let fx;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it("removes worktree and branch when PR merged, tree clean, all pushed", async () => {
    pushBranch(fx);
    seedPr(fx, "MERGED");

    const result = await maybeCleanupMergedWorktree(fx.store, fx.threadId);
    assert.equal(result.cleaned, true);

    const thread = fx.store.getThread(fx.threadId);
    assert.equal(thread.worktreePath, null);
    assert.equal(thread.branch, null);
    assert.ok(!fs.existsSync(fx.worktreePath));
    const branches = git(fx.repo, ["branch", "--list", fx.branch]);
    assert.equal(branches, "");
  });

  it("skips when the worktree has uncommitted changes", async () => {
    pushBranch(fx);
    seedPr(fx, "MERGED");
    fs.writeFileSync(path.join(fx.worktreePath, "wip.txt"), "wip\n");

    const result = await maybeCleanupMergedWorktree(fx.store, fx.threadId);
    assert.equal(result.cleaned, false);

    const thread = fx.store.getThread(fx.threadId);
    assert.equal(thread.worktreePath, fx.worktreePath);
    assert.ok(fs.existsSync(fx.worktreePath));
  });

  it("skips when local commits were never pushed", async () => {
    pushBranch(fx);
    seedPr(fx, "MERGED");
    fs.writeFileSync(path.join(fx.worktreePath, "later.txt"), "later\n");
    git(fx.worktreePath, ["add", "later.txt"]);
    git(fx.worktreePath, ["commit", "-m", "after push"]);

    const result = await maybeCleanupMergedWorktree(fx.store, fx.threadId);
    assert.equal(result.cleaned, false);
    assert.ok(fs.existsSync(fx.worktreePath));
  });

  it("skips when the PR is not merged", async () => {
    pushBranch(fx);
    seedPr(fx, "OPEN");

    const result = await maybeCleanupMergedWorktree(fx.store, fx.threadId);
    assert.equal(result.cleaned, false);
    assert.ok(fs.existsSync(fx.worktreePath));
  });
});

describe("refreshPrStates merged-PR cleanup", () => {
  let fx;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it("cleans the worktree when a PR flips OPEN→MERGED", async () => {
    pushBranch(fx);
    seedPr(fx, "OPEN");

    const ghTryAsyncFn = async () => ({
      ok: true,
      stdout: JSON.stringify({
        number: 7,
        url: "https://github.com/acme/demo/pull/7",
        state: "MERGED",
      }),
      stderr: "",
      combined: "",
    });

    const result = await refreshPrStates(fx.store, { ghTryAsyncFn });
    assert.equal(result.changed, 1);

    const thread = fx.store.getThread(fx.threadId);
    assert.equal(thread.prState, "MERGED");
    assert.equal(thread.worktreePath, null);
    assert.ok(!fs.existsSync(fx.worktreePath));
  });

  it("still records MERGED when cleanup is blocked by a dirty tree", async () => {
    pushBranch(fx);
    seedPr(fx, "OPEN");
    fs.writeFileSync(path.join(fx.worktreePath, "wip.txt"), "wip\n");

    const ghTryAsyncFn = async () => ({
      ok: true,
      stdout: JSON.stringify({
        number: 7,
        url: "https://github.com/acme/demo/pull/7",
        state: "MERGED",
      }),
      stderr: "",
      combined: "",
    });

    await refreshPrStates(fx.store, { ghTryAsyncFn });
    const thread = fx.store.getThread(fx.threadId);
    assert.equal(thread.prState, "MERGED");
    assert.equal(thread.worktreePath, fx.worktreePath);
    assert.ok(fs.existsSync(fx.worktreePath));
  });
});

describe("sweepOrphanWorktrees", () => {
  let fx;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it("removes a clean orphan worktree and leaves referenced ones alone", async () => {
    // Second thread → worktree, then drop the thread record so the dir orphans.
    const orphanThread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Orphaned",
    });
    const orphan = setupWorktree({
      store: fx.store,
      threadId: orphanThread.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    fx.store.removeThread(orphanThread.id);
    fx.store.saveNow();

    const result = await sweepOrphanWorktrees({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });

    assert.deepEqual(result.removed, [orphan.worktreePath]);
    assert.ok(!fs.existsSync(orphan.worktreePath));
    // Referenced worktree untouched.
    assert.ok(fs.existsSync(fx.worktreePath));
    // Registration gone from the repo.
    const list = git(fx.repo, ["worktree", "list"]);
    assert.ok(!list.includes(orphan.worktreePath));
    assert.ok(list.includes(fx.worktreePath));
  });

  it("keeps orphans with uncommitted changes", async () => {
    const orphanThread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Dirty orphan",
    });
    const orphan = setupWorktree({
      store: fx.store,
      threadId: orphanThread.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(orphan.worktreePath, "precious.txt"), "wip\n");
    fx.store.removeThread(orphanThread.id);
    fx.store.saveNow();

    const result = await sweepOrphanWorktrees({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });

    assert.deepEqual(result.removed, []);
    assert.ok(fs.existsSync(orphan.worktreePath));
    assert.ok(
      fs.existsSync(path.join(orphan.worktreePath, "precious.txt")),
    );
  });

  it("is a no-op when the base directory does not exist", async () => {
    const result = await sweepOrphanWorktrees({
      store: fx.store,
      worktreeBase: path.join(fx.tmpDir, "nope"),
    });
    assert.deepEqual(result.removed, []);
  });
});

describe("clearMissingWorktree (worktree deleted behind our back)", () => {
  let tmpDir;
  let store;
  let worktreeBase;
  let repo;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtgone-"));
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

  /** Thread with a worktree whose folder is then removed outside the app. */
  function threadWithRemovedWorktree(title) {
    const thread = services.createThread(store, {
      projectId: project.id,
      title,
    });
    const setup = setupWorktree({ store, threadId: thread.id, worktreeBase });
    git(repo, ["worktree", "remove", "--force", setup.worktreePath]);
    return { threadId: thread.id, worktreePath: setup.worktreePath };
  }

  it("leaves a live worktree alone", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Live",
    });
    const setup = setupWorktree({ store, threadId: thread.id, worktreeBase });

    assert.equal(clearMissingWorktree({ store, threadId: thread.id }), null);
    assert.equal(store.getThread(thread.id).worktreePath, setup.worktreePath);
  });

  it("drops the stale pointer and reports the path", () => {
    const { threadId, worktreePath } = threadWithRemovedWorktree("Gone");

    assert.equal(
      clearMissingWorktree({ store, threadId }),
      worktreePath,
    );
    const thread = store.getThread(threadId);
    assert.equal(thread.worktreePath, null);
    assert.equal(thread.branch, null);
    assert.equal(thread.pendingWorktree, true);
  });

  // #74 was spawn-into-missing-cwd looking like a missing CLI. #511 forbids
  // fixing that by running in the project folder. Rematerialize instead.
  it("startRun rematerializes a missing worktree instead of using the project folder", async () => {
    const prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    let runner = null;
    try {
      const corePath = path.join(__dirname, "../../core/dist/index.js");
      const core = await import(pathToFileURL(corePath).href);
      runner = createRunner({
        store,
        core,
        pushFn: () => {},
        tickMs: 15,
        userDataPath: tmpDir,
      });

      const { threadId, worktreePath } = threadWithRemovedWorktree("Merged");
      await runner.startRun({ threadId, prompt: "Keep going" });

      const after = store.getThread(threadId);
      assert.ok(after.worktreePath, "must rematerialize a worktree");
      assert.ok(fs.existsSync(after.worktreePath));
      assert.notEqual(after.worktreePath, repo);
      const events = store
        .getMessages(threadId)
        .filter((m) => m.role === "event");
      assert.ok(
        !events.some((m) =>
          String(m.text).includes("running in the project folder"),
        ),
        `must not fall back to the checkout; events=${JSON.stringify(events.map((m) => m.text))}`,
      );
      assert.ok(
        after.worktreePath === worktreePath ||
          fs.existsSync(after.worktreePath),
        "new or reused worktree path must exist",
      );
    } finally {
      if (runner) runner.stopAll();
      if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
      else process.env.CODER_SIMULATE = prevSimulate;
    }
  });
});

describe("ensureWorktree (lazy creation)", () => {
  let tmpDir;
  let store;
  let worktreeBase;
  let repo;
  let project;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtlazy-"));
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

  it("creates the worktree for a pendingWorktree thread and clears the flag", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    store.updateThread(thread.id, { pendingWorktree: true });

    const updated = ensureWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
    });

    const shortId = thread.id.slice(0, 6);
    assert.equal(updated.branch, `coder/new-thread-${shortId}`);
    assert.equal(updated.worktreePath, path.join(worktreeBase, thread.id));
    assert.ok(fs.existsSync(updated.worktreePath));
    assert.equal(Boolean(updated.pendingWorktree), false);
    assert.equal(
      Boolean(store.getThread(thread.id).pendingWorktree),
      false,
    );
  });

  it("does nothing for a plain thread", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Plain",
    });
    const updated = ensureWorktree({ store, threadId: thread.id, worktreeBase });
    assert.equal(updated.worktreePath, null);
    assert.ok(!fs.existsSync(worktreeBase));
  });

  it("clears a stale flag when the worktree already exists", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Eager",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    store.updateThread(thread.id, { pendingWorktree: true });

    const updated = ensureWorktree({ store, threadId: thread.id, worktreeBase });
    assert.equal(updated.worktreePath, setup.worktreePath);
    assert.equal(Boolean(updated.pendingWorktree), false);
  });

  it("startRun materializes a pendingWorktree thread before the run", async () => {
    const prevSimulate = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    let runner = null;
    try {
      const corePath = path.join(__dirname, "../../core/dist/index.js");
      const core = await import(pathToFileURL(corePath).href);
      runner = createRunner({
        store,
        core,
        pushFn: () => {},
        tickMs: 15,
        userDataPath: tmpDir,
      });

      const thread = services.createThread(store, {
        projectId: project.id,
        title: "New Thread",
      });
      store.updateThread(thread.id, { pendingWorktree: true });
      store.saveNow();

      await runner.startRun({ threadId: thread.id, prompt: "Do the thing" });

      const updated = store.getThread(thread.id);
      assert.ok(updated.worktreePath);
      assert.ok(fs.existsSync(updated.worktreePath));
      assert.equal(
        updated.worktreePath,
        path.join(tmpDir, "worktrees", thread.id),
      );
      assert.equal(Boolean(updated.pendingWorktree), false);
    } finally {
      if (runner) runner.stopAll();
      if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
      else process.env.CODER_SIMULATE = prevSimulate;
    }
  });

  it("propagates creation failures", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Blocked",
    });
    store.updateThread(thread.id, { pendingWorktree: true });
    const blockedBase = path.join(tmpDir, "blocked-base");
    fs.writeFileSync(blockedBase, "not a dir\n");

    assert.throws(() =>
      ensureWorktree({ store, threadId: thread.id, worktreeBase: blockedBase }),
    );
    // Flag survives so the next run can retry.
    assert.equal(store.getThread(thread.id).pendingWorktree, true);
  });
});
