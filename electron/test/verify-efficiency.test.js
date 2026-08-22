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
const {
  cacheEnv,
  repoCacheKey,
  scopeVerifyCommand,
  prepareVerifyRun,
} = require("../verifyEfficiency.js");
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

describe("scopeVerifyCommand", () => {
  const exists = existsSet(["test/foo.test.ts"]);
  const opts = { base: "main", exists };

  it("scopes node --test and bails on docs, lockfiles, unknown, --all, compound npm", () => {
    assert.equal(
      scopeVerifyCommand({
        command: "node --test",
        changedPaths: ["src/foo.ts"],
        ...opts,
      }).command,
      "node --test test/foo.test.ts",
    );
    assert.equal(
      scopeVerifyCommand({
        command: "npm test",
        changedPaths: ["README.md"],
        base: "main",
      }).command,
      "exit 0",
    );
    assert.equal(
      scopeVerifyCommand({
        command: "node --test",
        changedPaths: ["src/foo.ts", "package-lock.json"],
        ...opts,
      }).scoped,
      false,
    );
    assert.equal(
      scopeVerifyCommand({ command: "node --test", changedPaths: null }).scoped,
      false,
    );
    assert.equal(
      scopeVerifyCommand({
        command: "node --test --all",
        changedPaths: ["src/foo.ts"],
        ...opts,
      }).scoped,
      false,
    );
    assert.equal(
      scopeVerifyCommand({
        command: "npm test",
        changedPaths: ["src/foo.ts"],
        ...opts,
        readFile: () => JSON.stringify({ scripts: { test: "a && b" } }),
      }).command,
      "npm test",
    );
  });
});

describe("scopeVerifyCommand extra runners", () => {
  const base = "main";

  it("adds turbo --filter for packages changed since base", () => {
    const r = scopeVerifyCommand({
      command: "turbo run test",
      changedPaths: ["packages/ui/src/button.ts"],
      base,
    });
    assert.equal(r.command, "turbo run test --filter=...[main]");
  });

  it("leaves an already-filtered turbo command alone", () => {
    const r = scopeVerifyCommand({
      command: "turbo run test --filter=ui",
      changedPaths: ["packages/ui/src/button.ts"],
      base,
    });
    assert.equal(r.scoped, false);
  });

  it("rewrites nx run-many to affected and keeps the target name", () => {
    assert.equal(
      scopeVerifyCommand({
        command: "npx nx run-many -t test",
        changedPaths: ["apps/web/src/a.ts"],
        base,
      }).command,
      "npx nx affected -t test --base=main --head=HEAD",
    );
    assert.equal(
      scopeVerifyCommand({
        command: "nx run-many -t lint",
        changedPaths: ["apps/web/src/a.ts"],
        base,
      }).command,
      "nx affected -t lint --base=main --head=HEAD",
    );
  });

  it("does not rewrite nx --all", () => {
    assert.equal(
      scopeVerifyCommand({
        command: "nx run-many -t test --all",
        changedPaths: ["apps/web/src/a.ts"],
        base,
      }).scoped,
      false,
    );
  });

  it("scopes jest, vitest, pytest, and go test", () => {
    assert.equal(
      scopeVerifyCommand({
        command: "npx jest",
        changedPaths: ["src/foo.ts", "src/foo.test.ts"],
        base,
      }).command,
      "npx jest --findRelatedTests src/foo.ts src/foo.test.ts",
    );
    assert.equal(
      scopeVerifyCommand({
        command: "npx vitest run",
        changedPaths: ["src/foo.ts"],
        base,
      }).command,
      "npx vitest related src/foo.ts --run",
    );
    assert.equal(
      scopeVerifyCommand({
        command: "pytest",
        changedPaths: ["pkg/foo.py", "pkg/test_foo.py"],
        base,
      }).command,
      "pytest pkg/foo.py pkg/test_foo.py",
    );
    assert.equal(
      scopeVerifyCommand({
        command: "go test ./...",
        changedPaths: ["internal/foo/foo.go", "internal/bar/bar.go"],
        base,
      }).command,
      "go test ./internal/bar ./internal/foo",
    );
  });

  it("unwraps npm test when the script is a single known runner", () => {
    const r = scopeVerifyCommand({
      command: "npm test",
      changedPaths: ["packages/ui/src/a.ts"],
      base,
      readFile: () => JSON.stringify({ scripts: { test: "turbo run test" } }),
    });
    assert.equal(r.command, "turbo run test --filter=...[main]");
  });

  it("maps electron/foo.js to electron/test/foo.test.js when it exists", () => {
    const r = scopeVerifyCommand({
      command: "node --test",
      changedPaths: ["electron/verifyEfficiency.js"],
      base,
      exists: existsSet(["electron/test/verify-efficiency.test.js"]),
    });
    assert.equal(
      r.command,
      "node --test electron/test/verify-efficiency.test.js",
    );
  });
});

describe("prepareVerifyRun", () => {
  it("merges cache env and scopes node --test", () => {
    const r = prepareVerifyRun({
      command: "node --test",
      cacheRoot: "/tmp/cache/app",
      changedPaths: ["src/foo.ts"],
      exists: existsSet(["turbo.json", "test/foo.test.ts"]),
      env: {},
    });
    assert.equal(r.command, "node --test test/foo.test.ts");
    assert.equal(r.env.TURBO_CACHE_DIR, path.join("/tmp/cache/app", "turbo"));
    assert.equal(
      prepareVerifyRun({
        command: "node --test",
        changedPaths: null,
        cacheRoot: "/tmp/cache/app",
        exists: existsSet(["turbo.json"]),
        env: {},
      }).scoped,
      false,
    );
  });
});
