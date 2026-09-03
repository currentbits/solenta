/**
 * Live #848 proof: gh auth / issue list inside the same Codex
 * workspace-write seatbelt Solenta will spawn, with the GitHub-only
 * network_proxy allowlist. Fail closed: if host gh is logged in, the
 * sandbox probe MUST succeed. Skip only when the experiment cannot run.
 *
 * Run: node --test electron/test/codex-gh-sandbox.test.js
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  probeGhAuthInCodexSandbox,
  PLANBOARD_GITHUB_HOSTS,
  planboardGithubProxyDomainsToml,
} = require("../codexWorkspaceWrite.js");

function which(bin) {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function hostGhLoggedIn() {
  try {
    const out = execFileSync("gh", ["auth", "status"], {
      encoding: "utf8",
      timeout: 15000,
    });
    return /Logged in to github.com/i.test(out) && !/token in default is invalid/i.test(out);
  } catch (err) {
    const text = String((err && (err.stdout || err.stderr)) || "");
    return /Logged in to github.com/i.test(text) && !/token in default is invalid/i.test(text);
  }
}

describe("live Codex workspace-write gh auth (#848)", () => {
  it("gh auth status and gh api user succeed with the GitHub-only allowlist", (t) => {
    const codex = which("codex");
    if (!codex) {
      t.skip("codex CLI not installed");
      return;
    }
    if (!which("gh")) {
      t.skip("gh CLI not installed");
      return;
    }
    if (!hostGhLoggedIn()) {
      t.skip("host gh is not logged in; nothing to prove");
      return;
    }

    const auth = probeGhAuthInCodexSandbox({ bin: codex });
    assert.equal(
      auth.ok,
      true,
      `sandbox gh auth failed with host credentials present:\n${auth.output}`,
    );

    const domains = planboardGithubProxyDomainsToml();
    let listed = "";
    try {
      listed = execFileSync(
        codex,
        [
          "sandbox",
          "-c",
          "sandbox_mode=workspace-write",
          "-c",
          "sandbox_workspace_write.network_access=true",
          "-c",
          "features.network_proxy.enabled=true",
          "-c",
          `features.network_proxy.domains=${domains}`,
          "--",
          "gh",
          "api",
          "user",
          "--jq",
          ".login",
        ],
        { encoding: "utf8", timeout: 20000 },
      );
    } catch (err) {
      listed = String((err && (err.stdout || err.stderr || err.message)) || "");
      assert.fail(`sandbox gh api user failed:\n${listed}`);
    }
    assert.match(String(listed).trim(), /^[A-Za-z0-9-]+$/, `unexpected login: ${listed}`);
    assert.deepEqual(PLANBOARD_GITHUB_HOSTS, [
      "api.github.com",
      "github.com",
      "uploads.github.com",
    ]);
  });
});
