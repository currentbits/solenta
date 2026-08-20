"use strict";

/**
 * Reclaiming stranded worker worktrees (#601).
 *
 * Two halves that must not drift into each other:
 *  - gcScan classifies with DEFAULT_WORKTREE_RETENTION so the GC dialog can
 *    offer settled worktrees on a project that never set the option (the 191
 *    finished orchestrator workers / 100 GB case).
 *  - enforceRetention runs at boot with nobody watching, so it stays opt-in
 *    and never touches unmerged work.
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
  gcScan,
  gcClean,
  enforceRetention,
  DEFAULT_WORKTREE_RETENTION,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtret-"));
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

/** An archived worker thread holding a worktree — what the 191 look like. */
function addArchivedWorker(fx, title, updatedAt) {
  const thread = services.createThread(fx.store, {
    projectId: fx.project.id,
    title,
  });
  const setup = setupWorktree({
    store: fx.store,
    threadId: thread.id,
    worktreeBase: fx.worktreeBase,
  });
  fx.store.updateThread(thread.id, {
    archived: true,
    orchWorker: true,
    status: "done",
    updatedAt,
  });
  fx.store.saveNow();
  return setup;
}

/** Land a commit on the worker's branch that main does not have. */
function commitInWorktree(setup, name) {
  fs.writeFileSync(path.join(setup.worktreePath, name), "work\n");
  git(setup.worktreePath, ["add", name]);
  git(setup.worktreePath, ["commit", "-m", `add ${name}`]);
}

function branchExists(repo, name) {
  try {
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

describe("default worktree retention (#601)", { concurrency: 1 }, () => {
  let fx;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.tmpDir, { recursive: true, force: true });
  });

  it("classifies settled worktrees past the default with no project setting", async () => {
    assert.equal(fx.project.worktreeRetention, undefined);
    const made = [];
    for (let i = 0; i < DEFAULT_WORKTREE_RETENTION + 2; i++) {
      made.push(addArchivedWorker(fx, `Worker ${i}`, 1_000 + i));
    }

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    const retention = scan.candidates.filter((c) => c.reason === "retention");
    // The two oldest fall past the default; the newest N are kept.
    assert.deepEqual(
      retention.map((c) => c.path).sort(),
      [made[0].worktreePath, made[1].worktreePath].sort(),
    );
    assert.ok(retention.every((c) => !c.blocked));
    assert.ok(retention.every((c) => c.bytes > 0));
  });

  it("an explicit project setting still overrides the default", async () => {
    services.updateProject(fx.store, fx.project.id, { worktreeRetention: 1 });
    const older = addArchivedWorker(fx, "Older", 1_000);
    const newest = addArchivedWorker(fx, "Newest", 2_000);

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(
      scan.candidates.filter((c) => c.reason === "retention").map((c) => c.path),
      [older.worktreePath],
    );
    assert.ok(fs.existsSync(newest.worktreePath));
  });

  it("stays under the default: nothing to reclaim", async () => {
    addArchivedWorker(fx, "Only worker", 1_000);
    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(scan.candidates, []);
    assert.equal(scan.usage[0].worktrees, 1);
  });

  it("reports unmerged commits without blocking the candidate", async () => {
    const made = [];
    for (let i = 0; i < DEFAULT_WORKTREE_RETENTION + 2; i++) {
      made.push(addArchivedWorker(fx, `Worker ${i}`, 1_000 + i));
    }
    commitInWorktree(made[0], "unlanded.txt");

    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    const byPath = new Map(scan.candidates.map((c) => [c.path, c]));
    const withWork = byPath.get(made[0].worktreePath);
    const deadWeight = byPath.get(made[1].worktreePath);

    assert.equal(withWork.unmerged, 1);
    // Not blocked: the branch outlives the directory, so this is a warning the
    // UI must surface, not a refusal.
    assert.equal(withWork.blocked, undefined);
    assert.equal(deadWeight.unmerged, undefined);
  });

  it("gcClean still reclaims an unmerged worktree when asked explicitly", async () => {
    const made = [];
    for (let i = 0; i < DEFAULT_WORKTREE_RETENTION + 2; i++) {
      made.push(addArchivedWorker(fx, `Worker ${i}`, 1_000 + i));
    }
    commitInWorktree(made[0], "unlanded.txt");
    const branch = made[0].branch;

    const result = await gcClean({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
      paths: [made[0].worktreePath],
    });
    assert.deepEqual(result.removed, [made[0].worktreePath]);
    assert.ok(!fs.existsSync(made[0].worktreePath));
    // The commit is still reachable — that is why removal is allowed at all.
    assert.equal(branchExists(fx.repo, branch), true);
    assert.match(
      git(fx.repo, ["log", "--oneline", branch, "^main"]),
      /add unlanded\.txt/,
    );
  });

  it("enforceRetention ignores projects riding the default", async () => {
    const made = [];
    for (let i = 0; i < DEFAULT_WORKTREE_RETENTION + 2; i++) {
      made.push(addArchivedWorker(fx, `Worker ${i}`, 1_000 + i));
    }

    // gcScan offers them to the dialog; boot GC must not act on its own.
    const scan = await gcScan({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.ok(scan.candidates.some((c) => c.reason === "retention"));

    const result = await enforceRetention({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(result.removed, []);
    assert.ok(made.every((m) => fs.existsSync(m.worktreePath)));
  });

  it("enforceRetention skips a configured project's unmerged worktree", async () => {
    services.updateProject(fx.store, fx.project.id, { worktreeRetention: 1 });
    const withWork = addArchivedWorker(fx, "Has commits", 1_000);
    const deadWeight = addArchivedWorker(fx, "Dead weight", 1_500);
    const newest = addArchivedWorker(fx, "Newest", 2_000);
    commitInWorktree(withWork, "unlanded.txt");

    const result = await enforceRetention({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(result.removed, [deadWeight.worktreePath]);
    assert.ok(fs.existsSync(withWork.worktreePath));
    assert.ok(fs.existsSync(newest.worktreePath));
  });

  it("a second project's setting does not license reclaiming the first", async () => {
    const other = path.join(fx.tmpDir, "other");
    fs.mkdirSync(other);
    git(other, ["init"]);
    git(other, ["config", "user.email", "test@example.com"]);
    git(other, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(other, "README.md"), "other\n");
    git(other, ["add", "README.md"]);
    git(other, ["commit", "-m", "init"]);
    const otherProject = await services.addProject(fx.store, other);
    services.updateProject(fx.store, otherProject.id, {
      worktreeRetention: 1,
    });

    const made = [];
    for (let i = 0; i < DEFAULT_WORKTREE_RETENTION + 2; i++) {
      made.push(addArchivedWorker(fx, `Worker ${i}`, 1_000 + i));
    }

    const result = await enforceRetention({
      store: fx.store,
      worktreeBase: fx.worktreeBase,
    });
    assert.deepEqual(result.removed, []);
    assert.ok(made.every((m) => fs.existsSync(m.worktreePath)));
  });
});
