"use strict";

/** Pre-warmed worktree pool (#192): claim on setup, refill in background. */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  setupWorktree,
  setWorktreePoolSize,
  refillWorktreePool,
  worktreePoolDir,
  sweepOrphanWorktrees,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("worktree pool", () => {
  let tmpDir;
  afterEach(() => {
    setWorktreePoolSize(0);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("claims a pooled worktree at the current base and refills", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtpool-"));
    const store = new Store(path.join(tmpDir, "store.json"));
    const worktreeBase = path.join(tmpDir, "worktrees");
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    const project = await services.addProject(store, repo);

    setWorktreePoolSize(1);
    await refillWorktreePool(project, worktreeBase);
    const pool = worktreePoolDir(worktreeBase, project.id);
    const [pooled] = fs.readdirSync(pool);
    assert.ok(pooled, "pool filled");

    // Base moves after the pool was warmed; the claim must catch up.
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    git(repo, ["commit", "-am", "second"]);

    const thread = services.createThread(store, { projectId: project.id, title: "Pool me" });
    const out = setupWorktree({ store, threadId: thread.id, worktreeBase });
    assert.equal(out.worktreePath, path.join(worktreeBase, thread.id));
    assert.ok(!fs.existsSync(path.join(pool, pooled)), "pooled dir was moved");
    assert.equal(git(out.worktreePath, ["branch", "--show-current"]), out.branch);
    assert.equal(git(out.worktreePath, ["rev-parse", "HEAD"]), git(repo, ["rev-parse", "main"]));
    assert.equal(fs.readFileSync(path.join(out.worktreePath, "a.txt"), "utf8"), "two\n");
    assert.equal(git(out.worktreePath, ["status", "--porcelain"]), "");

    await refillWorktreePool(project, worktreeBase);
    assert.equal(fs.readdirSync(pool).length, 1, "pool refilled");

    // The boot sweep must not reap idle pool worktrees as orphans.
    await sweepOrphanWorktrees({ store, worktreeBase });
    assert.equal(fs.readdirSync(pool).length, 1, "sweep left the pool alone");
  });
});
