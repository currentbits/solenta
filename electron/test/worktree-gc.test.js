"use strict";

/**
 * Worktree GC (#316): scan, batch clean, retention, collision-safe names.
 * Never deletes a branch — disk only.
 */

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
  maybeRenameWorktreeBranch,
  gcScan,
  gcClean,
  enforceRetention,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtgc-"));
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

  const project = await services.addProject(store, repo);
  return { tmpDir, store, project, worktreeBase, repo };
}

function addWorktree(fx, title) {
  const thread = services.createThread(fx.store, {
    projectId: fx.project.id,
    title,
  });
  return setupWorktree({
    store: fx.store,
    threadId: thread.id,
    worktreeBase: fx.worktreeBase,
    broadcast: () => {},
  });
}

function branchExists(repo, name) {
  try {
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

describe("gcScan / gcClean", () => {
  let fx;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it("reports an orphan directory as a candidate", async () => {
    const live = addWorktree(fx, "Live");
    const orphanThread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Orphaned",
    });
    const orphan = setupWorktree({
      store: fx.store,
      threadId: orphanThread.id,
      worktreeBase: fx.worktreeBase,
    });
    fx.store.removeThread(orphanThread.id);
    fx.store.saveNow();

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.equal(scan.candidates.length, 1);
    assert.equal(scan.candidates[0].reason, "orphan");
    assert.equal(scan.candidates[0].path, orphan.worktreePath);
    assert.equal(scan.candidates[0].threadId, null);
    assert.equal(scan.candidates[0].projectId, fx.project.id);
    assert.equal(scan.candidates[0].blocked, undefined);
    assert.ok(scan.candidates[0].bytes > 0);
    assert.equal(scan.usage.length, 1);
    assert.equal(scan.usage[0].projectId, fx.project.id);
    assert.equal(scan.usage[0].worktrees, 2);
    assert.ok(scan.totalBytes >= scan.usage[0].bytes);
    assert.ok(fs.existsSync(live.worktreePath));
  });

  it("blocks a dirty orphan and gcClean refuses it", async () => {
    const orphanThread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Dirty orphan",
    });
    const orphan = setupWorktree({
      store: fx.store,
      threadId: orphanThread.id,
      worktreeBase: fx.worktreeBase,
    });
    fs.writeFileSync(path.join(orphan.worktreePath, "precious.txt"), "wip\n");
    fx.store.removeThread(orphanThread.id);
    fx.store.saveNow();

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.equal(scan.candidates.length, 1);
    assert.equal(scan.candidates[0].reason, "orphan");
    assert.match(scan.candidates[0].blocked, /uncommitted/i);

    const result = await gcClean({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
      paths: [orphan.worktreePath],
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /uncommitted/i);
    assert.ok(fs.existsSync(orphan.worktreePath));
    assert.ok(fs.existsSync(path.join(orphan.worktreePath, "precious.txt")));
  });

  it("retention keeps the newest N settled worktrees and flags the rest", async () => {
    services.updateProject(fx.store, fx.project.id, { worktreeRetention: 1 });
    const old = addWorktree(fx, "Old settled");
    const mid = addWorktree(fx, "Mid settled");
    const newest = addWorktree(fx, "Newest settled");
    fx.store.updateThread(old.id, {
      settledOverride: "settled",
      updatedAt: 1_000,
    });
    fx.store.updateThread(mid.id, {
      settledOverride: "settled",
      updatedAt: 2_000,
    });
    fx.store.updateThread(newest.id, {
      settledOverride: "settled",
      updatedAt: 3_000,
    });
    fx.store.saveNow();

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    const retention = scan.candidates.filter((c) => c.reason === "retention");
    const paths = retention.map((c) => c.path).sort();
    assert.deepEqual(
      paths,
      [mid.worktreePath, old.worktreePath].sort(),
    );
    assert.ok(!retention.some((c) => c.path === newest.worktreePath));
    assert.ok(retention.every((c) => !c.blocked));
    assert.equal(scan.usage[0].worktrees, 3);
  });

  it("enforceRetention reclaims past-limit worktrees and leaves orphans alone", async () => {
    const orphanThread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Orphan",
    });
    const orphan = setupWorktree({
      store: fx.store,
      threadId: orphanThread.id,
      worktreeBase: fx.worktreeBase,
    });
    fx.store.removeThread(orphanThread.id);
    const keep = addWorktree(fx, "Keep");
    const drop = addWorktree(fx, "Drop");
    fx.store.updateThread(keep.id, {
      settledOverride: "settled",
      updatedAt: 2_000,
    });
    fx.store.updateThread(drop.id, {
      settledOverride: "settled",
      updatedAt: 1_000,
    });
    fx.store.saveNow();

    // No limit set: retention is opt-in, so nothing is reclaimed.
    const noop = await enforceRetention({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(noop.removed, []);
    assert.ok(fs.existsSync(drop.worktreePath));

    services.updateProject(fx.store, fx.project.id, { worktreeRetention: 1 });
    const result = await enforceRetention({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(result.removed, [drop.worktreePath]);
    assert.ok(!fs.existsSync(drop.worktreePath));
    assert.ok(fs.existsSync(keep.worktreePath));
    // Orphans are the batch dialog's job, not the boot sweep's.
    assert.ok(fs.existsSync(orphan.worktreePath));
    assert.equal(branchExists(fx.repo, drop.branch), true);
  });

  it("counts archived threads as settled for retention", async () => {
    services.updateProject(fx.store, fx.project.id, { worktreeRetention: 1 });
    const keep = addWorktree(fx, "Newest archived");
    const drop = addWorktree(fx, "Older archived");
    // Archived threads never carry a settled override (the renderer filters
    // them before the settle split), so this is the #316 case.
    fx.store.updateThread(keep.id, { archived: true, updatedAt: 2_000 });
    fx.store.updateThread(drop.id, { archived: true, updatedAt: 1_000 });
    fx.store.saveNow();

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    const retention = scan.candidates.filter((c) => c.reason === "retention");
    assert.deepEqual(
      retention.map((c) => c.path),
      [drop.worktreePath],
    );
  });

  it("gcClean never deletes the branch", async () => {
    const orphanThread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Keep branch",
    });
    const orphan = setupWorktree({
      store: fx.store,
      threadId: orphanThread.id,
      worktreeBase: fx.worktreeBase,
    });
    const branch = orphan.branch;
    fx.store.removeThread(orphanThread.id);
    fx.store.saveNow();

    const result = await gcClean({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
      paths: [orphan.worktreePath],
    });
    assert.deepEqual(result.removed, [orphan.worktreePath]);
    assert.ok(result.bytes > 0);
    assert.ok(!fs.existsSync(orphan.worktreePath));
    assert.equal(branchExists(fx.repo, branch), true);
  });

  it("gcClean of a retention candidate clears thread pointers but keeps the ref", async () => {
    services.updateProject(fx.store, fx.project.id, { worktreeRetention: 1 });
    const keep = addWorktree(fx, "Keep");
    const drop = addWorktree(fx, "Drop");
    fx.store.updateThread(keep.id, {
      settledOverride: "settled",
      updatedAt: 2_000,
    });
    fx.store.updateThread(drop.id, {
      settledOverride: "settled",
      updatedAt: 1_000,
    });
    fx.store.saveNow();
    const branch = drop.branch;
    const broadcasts = [];

    const result = await gcClean({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
      paths: [drop.worktreePath],
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    });
    assert.deepEqual(result.removed, [drop.worktreePath]);
    const thread = fx.store.getThread(drop.id);
    assert.equal(thread.worktreePath, null);
    assert.equal(thread.branch, null);
    assert.equal(branchExists(fx.repo, branch), true);
    assert.ok(fs.existsSync(keep.worktreePath));
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
    assert.equal(broadcasts.length, 1);
  });

  it("gcClean refuses a stale or live path", async () => {
    const live = addWorktree(fx, "Still working on it");
    const result = await gcClean({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
      paths: [live.worktreePath, path.join(fx.worktreeBase, "nope")],
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.failed.length, 2);
    assert.ok(fs.existsSync(live.worktreePath));
  });

  it("working and pinned threads are never retention candidates", async () => {
    services.updateProject(fx.store, fx.project.id, { worktreeRetention: 1 });
    const newest = addWorktree(fx, "Newest");
    const working = addWorktree(fx, "Working");
    const pinned = addWorktree(fx, "Pinned");
    fx.store.updateThread(newest.id, {
      settledOverride: "settled",
      updatedAt: 3_000,
    });
    fx.store.updateThread(working.id, {
      settledOverride: "settled",
      status: "working",
      updatedAt: 1_000,
    });
    fx.store.updateThread(pinned.id, {
      settledOverride: "settled",
      pinnedAt: 1,
      updatedAt: 500,
    });
    fx.store.saveNow();

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(scan.candidates, []);
  });

  it("returns empty when the base directory is missing", async () => {
    const scan = await gcScan({
      store: fx.store,
      worktreeBase: path.join(fx.tmpDir, "nope"),
    });
    assert.deepEqual(scan, { candidates: [], usage: [], totalBytes: 0 });
  });
});

