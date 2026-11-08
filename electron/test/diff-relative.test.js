"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { diff, imageDiff, commit, revertFile, revertHunk, listChangedPaths, listChangedPathsAsync } = require("../worktrees-changes.js");
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

  function collidingChanges() {
    write("sub/root.txt", "sibling before\n");
    git("add", ".");
    git("commit", "-m", "colliding names");
    write("root.txt", "after\n");
    write("sub/root.txt", "sibling after\n");
  }

  for (const cwdKind of ["subfolder", "symlink subfolder"]) {
    const selectCwd = () => {
      if (cwdKind === "symlink subfolder") {
        const link = path.join(tmp, "linked-sub");
        fs.symlinkSync(sub, link, "dir");
        thread.worktreePath = project.path = link;
      }
    };
    const options = { skip: cwdKind === "symlink subfolder" && process.platform === "win32" };

    it(`commits the displayed file without its cwd-relative sibling from a ${cwdKind}`, options, async () => {
      collidingChanges();
      selectCwd();
      const shown = await read({ path: "root.txt" });
      assert.match(shown.patch, /diff --git a\/root.txt b\/root.txt/);
      await read(); // Prime the default view's cwd-keyed cache before mutation.
      commit({ store, threadId: thread.id, message: "selected root", paths: ["root.txt"] });
      assert.equal(git("show", "HEAD:root.txt"), "after");
      assert.equal(git("show", "HEAD:sub/root.txt"), "sibling before");
      assert.equal(git("status", "--porcelain").trim(), "M sub/root.txt");
      assert.deepEqual((await diff({ store, threadId: thread.id })).files.map((f) => f.path), ["sub/root.txt"]);
    });

    it(`reverts the displayed file without its cwd-relative sibling from a ${cwdKind}`, options, async () => {
      collidingChanges();
      selectCwd();
      await read();
      revertFile({ store, threadId: thread.id, path: "root.txt", status: "M" });
      assert.equal(fs.readFileSync(path.join(repo, "root.txt"), "utf8"), "before\n");
      assert.equal(fs.readFileSync(path.join(sub, "root.txt"), "utf8"), "sibling after\n");
      assert.deepEqual((await diff({ store, threadId: thread.id })).files.map((f) => f.path), ["sub/root.txt"]);
    });

    it(`reverts the displayed hunk without its cwd-relative sibling from a ${cwdKind}`, options, async () => {
      collidingChanges();
      selectCwd();
      const { patch } = await read({ path: "root.txt" });
      await read();
      revertHunk({ store, threadId: thread.id, path: "root.txt", patch });
      assert.equal(fs.readFileSync(path.join(repo, "root.txt"), "utf8"), "before\n");
      assert.equal(fs.readFileSync(path.join(sub, "root.txt"), "utf8"), "sibling after\n");
      assert.deepEqual((await diff({ store, threadId: thread.id })).files.map((f) => f.path), ["sub/root.txt"]);
    });

    it(`partially commits the displayed file from a ${cwdKind} and preserves staged siblings`, options, async () => {
      collidingChanges();
      git("add", "sub/root.txt");
      selectCwd();
      const { patch } = await read({ path: "root.txt" });
      commit({
        store, threadId: thread.id, message: "root patch", paths: ["root.txt"],
        patches: [{ path: "root.txt", patch }],
      });
      assert.equal(git("show", "HEAD:root.txt"), "after");
      assert.equal(git("show", "HEAD:sub/root.txt"), "sibling before");
      assert.equal(git("status", "--porcelain").trim(), "M  sub/root.txt");
    });

    it(`previews the displayed image from a ${cwdKind} without reading its cwd-relative sibling`, options, async () => {
      const before = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
      const after = Buffer.from("GIF89a\x02\x00\x01\x00", "latin1");
      write("icon.gif", before);
      write("sub/icon.gif", before);
      git("add", ".");
      git("commit", "-m", "image names");
      write("icon.gif", after);
      selectCwd();
      assert.ok((await read()).files.some((f) => f.path === "icon.gif"));
      const result = await imageDiff({ store, threadId: thread.id, path: "icon.gif" });
      assert.equal(result.before.dataUrl, `data:image/gif;base64,${before.toString("base64")}`);
      assert.equal(result.after.dataUrl, `data:image/gif;base64,${after.toString("base64")}`);
      assert.deepEqual(fs.readFileSync(path.join(sub, "icon.gif")), before);
    });

    for (const status of ["??", "A"]) {
      it(`discards only the selected ${status === "A" ? "staged-new" : "untracked"} file from a ${cwdKind}`, options, () => {
        write("new.txt", "root\n");
        write("sub/new.txt", "sibling\n");
        if (status === "A") git("add", ".");
        selectCwd();
        revertFile({ store, threadId: thread.id, path: "new.txt", status });
        assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
        assert.equal(fs.readFileSync(path.join(sub, "new.txt"), "utf8"), "sibling\n");
      });
    }
  }

  it("uses literal names when committing or reverting files containing pathspec syntax", () => {
    thread.worktreePath = project.path = repo;
    write("[a].txt", "before\n");
    write("a.txt", "sibling before\n");
    git("add", ".");
    git("commit", "-m", "literal names");
    write("[a].txt", "after\n");
    write("a.txt", "sibling after\n");
    commit({ store, threadId: thread.id, message: "literal file", paths: ["[a].txt"] });
    assert.equal(git("show", "HEAD:[a].txt"), "after");
    assert.equal(git("show", "HEAD:a.txt"), "sibling before");
    write("[a].txt", "another change\n");
    revertFile({ store, threadId: thread.id, path: "[a].txt", status: "M" });
    assert.equal(fs.readFileSync(path.join(repo, "[a].txt"), "utf8"), "after\n");
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "sibling after\n");
  });

  for (const [selected, sibling] of [
    ["[a].txt", "a.txt"],
    ["star*.txt", "star-other.txt"],
    ["question?.txt", "question1.txt"],
    ["slash\\name.txt", "slashname.txt"],
  ]) {
    it(`restricts the selected ${selected} hunk to its literal file`, {
      skip: process.platform === "win32" && /[?*\\]/.test(selected),
    }, () => {
      thread.worktreePath = project.path = repo;
      write(selected, "before\n");
      write(sibling, "sibling before\n");
      git("add", ".");
      git("commit", "-m", "literal names");
      write(selected, "after\n");
      write(sibling, "sibling after\n");
      // Even a payload containing another file's patch stays inside the selection.
      const patch = git("diff", "--no-relative", "HEAD");
      revertHunk({ store, threadId: thread.id, path: selected, patch });
      assert.equal(fs.readFileSync(path.join(repo, selected), "utf8"), "before\n");
      assert.equal(fs.readFileSync(path.join(repo, sibling), "utf8"), "sibling after\n");
    });
  }
});
