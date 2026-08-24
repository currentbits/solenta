"use strict";

/**
 * #688: main process was spawning ~65 git/s at idle, almost all
 * `git status --porcelain -uall`. The spawn is async and re-armed from the
 * previous child's close callback — overlapping or immediately sequential
 * `diff()` / `gcScan()` must share one porcelain pass per cwd.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  setupWorktree,
  diff,
  commit,
  gcScan,
  setExecFile,
  resetGitReadCaches,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function spyGitStatus() {
  const calls = [];
  setExecFile((bin, args, opts, cb) => {
    if (bin === "git" && Array.isArray(args) && args[0] === "status") {
      calls.push(args.slice());
    }
    return execFile(bin, args, opts, cb);
  });
  return calls;
}

function porcelainUallCount(calls) {
  return calls.filter(
    (args) => args.includes("--porcelain") && args.includes("-uall"),
  ).length;
}

async function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-git-coalesce-"));
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
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Coalesce",
  });
  return { tmpDir, store, project, thread, worktreeBase, repo };
}

describe("git status coalesce (#688)", { concurrency: 1 }, () => {
  let fx;

  beforeEach(async () => {
    resetGitReadCaches();
    fx = await makeFixture();
  });

  afterEach(() => {
    setExecFile(null);
    resetGitReadCaches();
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it("sequential diff() calls share one porcelain -uall spawn", async () => {
    setupWorktree({
      store: fx.store,
      threadId: fx.thread.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    const calls = spyGitStatus();
    await diff({ store: fx.store, threadId: fx.thread.id });
    await diff({ store: fx.store, threadId: fx.thread.id });
    await diff({ store: fx.store, threadId: fx.thread.id });
    assert.equal(
      porcelainUallCount(calls),
      1,
      `status -uall spawns=${porcelainUallCount(calls)} argv=${JSON.stringify(calls)}`,
    );
  });

  it("overlapping diff() calls share one porcelain -uall spawn", async () => {
    setupWorktree({
      store: fx.store,
      threadId: fx.thread.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    const calls = spyGitStatus();
    await Promise.all([
      diff({ store: fx.store, threadId: fx.thread.id }),
      diff({ store: fx.store, threadId: fx.thread.id }),
      diff({ store: fx.store, threadId: fx.thread.id }),
    ]);
    assert.equal(
      porcelainUallCount(calls),
      1,
      `status -uall spawns=${porcelainUallCount(calls)} argv=${JSON.stringify(calls)}`,
    );
  });

  it("overlapping gcScan passes inspect each worktree once", async () => {
    const a = setupWorktree({
      store: fx.store,
      threadId: fx.thread.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    const other = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "Other",
    });
    const b = setupWorktree({
      store: fx.store,
      threadId: other.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    assert.ok(a.worktreePath && b.worktreePath);

    const calls = spyGitStatus();
    const opts = {
      store: fx.store,
      worktreeBase: fx.worktreeBase,
      skipSizes: true,
    };
    await Promise.all([gcScan(opts), gcScan(opts)]);
    assert.equal(
      porcelainUallCount(calls),
      2,
      `two worktrees, one inspect each; got ${porcelainUallCount(calls)} status -uall`,
    );
  });

  it("a second gcScan inside the TTL does not re-status worktrees", async () => {
    setupWorktree({
      store: fx.store,
      threadId: fx.thread.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    const calls = spyGitStatus();
    const opts = {
      store: fx.store,
      worktreeBase: fx.worktreeBase,
      skipSizes: true,
    };
    await gcScan(opts);
    const afterFirst = porcelainUallCount(calls);
    assert.ok(afterFirst >= 1, "first scan must status the worktree");
    await gcScan(opts);
    assert.equal(
      porcelainUallCount(calls),
      afterFirst,
      `second scan re-spawned status -uall (${porcelainUallCount(calls)} vs ${afterFirst})`,
    );
  });

  it("commit busts the diff TTL so a later diff sees new files", async () => {
    const wt = setupWorktree({
      store: fx.store,
      threadId: fx.thread.id,
      worktreeBase: fx.worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(wt.worktreePath, "a.txt"), "a\n");
    const first = await diff({ store: fx.store, threadId: fx.thread.id });
    assert.ok(first.files.some((f) => f.path === "a.txt"));
    commit({
      store: fx.store,
      threadId: fx.thread.id,
      message: "add a",
    });
    fs.writeFileSync(path.join(wt.worktreePath, "b.txt"), "b\n");
    const second = await diff({ store: fx.store, threadId: fx.thread.id });
    assert.ok(
      second.files.some((f) => f.path === "b.txt"),
      `cached diff hid b.txt: ${JSON.stringify(second.files)}`,
    );
  });
});