describe("collision-safe branch names", () => {
  let fx;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it("setupWorktree appends -2 when the local name is taken", () => {
    const thread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Add login page",
    });
    const taken = `coder/add-login-page-${thread.id.slice(0, 6)}`;
    git(fx.repo, ["branch", taken]);

    const setup = setupWorktree({
      store: fx.store,
      threadId: thread.id,
      worktreeBase: fx.worktreeBase,
    });
    assert.equal(setup.branch, `${taken}-2`);
    assert.equal(git(setup.worktreePath, ["branch", "--show-current"]), `${taken}-2`);
    assert.equal(branchExists(fx.repo, taken), true);
    assert.equal(branchExists(fx.repo, `${taken}-2`), true);
  });

  it("setupWorktree treats a remote ref as taken", () => {
    const thread = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Add login page",
    });
    const taken = `coder/add-login-page-${thread.id.slice(0, 6)}`;
    git(fx.repo, ["update-ref", `refs/remotes/origin/${taken}`, "HEAD"]);

    const setup = setupWorktree({
      store: fx.store,
      threadId: thread.id,
      worktreeBase: fx.worktreeBase,
    });
    assert.equal(setup.branch, `${taken}-2`);
  });

  it("maybeRenameWorktreeBranch appends -2 on collision and never throws", () => {
    const thread = addWorktree(fx, "New Thread");
    const shortId = thread.id.slice(0, 6);
    assert.equal(thread.branch, `coder/new-thread-${shortId}`);
    const taken = `coder/add-login-page-${shortId}`;
    git(fx.repo, ["branch", taken]);

    const updated = maybeRenameWorktreeBranch({
      store: fx.store,
      threadId: thread.id,
      newTitle: "Add login page",
    });
    assert.equal(updated.branch, `${taken}-2`);
    assert.equal(
      git(thread.worktreePath, ["branch", "--show-current"]),
      `${taken}-2`,
    );
    assert.equal(branchExists(fx.repo, taken), true);
  });
});
