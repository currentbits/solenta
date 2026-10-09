"use strict";

/**
 * git:diff scopes, ignore-whitespace and lazy per-file patches (#1493).
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, maybeCreateCheckpoint, diff } = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function fixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-diff-scopes-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, { projectId: project.id, title: "Scopes" });
  const setup = setupWorktree({
    store,
    threadId: thread.id,
    worktreeBase: path.join(tmpDir, "worktrees"),
    broadcast: () => {},
  });
  return { tmpDir, store, threadId: thread.id, wt: setup.worktreePath };
}

const paths = (res) => res.files.map((f) => f.path).sort();

describe("diff scopes (#1493)", () => {
  let fx;
  afterEach(() => {
    if (fx) fs.rmSync(fx.tmpDir, { recursive: true, force: true });
    fx = null;
  });

  it("branch scope keeps committed work that uncommitted loses", async () => {
    fx = await fixture();
    const { store, threadId, wt } = fx;
    fs.writeFileSync(path.join(wt, "committed.txt"), "one\ntwo\n");
    git(wt, ["add", "committed.txt"]);
    git(wt, ["commit", "-m", "agent work"]);
    fs.writeFileSync(path.join(wt, "README.md"), "hello\nworld\n");
    fs.writeFileSync(path.join(wt, "new.txt"), "x\n");

    const uncommitted = await diff({ store, threadId });
    assert.deepEqual(paths(uncommitted), ["README.md", "new.txt"]);

    const branch = await diff({ store, threadId, scope: "branch" });
    assert.deepEqual(paths(branch), ["README.md", "committed.txt", "new.txt"]);
    const committed = branch.files.find((f) => f.path === "committed.txt");
    assert.equal(committed.status, "A");
    assert.equal(committed.additions, 2);
    assert.equal(branch.files.find((f) => f.path === "new.txt").status, "??");
    assert.match(branch.patch, /\+\+\+ b\/committed\.txt/);
    assert.match(branch.patch, /\+world/);
    assert.match(branch.scopeLabel, /^since main \([0-9a-f]{7}\)$/);
  });

  it("turn scope is the newest checkpoint's diff, empty before one exists", async () => {
    fx = await fixture();
    const { store, threadId, wt } = fx;
    const before = await diff({ store, threadId, scope: "turn" });
    assert.deepEqual(before.files, []);

    fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
    await maybeCreateCheckpoint(store, threadId);
    fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
    await maybeCreateCheckpoint(store, threadId);
    fs.writeFileSync(path.join(wt, "dirty.txt"), "not yet\n");

    const turn = await diff({ store, threadId, scope: "turn" });
    assert.deepEqual(paths(turn), ["b.txt"]);
    assert.equal(turn.scopeLabel, "Turn 2");
  });

  it("ignoreWhitespace drops whitespace-only hunks", async () => {
    fx = await fixture();
    const { store, threadId, wt } = fx;
    fs.writeFileSync(path.join(wt, "README.md"), "  hello\n");
    const plain = await diff({ store, threadId });
    assert.match(plain.patch, /\+  hello/);
    const ws = await diff({ store, threadId, ignoreWhitespace: true });
    assert.doesNotMatch(ws.patch, /@@/);
  });

  it("omits whole large files from the list patch and serves them per file", async () => {
    fx = await fixture();
    const { store, threadId, wt } = fx;
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    fs.writeFileSync(path.join(wt, "big.txt"), `${big}\n`);
    fs.writeFileSync(path.join(wt, "small.txt"), "small\n");
    // Big files must be tracked to show in `git diff HEAD`.
    git(wt, ["add", "big.txt", "small.txt"]);

    const list = await diff({ store, threadId });
    assert.equal(list.truncated, false);
    assert.equal(list.files.find((f) => f.path === "big.txt").patchOmitted, "large");
    assert.equal(list.files.find((f) => f.path === "small.txt").patchOmitted, undefined);
    assert.doesNotMatch(list.patch, /big\.txt/);
    assert.match(list.patch, /\+small/);

    const capped = await diff({ store, threadId, path: "big.txt" });
    assert.equal(capped.truncated, true);
    assert.equal(capped.patch.length, 60_000);

    const full = await diff({ store, threadId, path: "big.txt", full: true });
    assert.equal(full.truncated, false);
    assert.match(full.patch, /\+line 3999 /);

    await assert.rejects(diff({ store, threadId, path: "../escape" }), /escapes/);
  });

  it("caps untracked line counting by count and size (#1520)", async () => {
    fx = await fixture();
    const { store, threadId, wt } = fx;
    fs.writeFileSync(path.join(wt, "big.txt"), "x\n".repeat(600_000)); // > 1 MB
    fs.mkdirSync(path.join(wt, "out"));
    for (let i = 0; i < 510; i++) {
      fs.writeFileSync(path.join(wt, "out", `f${String(i).padStart(3, "0")}.txt`), "a\nb\n");
    }
    const res = await diff({ store, threadId });
    const untracked = res.files.filter((f) => f.status === "??");
    assert.equal(untracked.length, 511);
    assert.equal(untracked.find((f) => f.path === "big.txt").additions, 0);
    const counted = untracked.filter((f) => f.additions === 2).length;
    assert.equal(counted, 499); // 500 read, one of them big.txt
  });
});
