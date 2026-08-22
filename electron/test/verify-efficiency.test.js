"use strict";

/**
 * Issue #390: shared build cache across worktrees.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { cacheEnv, repoCacheKey } = require("../verifyEfficiency.js");
const { runVerifyCommand } = require("../verify.js");
const { agentSpawnOptions } = require("../proc.js");

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 0;
  process.nextTick(() => child.emit("close", exitCode));
  return child;
}

function existsSet(names) {
  const set = new Set(names);
  return (rel) => set.has(String(rel).replace(/\\/g, "/"));
}

describe("repoCacheKey", () => {
  it("is stable for a path and differs across repos with the same basename", () => {
    const a = repoCacheKey("/code/app");
    const b = repoCacheKey("/other/app");
    assert.equal(repoCacheKey("/code/app"), a);
    assert.notEqual(a, b);
    assert.match(a, /^app-/);
  });
});

describe("cacheEnv", () => {
  const cacheRoot = "/tmp/solenta-cache/app";
  const cwd = "/worktrees/thread-1";

  it("points turbo at a shared cache dir", () => {
    const env = cacheEnv({
      cwd,
      cacheRoot,
      exists: existsSet(["turbo.json"]),
      env: {},
    });
    assert.equal(env.TURBO_CACHE_DIR, path.join(cacheRoot, "turbo"));
  });

  it("points nx at a shared cache and disables the daemon", () => {
    const env = cacheEnv({
      cwd,
      cacheRoot,
      exists: existsSet(["nx.json"]),
      env: {},
    });
    assert.equal(env.NX_CACHE_DIRECTORY, path.join(cacheRoot, "nx"));
    assert.equal(env.NX_DAEMON, "false");
  });

  it("shares cargo target + sccache across worktrees", () => {
    const env = cacheEnv({
      cwd,
      cacheRoot,
      exists: existsSet(["Cargo.toml"]),
      env: {},
    });
    assert.equal(env.CARGO_TARGET_DIR, path.join(cacheRoot, "cargo-target"));
    assert.equal(env.SCCACHE_DIR, path.join(cacheRoot, "sccache"));
  });

  it("does not override env the user already set", () => {
    const env = cacheEnv({
      cwd,
      cacheRoot,
      exists: existsSet(["turbo.json", "nx.json"]),
      env: { TURBO_CACHE_DIR: "/mine", NX_DAEMON: "true" },
    });
    assert.equal(env.TURBO_CACHE_DIR, undefined);
    assert.equal(env.NX_DAEMON, undefined);
    assert.equal(env.NX_CACHE_DIRECTORY, path.join(cacheRoot, "nx"));
  });

  it("returns nothing when no toolchain files are present", () => {
    const env = cacheEnv({
      cwd,
      cacheRoot,
      exists: existsSet([]),
      env: {},
    });
    assert.deepEqual(env, {});
  });

  it("uses the same cache root for two worktrees of one repo", () => {
    const a = cacheEnv({
      cwd: "/worktrees/aaa",
      repoRoot: "/code/solenta",
      exists: existsSet(["turbo.json"]),
      env: {},
    });
    const b = cacheEnv({
      cwd: "/worktrees/bbb",
      repoRoot: "/code/solenta",
      exists: existsSet(["turbo.json"]),
      env: {},
    });
    assert.equal(a.TURBO_CACHE_DIR, b.TURBO_CACHE_DIR);
    assert.match(a.TURBO_CACHE_DIR, /solenta-/);
  });

  it("resolves git worktrees to the main checkout without an explicit repoRoot", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wtcache-"));
    try {
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@example.com"], {
        cwd: repo,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "T"], {
        cwd: repo,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(repo, "turbo.json"), "{}\n");
      execFileSync("git", ["add", "turbo.json"], { cwd: repo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: repo,
        stdio: "ignore",
      });
      const wt = path.join(tmp, "wt");
      execFileSync("git", ["worktree", "add", wt], { cwd: repo, stdio: "ignore" });
      const fromMain = cacheEnv({ cwd: repo, env: {} });
      const fromWt = cacheEnv({ cwd: wt, env: {} });
      assert.ok(fromMain.TURBO_CACHE_DIR);
      assert.equal(fromMain.TURBO_CACHE_DIR, fromWt.TURBO_CACHE_DIR);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runVerifyCommand cache env", () => {
  it("injects TURBO_CACHE_DIR into the child env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-vcache-"));
    try {
      fs.writeFileSync(path.join(dir, "turbo.json"), "{}\n");
      const calls = [];
      const r = await runVerifyCommand({
        command: "echo hi",
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        spawn: (bin, args, opts) => {
          calls.push({ bin, args, opts });
          return fakeChild();
        },
      });
      assert.equal(r.ok, true);
      assert.ok(calls[0].opts.env.TURBO_CACHE_DIR);
      assert.match(calls[0].opts.env.TURBO_CACHE_DIR, /build-cache/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agentSpawnOptions cache env", () => {
  it("injects cache env when the cwd has turbo.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-aspawn-"));
    try {
      fs.writeFileSync(path.join(dir, "turbo.json"), "{}\n");
      const opts = agentSpawnOptions({
        cwd: dir,
        stdio: "pipe",
        platform: "linux",
      });
      assert.ok(opts.env);
      assert.ok(opts.env.TURBO_CACHE_DIR);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not add env when cwd has no toolchain files", () => {
    const opts = agentSpawnOptions({
      cwd: os.tmpdir(),
      stdio: "pipe",
      platform: "linux",
    });
    assert.equal("env" in opts, false);
  });
});
