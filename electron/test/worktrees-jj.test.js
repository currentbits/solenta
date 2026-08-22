"use strict";

/**
 * Live colocated-jj audit of the worktree harness (issue #521).
 * Skips when `jj` is not on PATH so CI without jj stays green.
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
  diff,
  mergeWorktree,
  maybeCreateCheckpoint,
  listCheckpoints,
} = require("../worktrees.js");
const { JJ_DETACHED_HEAD_ERROR } = require("../scm.js");

function hasJj() {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function jj(cwd, args, env) {
  return execFileSync("jj", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env || process.env,
  }).trim();
}

describe("colocated jujutsu worktrees", { skip: !hasJj() }, () => {
  let tmpDir;
  let store;
  let repo;
  let project;
  let thread;
  let worktreeBase;
  let jjEnv;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-jj-wt-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");
    const cfg = path.join(tmpDir, "jj.toml");
    fs.writeFileSync(
      cfg,
      '[user]\nname = "Test"\nemail = "test@example.com"\n',
    );
    jjEnv = { ...process.env, JJ_CONFIG: cfg };

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    execFileSync("jj", ["git", "init", "--colocate"], {
      cwd: repo,
      env: jjEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "JJ Feature",
    });
  });

  afterEach(() => {
    try {
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

  it("addProject badges colocated jj as unsupported without persisting scm", () => {
    assert.equal(project.scm && project.scm.kind, "jj");
    assert.equal(project.scm.colocated, true);
    assert.equal(project.scm.support, "unsupported");
    assert.equal("scm" in store.getProjects()[0], false);
  });

  it("setupWorktree and diff work like a plain git repo", async () => {
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    assert.ok(updated.worktreePath);
    assert.ok(fs.existsSync(path.join(updated.worktreePath, "README.md")));
    assert.match(updated.branch, /^coder\//);
    assert.equal(
      git(updated.worktreePath, ["branch", "--show-current"]),
      updated.branch,
    );

    fs.writeFileSync(
      path.join(updated.worktreePath, "README.md"),
      "hello\nworld\n",
    );
    fs.writeFileSync(path.join(updated.worktreePath, "new-file.txt"), "a\nb\n");
    const result = await diff({ store, threadId: thread.id });
    const paths = result.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["README.md", "new-file.txt"]);
  });

  it("mergeWorktree lands before any jj mutation", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "from wt\n");
    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });
    assert.equal(merged.worktreePath, null);
    assert.equal(
      fs.readFileSync(path.join(repo, "feature.txt"), "utf8"),
      "from wt\n",
    );
  });

  it("mergeWorktree names jj after a command detaches HEAD", () => {
    setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const wt = store.getThread(thread.id).worktreePath;
    fs.writeFileSync(path.join(wt, "feature.txt"), "from wt\n");
    fs.writeFileSync(path.join(repo, "scratch.txt"), "s\n");
    try {
      jj(repo, ["describe", "-m", "user work"], jjEnv);
    } catch {
      // jj still moves @; stderr warnings are fine
    }
    try {
      jj(repo, ["new"], jjEnv);
    } catch {
      // ignore
    }
    assert.equal(git(repo, ["branch", "--show-current"]), "");
    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          broadcast: () => {},
        }),
      (err) => {
        assert.equal(err.message, JJ_DETACHED_HEAD_ERROR);
        return true;
      },
    );
  });

  it("checkpoints in the git worktree survive jj in the main checkout", async () => {
    setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const wt = store.getThread(thread.id).worktreePath;
    fs.writeFileSync(path.join(wt, "a.txt"), "one\n");
    const c1 = await maybeCreateCheckpoint(store, thread.id);
    assert.ok(c1 && c1.sha);
    fs.writeFileSync(path.join(repo, "scratch.txt"), "s\n");
    try {
      jj(repo, ["new"], jjEnv);
    } catch {
      // ignore
    }
    const listed = await listCheckpoints({ store, threadId: thread.id });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sha, c1.sha);
  });
});
