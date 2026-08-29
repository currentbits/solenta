/**
 * Issue #187 / #775: change ThreadInfo.baseBranch after create.
 * Validated against local branches; refused after the first PR.
 * A bound worktree is reset onto the new base when clean.
 * Run: npm run test:electron -- --test-name-pattern=setBaseBranch
 */
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

describe("setBaseBranch", () => {
  let tmpDir;
  let store;
  let repo;
  let threadId;
  let worktreeBase;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-base-"));
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
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main
    }
    git(repo, ["checkout", "-b", "stacked-base"]);
    git(repo, ["checkout", "main"]);
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "API",
    }).id;
  });

  afterEach(() => {
    try {
      for (const t of store.getThreads()) {
        if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
          try {
            git(repo, ["worktree", "remove", "--force", t.worktreePath]);
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

  it("records a local branch as the stacked base", () => {
    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.baseBranch, "stacked-base");
    assert.equal(store.getThread(threadId).baseBranch, "stacked-base");
  });

  it("clears the stacked base back to the repo default", () => {
    services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    const cleared = services.setBaseBranch(store, {
      threadId,
      baseBranch: null,
    });
    assert.equal(cleared.baseBranch, null);
    assert.equal(store.getThread(threadId).baseBranch, null);
  });

  it("rejects a name that is not a local branch", () => {
    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "does-not-exist",
        }),
      /Unknown base branch|not a local branch/i,
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
  });

  it("rejects after the first pull request", () => {
    store.updateThread(threadId, { prNumber: 42, prUrl: "https://example/p/42" });
    store.save();
    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "stacked-base",
        }),
      /after the first pull request|already has a pull request/i,
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
  });

  it("does not bump updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).updatedAt, before);
  });

  it("moves a clean worktree HEAD onto the new base (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    const startHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);
    assert.notEqual(startHead, stackedHead, "worktree must start off the new base");

    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.baseBranch, "stacked-base");
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      stackedHead,
      "worktree HEAD must land on the new base",
    );
    assert.ok(fs.existsSync(path.join(setup.worktreePath, "schema.txt")));
  });

  it("refuses a dirty worktree and leaves the recorded base unchanged (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    const startHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(setup.worktreePath, "dirty.txt"), "uncommitted\n");

    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "stacked-base",
        }),
      /dirty|uncommitted/i,
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      startHead,
      "dirty refuse must not move HEAD",
    );
    assert.notEqual(startHead, stackedHead);
    assert.ok(
      fs.existsSync(path.join(setup.worktreePath, "dirty.txt")),
      "dirty file must survive the refuse",
    );
  });

  it("clearing the base moves a clean worktree HEAD to the repo default (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    git(repo, ["checkout", "main"]);
    const mainHead = git(repo, ["rev-parse", "main"]);

    store.updateThread(threadId, { baseBranch: "stacked-base" });
    store.save();
    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    assert.notEqual(git(setup.worktreePath, ["rev-parse", "HEAD"]), mainHead);

    const cleared = services.setBaseBranch(store, {
      threadId,
      baseBranch: null,
    });
    assert.equal(cleared.baseBranch, null);
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      mainHead,
      "cleared base must land the worktree on the repo default",
    );
  });
});
