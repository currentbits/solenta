/**
 * Live #1160 proof: git add/commit inside Codex workspace-write with
 * Solenta writable_roots. Codex carves `.git` / `gitdir:` out as
 * read-only under cwd; listing those paths as writable_roots is what
 * unlocks the index. Skip only when the experiment cannot run.
 *
 * The fixture must NOT live under /tmp: workspace-write already allows
 * /tmp, which would make a tmp worktree a false pass.
 *
 * Run: node --test electron/test/codex-git-sandbox.test.js
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
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

function sandboxGit(codex, extraArgs, cwd, env, gitArgs) {
  try {
    execFileSync(
      codex,
      [
        "sandbox",
        "-c",
        "sandbox_mode=workspace-write",
        ...extraArgs,
        "--",
        "git",
        ...gitArgs,
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
      output: String((err && (err.stderr || err.stdout || err.message)) || ""),
    };
  }
}

function writableRootsArgs(cwd) {
  const args = codexWorkspaceWriteArgs({
    cwd,
    permissionMode: "default",
    allowNetwork: false,
  });
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "-c" && args[i + 1]) pairs.push("-c", args[i + 1]);
  }
  return pairs;
}

describe("live Codex workspace-write git commit (#1160)", () => {
  const cacheRoot =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : path.join(os.homedir(), ".cache");
  /** @type {string[]} */
  const cleanup = [];
  after(() => {
    for (const dir of cleanup) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git add and commit succeed in a linked worktree and a standalone checkout", (t) => {
    const codex = which("codex");
    if (!codex) {
      t.skip("codex CLI not installed");
      return;
    }
    let base;
    try {
      fs.mkdirSync(cacheRoot, { recursive: true });
      base = fs.mkdtempSync(path.join(cacheRoot, "solenta-codex-git-"));
    } catch (err) {
      t.skip(`cannot create cache fixture: ${err && err.message}`);
      return;
    }
    cleanup.push(base);
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    cleanup.push(emptyHome);
    const env = { ...process.env, CODEX_HOME: emptyHome };

    const main = path.join(base, "main");
    const wt = path.join(base, "wt");
    const solo = path.join(base, "solo");
    initRepo(main);
    git(main, ["branch", "feat"]);
    git(main, ["worktree", "add", wt, "feat"]);
    initRepo(solo);

    fs.writeFileSync(path.join(wt, "extra.txt"), "extra\n");
    const deniedAdd = sandboxGit(codex, [], wt, env, ["add", "extra.txt"]);
    if (deniedAdd.ok) {
      t.skip("host Codex sandbox already allows git metadata writes");
      return;
    }
    assert.match(
      deniedAdd.output,
      /index\.lock|not permitted|Read-only/i,
      `expected gitdir deny without writable_roots, got:\n${deniedAdd.output}`,
    );

    const wtRoots = writableRootsArgs(wt);
    assert.ok(wtRoots.length, `expected linked-worktree roots for ${wt}`);
    const wtAdd = sandboxGit(codex, wtRoots, wt, env, ["add", "extra.txt"]);
    assert.equal(wtAdd.ok, true, `linked git add failed:\n${wtAdd.output}`);
    const wtCommit = sandboxGit(codex, wtRoots, wt, env, [
      "commit",
      "-m",
      "add extra",
    ]);
    assert.equal(
      wtCommit.ok,
      true,
      `linked git commit failed:\n${wtCommit.output}`,
    );
    assert.equal(git(wt, ["status", "--porcelain"]), "");

    fs.writeFileSync(path.join(solo, "extra.txt"), "extra\n");
    const soloDenied = sandboxGit(codex, [], solo, env, ["add", "extra.txt"]);
    assert.equal(
      soloDenied.ok,
      false,
      "standalone cwd/.git must still be denied without writable_roots",
    );
    const soloRoots = writableRootsArgs(solo);
    assert.ok(
      soloRoots.length,
      `standalone must emit writable_roots, got ${JSON.stringify(
        codexWorkspaceWritableRoots(solo),
      )}`,
    );
    const soloAdd = sandboxGit(codex, soloRoots, solo, env, [
      "add",
      "extra.txt",
    ]);
    assert.equal(
      soloAdd.ok,
      true,
      `standalone git add failed:\n${soloAdd.output}`,
    );
    const soloCommit = sandboxGit(codex, soloRoots, solo, env, [
      "commit",
      "-m",
      "add extra",
    ]);
    assert.equal(
      soloCommit.ok,
      true,
      `standalone git commit failed:\n${soloCommit.output}`,
    );
    assert.equal(git(solo, ["status", "--porcelain"]), "");
  });
});
