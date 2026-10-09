"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { gitEnv, gitOutAsync, gitTryAsync, setExecFile } = require("../worktrees-git.js");

describe("gitEnv (#1520 optional locks)", () => {
  afterEach(() => setExecFile(null));

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
