/**
 * Live #1160 / #1161 proof: git add/commit inside Codex workspace-write
 * with Solenta writable_roots. Linux must fail, never skip, if the CLI,
 * fixture, or sandbox is unavailable. In particular, an index.lock denial
 * with writable_roots is a regression, not an unsupported environment.
 *
 * The fixture must NOT live under /tmp: workspace-write already allows
 * /tmp, which would make a tmp worktree a false pass.
 *
 * Run: node --test electron/test/codex-git-sandbox.test.js
 * Optional: SOLENTA_CODEX_GIT_TEST_ROOT selects a writable non-temp parent.
 */
"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  codexWorkspaceWritableRoots,
  codexWorkspaceWriteArgs,
} = require("../codexWorkspaceWrite.js");

function which(bin) {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.hooksPath", "/dev/null"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

function sandboxCommand(codex, extraArgs, cwd, env, command) {
  try {
    execFileSync(
      codex,
      [
        "sandbox",
        "-c",
        "sandbox_mode=workspace-write",
        ...extraArgs,
        "--",
        ...command,
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 20000,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { ok: true, output: "" };
  } catch (err) {
    return {
      ok: false,
      output: `${err.message || ""}\n${err.stdout || ""}\n${err.stderr || ""}`,
    };
  }
}

function writableRootsArgs(cwd) {
  return codexWorkspaceWriteArgs({
    cwd,
    permissionMode: "default",
    allowNetwork: false,
  });
}

function unavailable(t, reason) {
  assert.notEqual(process.platform, "linux", reason);
  t.skip(reason);
}

function assertDenied(result, label) {
  assert.equal(result.ok, false, `${label}: sandbox unexpectedly allowed a write`);
  assert.match(
    result.output,
    /Permission denied|Operation not permitted|Read-only file system/i,
    `${label}: expected filesystem denial, got:\n${result.output}`,
  );
}

describe("live Codex workspace-write git commit (#1160 / #1161)", () => {
  const cacheRoot =
    process.env.SOLENTA_CODEX_GIT_TEST_ROOT ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : path.join(os.homedir(), ".cache"));
  /** @type {string[]} */
  const cleanup = [];
  after(() => {
    for (const dir of cleanup) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const linked of [false, true]) {
    it(`git add and commit succeed in a ${linked ? "linked worktree" : "standalone checkout"}`, (t) => {
      const codex = process.env.CODER_CODEX_BIN || which("codex");
      if (!codex) {
        unavailable(t, "codex CLI not installed");
        return;
      }
      let base;
      try {
        fs.mkdirSync(cacheRoot, { recursive: true });
        base = fs.mkdtempSync(path.join(cacheRoot, "solenta-codex-git-"));
      } catch (err) {
        unavailable(t, `cannot create cache fixture: ${err && err.message}`);
        return;
      }
      cleanup.push(base);
      base = fs.realpathSync(base);
      for (const temp of ["/tmp", "/var/tmp", os.tmpdir()]) {
        if (!fs.existsSync(temp)) continue;
        const rel = path.relative(fs.realpathSync(temp), base);
        assert.ok(
          rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel),
          `fixture must be outside temporary roots: ${base}`,
        );
      }
      const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
      cleanup.push(emptyHome);
      const env = { ...process.env, CODEX_HOME: emptyHome };
      t.diagnostic(execFileSync(codex, ["--version"], { env, encoding: "utf8", timeout: 20000 }).trim());
      t.diagnostic(`platform=${process.platform}; fixture=${base}`);

      const main = path.join(base, "main");
      const wt = path.join(base, "wt");
      initRepo(main);
      const cwd = linked ? wt : main;
      const protectedRepos = [];
      if (linked) {
        git(main, ["worktree", "add", "-b", "feat", wt]);
        const sibling = path.join(base, "sibling");
        git(main, ["worktree", "add", "-b", "sibling", sibling]);
        protectedRepos.push(main, sibling);
      }

      fs.writeFileSync(path.join(cwd, "extra.txt"), "extra\n");
      const deniedAdd = sandboxCommand(codex, [], cwd, env, ["git", "add", "extra.txt"]);
      assertDenied(deniedAdd, "baseline git add without writable_roots");
      assert.match(deniedAdd.output, /index\.lock/, "baseline must reach git's index write");

      const roots = writableRootsArgs(cwd);
      assert.ok(roots.length, `expected writable_roots for ${cwd}`);
      t.diagnostic(`writable_roots=${JSON.stringify(codexWorkspaceWritableRoots(cwd))}`);

      // Controls use the very same args as the successful git commands.
      const outside = path.join(base, "outside");
      assertDenied(sandboxCommand(codex, roots, cwd, env, ["touch", outside]), "outside checkout");
      assert.equal(fs.existsSync(outside), false);
      for (const repo of protectedRepos) {
        const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
        const index = path.join(gitDir, "index");
        const before = fs.readFileSync(index);
        fs.writeFileSync(path.join(repo, "forbidden.txt"), "must not be staged\n");
        const denied = sandboxCommand(codex, roots, cwd, env, ["git", "-C", repo, "add", "forbidden.txt"]);
        assertDenied(denied, `protected index ${index}`);
        assert.match(denied.output, /index\.lock/);
        assert.deepEqual(fs.readFileSync(index), before);
        assert.equal(fs.existsSync(`${index}.lock`), false);
      }

      const before = git(cwd, ["rev-parse", "HEAD"]);
      for (const args of [["add", "extra.txt"], ["commit", "-m", "add extra"]]) {
        const result = sandboxCommand(codex, roots, cwd, env, ["git", ...args]);
        assert.equal(result.ok, true, `git ${args[0]} failed:\n${result.output}`);
      }
      assert.notEqual(git(cwd, ["rev-parse", "HEAD"]), before);
      assert.equal(git(cwd, ["show", "HEAD:extra.txt"]), "extra");
      assert.equal(git(cwd, ["status", "--porcelain"]), "");
    });
  }
});
