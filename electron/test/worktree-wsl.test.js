const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { isWindowsMount } = require("../wsl.js");
const {
  resolveWorktreeDir,
  resolveGitCommand,
  linuxPathToUnc,
} = require("../worktrees.js");

// The suite runs on macOS/Linux, so every win32 case passes the platform in.
const WIN = "win32";
const BASE = "C:\\Users\\me\\AppData\\Roaming\\Solenta\\worktrees";
const THREAD = "thread-abc";

describe("resolveWorktreeDir", () => {
  it("keeps today's userData path off win32", () => {
    const project = { path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" };
    const out = resolveWorktreeDir(project, BASE, THREAD, "darwin");
    const expected = path.join(BASE, THREAD);
    assert.deepEqual(out, { dir: expected, addPath: expected });
  });

  it("keeps today's userData path for a windows-side project", () => {
    const out = resolveWorktreeDir({ path: "C:\\repo" }, BASE, THREAD, WIN);
    const expected = path.join(BASE, THREAD);
    assert.deepEqual(out, { dir: expected, addPath: expected });
  });

  it("keeps today's userData path for an ssh remote", () => {
    const project = {
      remoteHost: "dev@box",
      path: "\\\\wsl$\\Ubuntu\\home\\me\\repo",
    };
    const out = resolveWorktreeDir(project, BASE, THREAD, WIN);
    const expected = path.join(BASE, THREAD);
    assert.deepEqual(out, { dir: expected, addPath: expected });
  });

  it("parks a WSL-side worktree next to the repo, inside the distro", () => {
    const project = { path: "\\\\wsl$\\Ubuntu\\home\\me\\code\\repo" };
    const out = resolveWorktreeDir(project, BASE, THREAD, WIN);
    assert.equal(out.addPath, "/home/me/code/.solenta/worktrees/thread-abc");
    assert.equal(
      out.dir,
      "\\\\wsl$\\Ubuntu\\home\\me\\code\\.solenta\\worktrees\\thread-abc",
    );
    assert.equal(isWindowsMount(out.addPath), false);
    assert.notEqual(out.dir, path.join(BASE, THREAD));
  });

  it("preserves the \\\\wsl.localhost prefix on the stored UNC", () => {
    const project = { path: "\\\\wsl.localhost\\Ubuntu-22.04\\srv\\app" };
    const out = resolveWorktreeDir(project, BASE, THREAD, WIN);
    assert.equal(out.addPath, "/srv/.solenta/worktrees/thread-abc");
    assert.equal(
      out.dir,
      "\\\\wsl.localhost\\Ubuntu-22.04\\srv\\.solenta\\worktrees\\thread-abc",
    );
  });

  it("refuses /mnt/<drive> and parks on ext4 instead", () => {
    const project = { path: "\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\repo" };
    const out = resolveWorktreeDir(project, BASE, THREAD, WIN);
    assert.equal(out.addPath, "/tmp/solenta-worktrees/thread-abc");
    assert.equal(isWindowsMount(out.addPath), false);
    assert.equal(
      out.dir,
      "\\\\wsl$\\Ubuntu\\tmp\\solenta-worktrees\\thread-abc",
    );
  });
});

describe("linuxPathToUnc", () => {
  it("rebuilds a \\\\wsl$ UNC from a linux path", () => {
    assert.equal(
      linuxPathToUnc("\\\\wsl$\\Ubuntu\\home\\me\\repo", "/home/me/.solenta/worktrees/x"),
      "\\\\wsl$\\Ubuntu\\home\\me\\.solenta\\worktrees\\x",
    );
  });
});

describe("resolveGitCommand", () => {
  it("leaves a local path as git + cwd off win32", () => {
    const out = resolveGitCommand("/Users/me/repo", ["status"], "darwin");
    assert.deepEqual(out, { bin: "git", args: ["status"], cwd: "/Users/me/repo" });
  });

  it("leaves a windows drive path as git + cwd", () => {
    const out = resolveGitCommand("C:\\repo", ["status"], WIN);
    assert.deepEqual(out, { bin: "git", args: ["status"], cwd: "C:\\repo" });
  });

  it("wraps a WSL UNC as wsl.exe --cd, with no Windows cwd", () => {
    const out = resolveGitCommand("\\\\wsl$\\Ubuntu\\home\\me\\repo", ["status"], WIN);
    assert.equal(out.bin, "wsl.exe");
    assert.deepEqual(out.args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "git",
      "status",
    ]);
    assert.equal(out.cwd, undefined);
  });

  it("rewrites a WSL UNC worktree arg to the linux path", () => {
    const repo = "\\\\wsl$\\Ubuntu\\home\\me\\repo";
    const wt = "\\\\wsl$\\Ubuntu\\home\\me\\.solenta\\worktrees\\abc";
    const out = resolveGitCommand(repo, ["worktree", "remove", wt], WIN);
    assert.equal(out.bin, "wsl.exe");
    assert.deepEqual(out.args, [
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "git",
      "worktree",
      "remove",
      "/home/me/.solenta/worktrees/abc",
    ]);
  });

  it("does not wrap a WSL-looking UNC off win32", () => {
    const unc = "\\\\wsl$\\Ubuntu\\home\\me\\repo";
    const out = resolveGitCommand(unc, ["status"], "darwin");
    assert.deepEqual(out, { bin: "git", args: ["status"], cwd: unc });
  });
});
