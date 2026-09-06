/**
 * Codex workspace-write extras for linked worktrees (#847) and
 * Planboard GitHub network (#848). GitHub-only proxy allowlist, not
 * blanket network_access. Fail closed when gh cannot authenticate
 * inside the sandbox.
 * Run: node --test electron/test/codex-workspace-write.test.js
 */
"use strict";

const { describe, it, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  PLANBOARD_GITHUB_HOSTS,
  codexWorkspaceWritableRoots,
  codexWorkspaceWriteArgs,
  probeGhAuthInCodexSandbox,
  setCodexGhAuthOkForTests,
  resetCodexGhAuthOkForTests,
} = require("../codexWorkspaceWrite.js");

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

function absGit(cwd, flag) {
  return fs.realpathSync(
    path.resolve(
      git(cwd, ["rev-parse", "--path-format=absolute", flag]),
    ),
  );
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function writableRootsArg(args) {
  return args.find((a) =>
    String(a).startsWith("sandbox_workspace_write.writable_roots="),
  );
}

function domainsArg(args) {
  return args.find((a) => String(a).startsWith("features.network_proxy.domains="));
}

function assertGithubAllowlist(args) {
  assert.ok(
    args.includes("features.network_proxy.enabled=true"),
    `missing network_proxy enable in ${JSON.stringify(args)}`,
  );
  const domains = domainsArg(args);
  assert.ok(domains, `missing proxy domains in ${JSON.stringify(args)}`);
  for (const host of PLANBOARD_GITHUB_HOSTS) {
    assert.ok(
      domains.includes(`"${host}" = "allow"`) ||
        domains.includes(`"${host}"="allow"`),
      `missing allow ${host} in ${domains}`,
    );
  }
  assert.ok(!domains.includes('"*"'), `wildcard allow is not GitHub-only: ${domains}`);
}

describe("codexWorkspaceWritableRoots (#847)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-wt-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("is a function", () => {
    assert.equal(typeof codexWorkspaceWritableRoots, "function");
  });

  it("is empty for a standalone checkout whose .git lives in cwd", () => {
    const repo = path.join(tmp, "solo");
    initRepo(repo);
    assert.deepEqual(codexWorkspaceWritableRoots(repo), []);
  });

  it("is empty when cwd is missing", () => {
    assert.deepEqual(codexWorkspaceWritableRoots(""), []);
    assert.deepEqual(codexWorkspaceWritableRoots(null), []);
    assert.deepEqual(codexWorkspaceWritableRoots(undefined), []);
  });

  it("adds this worktree's gitdir plus shared objects/refs/logs, not a sibling", () => {
    const repo = path.join(tmp, "main");
    initRepo(repo);
    const wtA = path.join(tmp, "wt-a");
    const wtB = path.join(tmp, "wt-b");
    git(repo, ["branch", "feat-a"]);
    git(repo, ["branch", "feat-b"]);
    git(repo, ["worktree", "add", wtA, "feat-a"]);
    git(repo, ["worktree", "add", wtB, "feat-b"]);

    const gitDirA = absGit(wtA, "--git-dir");
    const gitDirB = absGit(wtB, "--git-dir");
    const common = absGit(wtA, "--git-common-dir");

    const roots = codexWorkspaceWritableRoots(wtA);
    assert.ok(
      roots.includes(gitDirA),
      `expected this worktree gitdir ${gitDirA}, got ${JSON.stringify(roots)}`,
    );
    assert.ok(
      !roots.includes(gitDirB),
      `must not grant sibling gitdir ${gitDirB}, got ${JSON.stringify(roots)}`,
    );
    assert.ok(
      !isInside(fs.realpathSync(wtA), gitDirA),
      "fixture must be a linked worktree (gitdir outside cwd)",
    );
    for (const sub of ["objects", "refs", "logs"]) {
      const p = path.join(common, sub);
      assert.ok(
        roots.includes(p),
        `expected ${p} in ${JSON.stringify(roots)}`,
      );
    }
    assert.ok(
      !roots.includes(common),
      "must not grant the whole common dir (other worktrees live there)",
    );
  });
});

