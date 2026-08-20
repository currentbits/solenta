/**
 * Round 41: projects.remove (t3-style) — electron/services.js.
 * Happy path, guard table (partial-delete impossible), store durability.
 */
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

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
}

/** Repo with one commit, so `git worktree add` works. */
function initRepoWithCommit(dir) {
  initRepo(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  git(dir, ["add", "README.md"]);
  git(dir, [
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=T",
    "commit",
    "-m",
    "init",
  ]);
}

describe("removeProject", () => {
  let tmpDir;
  let storePath;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-rm-proj-"));
    storePath = path.join(tmpDir, "store.json");
    store = new Store(storePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes project, its threads, messages, work log, usage; leaves other project intact", async () => {
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    initRepo(repoA);
    initRepo(repoB);
    const projectA = await services.addProject(store, repoA);
    const projectB = await services.addProject(store, repoB);

    const t1 = services.createThread(store, {
      projectId: projectA.id,
      title: "A-one",
    });
    const t2 = services.createThread(store, {
      projectId: projectA.id,
      title: "A-two",
    });
    const tOther = services.createThread(store, {
      projectId: projectB.id,
      title: "B-keep",
    });

    store.appendMessage(t1.id, {
      id: "m1",
      role: "user",
      text: "hello a1",
      createdAt: Date.now(),
    });
    store.appendMessage(t2.id, {
      id: "m2",
      role: "assistant",
      text: "hello a2",
      createdAt: Date.now(),
    });
    store.appendWorkLog(t1.id, {
      id: "w1",
      runId: "r1",
      label: "Step",
      done: true,
      timestamp: Date.now(),
    });
    store.setUsage(t2.id, {
      model: "claude-opus-4",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    });
    // Other project has its own history that must survive.
    store.appendMessage(tOther.id, {
      id: "m-other",
      role: "user",
      text: "keep me",
      createdAt: Date.now(),
    });
    store.setUsage(tOther.id, {
      model: "claude-opus-4",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    store.saveNow();

    await services.removeProject(store, { projectId: projectA.id });

    assert.equal(store.getProject(projectA.id), null);
    assert.equal(store.getThread(t1.id), null);
    assert.equal(store.getThread(t2.id), null);
    assert.deepEqual(store.getMessages(t1.id), []);
    assert.deepEqual(store.getMessages(t2.id), []);
    assert.deepEqual(store.getWorkLog(t1.id), []);
    assert.equal(store.getUsage(t1.id), null);
    assert.equal(store.getUsage(t2.id), null);

    // Other project + thread + history untouched.
    assert.ok(store.getProject(projectB.id));
    assert.ok(store.getThread(tOther.id));
    assert.equal(store.getMessages(tOther.id).length, 1);
    assert.equal(store.getMessages(tOther.id)[0].text, "keep me");
    assert.ok(store.getUsage(tOther.id));
    assert.equal(store.getProjects().length, 1);
    assert.equal(store.getThreads().length, 1);
  });

  it("rejects unknown projectId naming it", async () => {
    await assert.rejects(
      () => services.removeProject(store, { projectId: "no-such-project" }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "Unknown project: no-such-project");
        return true;
      },
    );
  });

  it("rejects while any thread is working (before any deletion)", async () => {
    const repoA = path.join(tmpDir, "work-a");
    const repoB = path.join(tmpDir, "work-b");
    initRepo(repoA);
    initRepo(repoB);
    const projectA = await services.addProject(store, repoA);
    // Fixture discipline: second project must exist and survive.
    const projectB = await services.addProject(store, repoB);
    const tFirst = services.createThread(store, {
      projectId: projectA.id,
      title: "idle-first",
    });
    const tSecond = services.createThread(store, {
      projectId: projectA.id,
      title: "working-second",
    });
    store.appendMessage(tFirst.id, {
      id: "m-first",
      role: "user",
      text: "must survive reject",
      createdAt: Date.now(),
    });
    // SECOND thread is the working one — proves we do not delete the first
    // before noticing the second's active run.
    store.updateThread(tSecond.id, { status: "working" });
    store.saveNow();

    await assert.rejects(
      () => services.removeProject(store, { projectId: projectA.id }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message,
          "Cannot remove a project while a run is active",
        );
        return true;
      },
    );

    // Partial-delete impossible: first thread still fully present.
    assert.ok(store.getProject(projectA.id), "project must remain");
    assert.ok(store.getThread(tFirst.id), "first thread must remain");
    assert.ok(store.getThread(tSecond.id), "second thread must remain");
    assert.equal(store.getMessages(tFirst.id).length, 1);
    assert.ok(store.getProject(projectB.id), "other project must remain");
  });

  it("removes a clean worktree and keeps its branch", async () => {
    const repo = path.join(tmpDir, "wt-repo");
    initRepoWithCommit(repo);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "has-wt",
    });
    const wt = path.join(tmpDir, "wt-live");
    git(repo, ["worktree", "add", "-b", "feature/keep-me", wt]);
    store.updateThread(thread.id, {
      worktreePath: wt,
      branch: "feature/keep-me",
    });
    store.saveNow();

    await services.removeProject(store, { projectId: project.id });

    assert.equal(store.getProject(project.id), null);
    assert.equal(store.getThread(thread.id), null);
    assert.ok(!fs.existsSync(wt), "worktree directory must be reclaimed");
    // #316 posture: commits stay reachable.
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(branches, /feature\/keep-me/);
  });

  it("a stale worktreePath (directory long gone) does not block removal", async () => {
    const repo = path.join(tmpDir, "stale-repo");
    initRepoWithCommit(repo);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "stale",
    });
    store.updateThread(thread.id, {
      worktreePath: path.join(tmpDir, "never-existed"),
    });
    store.saveNow();

    await services.removeProject(store, { projectId: project.id });

    assert.equal(store.getProject(project.id), null);
    assert.equal(store.getThread(thread.id), null);
  });

  it("leaves a dirty worktree on disk but still removes the project", async () => {
    const repo = path.join(tmpDir, "dirty-repo");
    initRepoWithCommit(repo);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "dirty",
    });
    const wt = path.join(tmpDir, "wt-dirty");
    git(repo, ["worktree", "add", "-b", "feature/dirty", wt]);
    fs.writeFileSync(path.join(wt, "uncommitted.txt"), "precious");
    store.updateThread(thread.id, {
      worktreePath: wt,
      branch: "feature/dirty",
    });
    store.saveNow();

    await services.removeProject(store, { projectId: project.id });

    assert.equal(store.getProject(project.id), null);
    assert.ok(
      fs.existsSync(path.join(wt, "uncommitted.txt")),
      "uncommitted work must never be force-deleted",
    );
  });

  it("isRunning opt rejects even when status is not working", async () => {
    const repo = path.join(tmpDir, "run-opt");
    initRepo(repo);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    assert.equal(thread.status, "idle");

    await assert.rejects(
      () =>
        services.removeProject(
          store,
          { projectId: project.id },
          { isRunning: (id) => id === thread.id },
        ),
      /Cannot remove a project while a run is active/,
    );
    assert.ok(store.getThread(thread.id));
  });

  it("persists removal: reload from disk keeps project and threads gone", async () => {
    const repoA = path.join(tmpDir, "dur-a");
    const repoB = path.join(tmpDir, "dur-b");
    initRepo(repoA);
    initRepo(repoB);
    const projectA = await services.addProject(store, repoA);
    const projectB = await services.addProject(store, repoB);
    const t1 = services.createThread(store, {
      projectId: projectA.id,
      title: "gone",
    });
    const tKeep = services.createThread(store, {
      projectId: projectB.id,
      title: "stay",
    });
    store.appendMessage(t1.id, {
      id: "m-gone",
      role: "user",
      text: "bye",
      createdAt: Date.now(),
    });
    store.setUsage(t1.id, {
      model: "x",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    store.saveNow();

    await services.removeProject(store, { projectId: projectA.id });
    store.saveNow();

    const reloaded = new Store(storePath);
    assert.equal(reloaded.getProject(projectA.id), null);
    assert.equal(reloaded.getThread(t1.id), null);
    assert.deepEqual(reloaded.getMessages(t1.id), []);
    assert.equal(reloaded.getUsage(t1.id), null);
    assert.ok(reloaded.getProject(projectB.id));
    assert.ok(reloaded.getThread(tKeep.id));
    assert.equal(reloaded.getProjects().length, 1);
    assert.equal(reloaded.getThreads().length, 1);
  });

  it("never touches the repository on disk", async () => {
    const repo = path.join(tmpDir, "disk-repo");
    initRepo(repo);
    const marker = path.join(repo, "keep-me.txt");
    fs.writeFileSync(marker, "precious");
    const project = await services.addProject(store, repo);
    services.createThread(store, { projectId: project.id, title: "T" });

    await services.removeProject(store, { projectId: project.id });

    assert.ok(fs.existsSync(repo), "repo directory must remain");
    assert.ok(fs.existsSync(marker), "files inside the repo must remain");
    assert.equal(fs.readFileSync(marker, "utf8"), "precious");
    assert.ok(fs.existsSync(path.join(repo, ".git")));
  });

  it("deleteThread still guards on a worktree; removeProject no longer does", async () => {
    assert.equal(
      services.THREAD_STILL_HAS_WORKTREE,
      "Thread still has a worktree. Merge or delete it in the Git tab first.",
    );
    const repo = path.join(tmpDir, "share-str");
    initRepoWithCommit(repo);
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "T",
    });
    store.updateThread(thread.id, { worktreePath: path.join(tmpDir, "wt-x") });

    assert.throws(
      () => services.deleteThread(store, { threadId: thread.id }),
      (err) => err.message === services.THREAD_STILL_HAS_WORKTREE,
    );
    await services.removeProject(store, { projectId: project.id });
    assert.equal(store.getProject(project.id), null);
  });
});
