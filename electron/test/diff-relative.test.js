"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { diff, listChangedPaths, listChangedPathsAsync } = require("../worktrees-changes.js");
const { turnDiff, runStats } = require("../worktrees-checkpoints.js");
const { resetGitReadCaches } = require("../worktrees-git.js");

describe("repository-relative internal diffs (#1942)", () => {
  let tmp, repo, sub, thread, project, store;
  const git = (...args) => execFileSync("git", args, {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const write = (file, body) => fs.writeFileSync(path.join(repo, file), body);
  const read = (opts = {}) => {
    resetGitReadCaches();
    return diff({ store, threadId: thread.id, ...opts });
  };
  const rows = (result) => result.files.map(({ path, additions, deletions }) =>
    ({ path, additions, deletions })).sort((a, b) => a.path.localeCompare(b.path));
  const expected = [
    { path: "root.txt", additions: 1, deletions: 1 },
    { path: "sub/inside.txt", additions: 1, deletions: 1 },
  ];
  const assertTracked = (result) => {
    assert.deepEqual(rows(result), expected);
    assert.deepEqual(result.patch.match(/^diff --git .+$/gm), [
      "diff --git a/root.txt b/root.txt",
      "diff --git a/sub/inside.txt b/sub/inside.txt",
    ]);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-diff-relative-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    sub = path.join(repo, "sub");
    fs.mkdirSync(sub);
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Diff fixture");
    git("config", "diff.relative", "false");
    write("root.txt", "before\n");
    write("sub/inside.txt", "before\n");
    git("add", ".");
    git("commit", "-m", "fixture");
    thread = { id: "fixture", projectId: "fixture", worktreePath: sub, baseBranch: "main" };
    project = { id: "fixture", path: sub };
    store = { getThread: () => thread, getProject: () => project };
    resetGitReadCaches();
  });

  afterEach(() => {
    resetGitReadCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const cwdKind of ["repository root", "subfolder project", "subfolder worktree"]) {
    it(`keeps both tracked files and patches from a ${cwdKind} cwd`, async () => {
      if (cwdKind === "repository root") thread.worktreePath = project.path = repo;
      else if (cwdKind === "subfolder project") thread.worktreePath = null;
      else project.path = repo;
      write("root.txt", "after\n");
      write("sub/inside.txt", "after\n");
      const baseline = await read({ scope: "uncommitted" });
      assertTracked(baseline);
      git("config", "diff.relative", "true");
      const config = fs.readFileSync(path.join(repo, ".git/config"), "utf8");
      const relative = await read({ scope: "uncommitted" });
      assertTracked(relative);
      assert.equal(relative.patch, baseline.patch);
      assert.equal(fs.readFileSync(path.join(repo, ".git/config"), "utf8"), config);
    });
  }

  it("uses list identities for per-file patches and untracked line counts", async () => {
    git("config", "diff.relative", "true");
    write("root.txt", "after\n");
    write("sub/inside.txt", "after\n");
    write("new.txt", "one\ntwo\n");
    write("sub/new.txt", "three\n");
    const result = await read();
    assert.equal(result.files.find((f) => f.path === "new.txt").additions, 2);
    assert.equal(result.files.find((f) => f.path === "sub/new.txt").additions, 1);
    for (const file of ["root.txt", "sub/inside.txt"]) {
      const one = await read({ path: file });
      assert.deepEqual(one.patch.match(/^diff --git .+$/gm), [`diff --git a/${file} b/${file}`]);
    }
    await assert.rejects(read({ path: "../escape" }), /escapes/);
  });

  it("keeps branch, checkpoint patches and run statistics repository-wide", async () => {
    git("checkout", "-b", "work");
    write("root.txt", "after\n");
    write("sub/inside.txt", "after\n");
    git("add", ".");
    git("commit", "-m", "coder-checkpoint: turn 1");
    const sha = git("rev-parse", "HEAD");
    git("config", "diff.relative", "true");
    assertTracked(await read({ scope: "branch" }));
    assertTracked(await read({ scope: "turn" }));
    assertTracked(await turnDiff({ store, threadId: thread.id, sha }));
    const stats = await runStats({ store, threadId: thread.id });
    assert.deepEqual(stats, [{ sha, turn: 1, files: 2, additions: 2, deletions: 2 }]);
  });

  it("counts untracked files when the subfolder cwd is a symlink", { skip: process.platform === "win32" }, async () => {
    const link = path.join(tmp, "linked-sub");
    fs.symlinkSync(sub, link, "dir");
    thread.worktreePath = project.path = link;
    git("config", "diff.relative", "true");
    write("new.txt", "one\ntwo\n");
    write("sub/new.txt", "three\n");
    const result = await read();
    assert.equal(result.files.find((f) => f.path === "new.txt").additions, 2);
    assert.equal(result.files.find((f) => f.path === "sub/new.txt").additions, 1);
  });

  it("keeps committed changed-path reads consistent with porcelain paths", async () => {
    git("checkout", "-b", "work");
    write("root.txt", "after\n");
    write("sub/inside.txt", "after\n");
    git("add", ".");
    git("commit", "-m", "work");
    git("config", "diff.relative", "true");
    assert.deepEqual(listChangedPaths(sub, { base: "main" }), {
      ok: true, paths: ["root.txt", "sub/inside.txt"],
    });
    assert.deepEqual(await listChangedPathsAsync(sub, "main"), {
      ok: true, paths: ["root.txt", "sub/inside.txt"],
    });
  });

  it("classifies and inspects committed workflow changes outside the subfolder", async () => {
    git("checkout", "-b", "work");
    fs.mkdirSync(path.join(repo, ".github/workflows"), { recursive: true });
    write(".github/workflows/ci.yml", "jobs:\n  test:\n    steps:\n      - run: echo ${{ github.event.issue.title }}\n");
    git("add", ".");
    git("commit", "-m", "workflow");
    // The project stays on main while the thread reviews another checkout.
    const main = path.join(tmp, "main-worktree");
    git("worktree", "add", main, "main");
    project.path = path.join(main, "sub");
    git("config", "diff.relative", "true");
    const result = await read();
    assert.deepEqual(result.blastRadius.files, [".github/workflows/ci.yml"]);
    assert.equal(result.blastRadius.findings.length, 1);
    assert.equal(result.blastRadius.findings[0].path, ".github/workflows/ci.yml");
  });

  it("preserves rename detection and the explicit whitespace toggle", async () => {
    git("mv", "sub/inside.txt", "sub/renamed.txt");
    write("root.txt", "  before\n");
    const baseline = await read();
    assert.match(baseline.patch, /rename from sub\/inside.txt\nrename to sub\/renamed.txt/);
    git("config", "diff.relative", "true");
    const relative = await read();
    assert.deepEqual(relative.files, baseline.files);
    assert.equal(relative.patch, baseline.patch);
    const ignored = await read({ ignoreWhitespace: true });
    assert.doesNotMatch(ignored.patch, /@@/);
    assert.match(ignored.patch, /rename to sub\/renamed.txt/);
    const branch = await read({ scope: "branch" });
    assert.doesNotMatch(branch.patch, /rename (from|to)/);
    assert.equal(branch.files.find((f) => f.path === "sub/inside.txt").status, "D");
    assert.equal(branch.files.find((f) => f.path === "sub/renamed.txt").status, "A");
  });
});
