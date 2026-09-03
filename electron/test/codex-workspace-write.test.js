/**
 * Codex workspace-write Planboard network (#848).
 * GitHub-only proxy allowlist, not blanket network_access.
 * Fail closed when gh cannot authenticate inside the sandbox.
 * Run: node --test electron/test/codex-workspace-write.test.js
 */
"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  PLANBOARD_GITHUB_HOSTS,
  codexWorkspaceWriteArgs,
  probeGhAuthInCodexSandbox,
  setCodexGhAuthOkForTests,
  resetCodexGhAuthOkForTests,
} = require("../codexWorkspaceWrite.js");

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