describe("codexWorkspaceWriteArgs (#847)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-args-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  afterEach(() => resetCodexGhAuthOkForTests());

  it("emits writable_roots for a linked worktree under workspace-write without network", () => {
    const repo = path.join(tmp, "main");
    initRepo(repo);
    const wt = path.join(tmp, "wt");
    git(repo, ["branch", "feat"]);
    git(repo, ["worktree", "add", wt, "feat"]);
    const gitDir = absGit(wt, "--git-dir");
    setCodexGhAuthOkForTests(false);
    const args = codexWorkspaceWriteArgs({
      cwd: wt,
      permissionMode: "default",
      allowNetwork: false,
    });
    const value = writableRootsArg(args);
    assert.ok(value, `expected writable_roots, got ${JSON.stringify(args)}`);
    const escaped = gitDir.replace(/\\/g, "\\\\");
    assert.ok(
      value.includes(`"${escaped}"`) || value.includes(`"${gitDir}"`),
      `expected gitdir in ${value}`,
    );
    assert.ok(
      !args.includes("sandbox_workspace_write.network_access=true"),
      `network_access must stay off without Planboard, got ${JSON.stringify(args)}`,
    );
    assert.ok(
      !args.some((a) => String(a).startsWith("features.network_proxy.")),
      `GitHub proxy must stay off without Planboard, got ${JSON.stringify(args)}`,
    );
  });

  it("is empty in plan and bypassPermissions even for a linked worktree", () => {
    const repo = path.join(tmp, "solo-modes");
    initRepo(repo);
    const wt = path.join(tmp, "wt-modes");
    git(repo, ["branch", "feat-modes"]);
    git(repo, ["worktree", "add", wt, "feat-modes"]);
    setCodexGhAuthOkForTests(true);
    assert.deepEqual(
      codexWorkspaceWriteArgs({
        cwd: wt,
        permissionMode: "plan",
        allowNetwork: true,
      }),
      [],
    );
    assert.deepEqual(
      codexWorkspaceWriteArgs({
        cwd: wt,
        permissionMode: "bypassPermissions",
        allowNetwork: true,
      }),
      [],
    );
  });

  it("combines writable_roots with the GitHub-only proxy when both apply", () => {
    const repo = path.join(tmp, "combo");
    initRepo(repo);
    const wt = path.join(tmp, "wt-combo");
    git(repo, ["branch", "feat-combo"]);
    git(repo, ["worktree", "add", wt, "feat-combo"]);
    const gitDir = absGit(wt, "--git-dir");
    setCodexGhAuthOkForTests(true);
    const args = codexWorkspaceWriteArgs({
      cwd: wt,
      permissionMode: "acceptEdits",
      allowNetwork: true,
    });
    const value = writableRootsArg(args);
    assert.ok(value, `expected writable_roots, got ${JSON.stringify(args)}`);
    assert.ok(
      value.includes(`"${gitDir.replace(/\\/g, "\\\\")}"`) ||
        value.includes(`"${gitDir}"`),
      `expected gitdir in ${value}`,
    );
    assert.ok(
      args.includes("sandbox_workspace_write.network_access=true"),
      JSON.stringify(args),
    );
    assert.ok(
      args.includes("features.network_proxy.enabled=true"),
      JSON.stringify(args),
    );
  });
});

describe("codexWorkspaceWriteArgs (#848)", () => {
  afterEach(() => resetCodexGhAuthOkForTests());

  it("is empty in plan and bypassPermissions even when Planboard wants GitHub", () => {
    setCodexGhAuthOkForTests(true);
    assert.deepEqual(
      codexWorkspaceWriteArgs({
        permissionMode: "plan",
        allowNetwork: true,
      }),
      [],
    );
    assert.deepEqual(
      codexWorkspaceWriteArgs({
        permissionMode: "bypassPermissions",
        allowNetwork: true,
      }),
      [],
    );
  });

  it("is empty when Planboard is not injecting GitHub work", () => {
    setCodexGhAuthOkForTests(true);
    assert.deepEqual(
      codexWorkspaceWriteArgs({
        permissionMode: "default",
        allowNetwork: false,
      }),
      [],
    );
    assert.deepEqual(
      codexWorkspaceWriteArgs({
        permissionMode: "acceptEdits",
      }),
      [],
    );
  });

  it("allowlists GitHub hosts instead of blanket network_access (#848)", () => {
    setCodexGhAuthOkForTests(true);
    const args = codexWorkspaceWriteArgs({
      permissionMode: "acceptEdits",
      allowNetwork: true,
    });
    assertGithubAllowlist(args);
    assert.equal(args[0], "-c");
    assert.ok(
      args.some((a) => String(a).startsWith("features.network_proxy.domains=")),
      `expected allowlist -c, got ${JSON.stringify(args)}`,
    );
    assert.deepEqual(PLANBOARD_GITHUB_HOSTS, [
      "api.github.com",
      "github.com",
      "uploads.github.com",
    ]);
  });

  it("emits no flags when gh cannot authenticate inside the sandbox", () => {
    setCodexGhAuthOkForTests(false);
    assert.deepEqual(
      codexWorkspaceWriteArgs({
        permissionMode: "default",
        allowNetwork: true,
      }),
      [],
    );
  });
});

describe("probeGhAuthInCodexSandbox", () => {
  it("fails closed on 'token in default is invalid' even when the process exits 0", () => {
    const r = probeGhAuthInCodexSandbox({
      bin: "/usr/bin/codex",
      execFileSync: () =>
        "github.com\n  X Failed to log in to github.com account x (default)\n  - The token in default is invalid.\n",
    });
    assert.equal(r.ok, false);
  });

  it("succeeds only when gh reports a keyring/host login", () => {
    const r = probeGhAuthInCodexSandbox({
      bin: "/usr/bin/codex",
      execFileSync: () =>
        "github.com\n  ✓ Logged in to github.com account currentbits (keyring)\n",
    });
    assert.equal(r.ok, true);
  });

  it("fails closed when the sandbox spawn throws", () => {
    const r = probeGhAuthInCodexSandbox({
      bin: "/usr/bin/codex",
      execFileSync: () => {
        const err = new Error("spawn failed");
        err.stderr = "codex: not found";
        throw err;
      },
    });
    assert.equal(r.ok, false);
  });
});
