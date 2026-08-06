const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("services", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-svc-"));
    store = new Store(path.join(tmpDir, "store.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addProject rejects a path that is not a directory", () => {
    const missing = path.join(tmpDir, "nope");
    assert.throws(
      () => services.addProject(store, missing),
      /not a directory|does not exist|directory/i,
    );
  });

  it("addProject rejects a directory that is not a git repo", () => {
    const dir = path.join(tmpDir, "plain");
    fs.mkdirSync(dir);
    assert.throws(
      () => services.addProject(store, dir),
      /git|repo|work.tree|not a git/i,
    );
  });

  it("addProject accepts a git repo and uses folder name when no remote", () => {
    const repo = path.join(tmpDir, "my-app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    // git may need identity for later ops; status/remote should work without commits
    const project = services.addProject(store, repo);
    assert.equal(project.slug, "my-app");
    assert.equal(project.name, "my-app");
    assert.equal(project.path, path.resolve(repo));
    assert.ok(project.id);
    assert.equal(store.getProjects().length, 1);
  });

  it("addProject derives slug from origin remote as owner/repo", () => {
    const repo = path.join(tmpDir, "fixture-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, [
      "remote",
      "add",
      "origin",
      "https://github.com/pingdotgg/t3code.git",
    ]);
    const project = services.addProject(store, repo);
    assert.equal(project.slug, "pingdotgg/t3code");
    assert.equal(project.name, "t3code");
  });

  it("addProject derives slug from ssh origin", () => {
    const repo = path.join(tmpDir, "ssh-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const project = services.addProject(store, repo);
    assert.equal(project.slug, "acme/widgets");
    assert.equal(project.name, "widgets");
  });

  it("createThread and listThreads", () => {
    const project = services.addProject(
      store,
      (() => {
        const repo = path.join(tmpDir, "t-repo");
        fs.mkdirSync(repo);
        git(repo, ["init"]);
        return repo;
      })(),
    );
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "New Thread",
    });
    assert.equal(thread.projectId, project.id);
    assert.equal(thread.title, "New Thread");
    assert.equal(thread.status, "idle");
    assert.equal(thread.branch, null);
    assert.equal(thread.prNumber, null);
    assert.equal(thread.provider, "claude");
    assert.equal(thread.sessionId, null);
    assert.equal(thread.permissionMode, "default");
    assert.equal(thread.worktreePath, null);
    assert.ok(typeof thread.createdAt === "number");
    const listed = services.listThreads(store);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, thread.id);
  });

  it("setPermissionMode validates and updates", () => {
    const repo = path.join(tmpDir, "pm-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    const updated = services.setPermissionMode(store, {
      threadId: thread.id,
      mode: "acceptEdits",
    });
    assert.equal(updated.permissionMode, "acceptEdits");
    assert.throws(
      () =>
        services.setPermissionMode(store, {
          threadId: thread.id,
          mode: "nope",
        }),
      /Invalid permission mode/i,
    );
  });

  it("getThreadDetail returns empty messages, work log, usage null", () => {
    const repo = path.join(tmpDir, "d-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    const detail = services.getThreadDetail(store, thread.id);
    assert.equal(detail.thread.id, thread.id);
    assert.deepEqual(detail.messages, []);
    assert.deepEqual(detail.workLog, []);
    assert.equal(detail.workflow, null);
    assert.equal(detail.usage, null);
  });

  it("gitStatus reports branch and dirty flag", () => {
    const repo = path.join(tmpDir, "g-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["checkout", "-b", "feature-x"]);
    // empty tree is clean
    let status = services.gitStatus(repo);
    assert.equal(status.isRepo, true);
    assert.equal(status.branch, "feature-x");
    assert.equal(status.dirty, false);

    fs.writeFileSync(path.join(repo, "dirty.txt"), "x");
    status = services.gitStatus(repo);
    assert.equal(status.dirty, true);
  });
});
