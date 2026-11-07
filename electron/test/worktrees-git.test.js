"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { gitEnv, gitOutAsync, gitOutForDiffAsync, gitTryAsync, setExecFile, resolveGitCommand } = require("../worktrees-git.js");

describe("gitEnv (#1520 optional locks)", () => {
  afterEach(() => setExecFile(null));

  it("reads Git diagnostics in English while preserving hooks' locale and explicit overrides", () => {
    const env = gitEnv(["status"], { LANG: "de_DE.UTF-8", LC_CTYPE: "ja_JP.UTF-8" });
    assert.equal(env.LANGUAGE, "C");
    assert.equal(env.LANG, "de_DE.UTF-8");
    assert.equal(env.LC_CTYPE, "ja_JP.UTF-8");
    assert.equal(gitEnv(["status"], { LANGUAGE: "fr" }).LANGUAGE, "fr");
  });

  it("applies the diagnostic locale to actual local and SSH spawns", async () => {
    const seen = [];
    setExecFile((bin, args, opts, cb) => {
      seen.push({ bin, args, env: opts.env });
      cb(null, "", "");
    });
    await gitOutAsync("/tmp", ["status"]);
    await gitTryAsync("/tmp", ["commit", "-m", "x"], { env: { LANGUAGE: "fr" } });
    await gitOutForDiffAsync({ remoteHost: "dev@box", remotePath: "/srv/app" }, "/srv/app", ["status"]);
    assert.equal(seen[0].env.LANGUAGE, "C");
    assert.equal(seen[1].env.LANGUAGE, "fr");
    assert.equal(seen[2].bin, "ssh");
    assert.match(seen[2].args.at(-1), /'env' 'LANGUAGE=C' 'git' 'status'/);
  });

  it("sets the diagnostic locale inside WSL rather than only on wsl.exe", () => {
    const cwd = "\\\\wsl$\\Ubuntu\\home\\me\\repo";
    assert.deepEqual(resolveGitCommand(cwd, ["status"], "win32").args.slice(-4), ["env", "LANGUAGE=C", "git", "status"]);
    assert.deepEqual(resolveGitCommand(cwd, ["status"], "win32", { LANGUAGE: "fr" }).args.slice(-4), ["env", "LANGUAGE=fr", "git", "status"]);
  });

  it("sets GIT_OPTIONAL_LOCKS=0 on read-only subcommands only", () => {
    for (const args of [["status", "--porcelain"], ["diff"], ["log"], ["rev-parse", "HEAD"], ["-c", "x=y", "status"]]) {
      assert.equal(gitEnv(args).GIT_OPTIONAL_LOCKS, "0", args.join(" "));
    }
    for (const args of [["commit", "-m", "x"], ["add", "-A"], ["reset", "--hard"], ["merge", "b"], ["worktree", "add", "d"]]) {
      assert.equal(gitEnv(args, { GIT_OPTIONAL_LOCKS: undefined }).GIT_OPTIONAL_LOCKS, undefined, args.join(" "));
    }
  });

  it("appends core.longpaths on win32 only, after existing GIT_CONFIG_COUNT (#1523)", () => {
    const fresh = gitEnv(["status"], { GIT_CONFIG_COUNT: undefined }, "win32");
    assert.equal(fresh.GIT_CONFIG_COUNT, "1");
    assert.equal(fresh.GIT_CONFIG_KEY_0, "core.longpaths");
    assert.equal(fresh.GIT_CONFIG_VALUE_0, "true");

    const kept = gitEnv(["commit"], { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" }, "win32");
    assert.equal(kept.GIT_CONFIG_COUNT, "2");
    assert.equal(kept.GIT_CONFIG_KEY_0, "a.b");
    assert.equal(kept.GIT_CONFIG_KEY_1, "core.longpaths");

    assert.equal(gitEnv(["status"], { GIT_CONFIG_COUNT: undefined }, "darwin").GIT_CONFIG_COUNT, undefined);
  });

  it("reaches the spawn for async reads and not for writes", async () => {
    const seen = [];
    setExecFile((bin, args, opts, cb) => {
      seen.push([args[0], opts.env && opts.env.GIT_OPTIONAL_LOCKS]);
      cb(null, "", "");
    });
    await gitOutAsync("/tmp", ["status", "--porcelain"]);
    await gitTryAsync("/tmp", ["commit", "-m", "x"], { env: { GIT_OPTIONAL_LOCKS: undefined } });
    assert.deepEqual(seen, [["status", "0"], ["commit", undefined]]);
  });
});
