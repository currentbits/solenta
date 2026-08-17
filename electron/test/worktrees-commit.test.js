const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { commit, revertFile } = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("worktrees commit/revertFile", () => {
  let tmpDir;
  let store;
  let repo;
  let thread;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-commit-"));
    store = new Store(path.join(tmpDir, "store.json"));

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
      // already on main/master
    }

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Commit flow",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("commit stages everything and commits with the given message", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    fs.appendFileSync(path.join(repo, "README.md"), "more\n");

    const result = commit({ store, threadId: thread.id, message: "feat: add a" });
    assert.equal(result.subject, "feat: add a");
    assert.equal(git(repo, ["log", "-1", "--format=%s"]), "feat: add a");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  });

  it("commit rejects an empty message without touching the repo", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    assert.throws(
      () => commit({ store, threadId: thread.id, message: "   " }),
      /empty/i,
    );
    // Untracked file still uncommitted.
    assert.match(git(repo, ["status", "--porcelain"]), /\?\? a\.txt/);
  });

  it("commit rejects when there is nothing to commit", () => {
    assert.throws(
      () => commit({ store, threadId: thread.id, message: "x" }),
      /nothing to commit/i,
    );
  });

  it("revertFile restores a modified tracked file from HEAD", () => {
    fs.appendFileSync(path.join(repo, "README.md"), "dirty\n");
    revertFile({ store, threadId: thread.id, path: "README.md", status: "M" });
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hello\n");
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  });

  it("revertFile restores a deleted tracked file", () => {
    fs.rmSync(path.join(repo, "README.md"));
    revertFile({ store, threadId: thread.id, path: "README.md", status: "D" });
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hello\n");
  });

  it("revertFile deletes an untracked file", () => {
    fs.writeFileSync(path.join(repo, "scratch.txt"), "temp\n");
    revertFile({ store, threadId: thread.id, path: "scratch.txt", status: "??" });
    assert.equal(fs.existsSync(path.join(repo, "scratch.txt")), false);
  });

  it("revertFile removes a staged-new file from index and disk", () => {
    fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
    git(repo, ["add", "new.txt"]);
    revertFile({ store, threadId: thread.id, path: "new.txt", status: "A" });
    assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  });

  it("revertFile rejects paths escaping the working tree", () => {
    assert.throws(
      () =>
        revertFile({
          store,
          threadId: thread.id,
          path: "../outside.txt",
          status: "M",
        }),
      /escapes|invalid/i,
    );
    assert.throws(
      () =>
        revertFile({
          store,
          threadId: thread.id,
          path: "/etc/passwd",
          status: "M",
        }),
      /escapes|invalid/i,
    );
  });
});
