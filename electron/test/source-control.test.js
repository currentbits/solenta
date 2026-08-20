"use strict";

/**
 * Forge probe (issue #608). Fake CLIs via writeFakeBin — never PATH.
 * node:test files run concurrently, so every call injects bins.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFakeBin } = require("./support/fakeBin.js");
const {
  discoverSourceControl,
  invalidateDiscoveryCache,
  parseCliVersion,
  parseGhAuthText,
  parseGhAuthJson,
  parseGlabAuthText,
  parseAzAccountJson,
  installHintFor,
  versionGte,
  GH_AUTH_JSON_MIN,
} = require("../sourceControl.js");
const { isGhAuthFailure } = require("../worktrees.js");

function missingBin(dir, name) {
  return path.join(dir, name);
}

function writeGh(dir, body) {
  return writeFakeBin(path.join(dir, "fake-gh"), body);
}

const AUTHED_GH = `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version 2.97.0 (2026-07-31)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({
      hosts: {
        "github.com": [{
          state: "success",
          active: true,
          host: "github.com",
          login: "currentbits",
        }],
      },
    }) + "\\n");
    process.exit(0);
  }
  process.stdout.write("github.com\\n  ✓ Logged in to github.com account currentbits (keyring)\\n");
  process.exit(0);
}
process.stderr.write("unexpected " + args.join(" ") + "\\n");
process.exit(2);
`;

const UNAUTH_GH = `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version 2.97.0 (2026-07-31)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ hosts: {} }) + "\\n");
    process.exit(0);
  }
  process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\\n");
  process.exit(1);
}
process.exit(2);
`;

const OLD_AUTHED_GH = `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version 2.40.1 (2024-01-01)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (args.includes("--json")) {
    process.stderr.write("Specify one or more comma-separated fields for --json\\n");
    process.exit(1);
  }
  process.stdout.write("github.com\\n  ✓ Logged in to github.com account olduser (keyring)\\n");
  process.exit(0);
}
process.exit(2);
`;

const OLD_OPAQUE_GH = `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version 2.40.1 (2024-01-01)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.stderr.write("error checking origin status\\n");
  process.exit(1);
}
process.exit(2);
`;

describe("source control discovery parsers", () => {
  it("parses gh version strings", () => {
    const v = parseCliVersion("gh version 2.97.0 (2026-07-31)");
    assert.deepEqual(v && v.parts, [2, 97, 0]);
    assert.equal(versionGte([2, 81, 0], GH_AUTH_JSON_MIN), true);
    assert.equal(versionGte([2, 80, 9], GH_AUTH_JSON_MIN), false);
  });

  it("parses gh auth text and JSON", () => {
    const text = parseGhAuthText(
      "github.com\n  ✓ Logged in to github.com account currentbits (keyring)",
    );
    assert.equal(text && text.status, "authenticated");
    assert.equal(text && text.detail, "currentbits");

    const none = parseGhAuthText(
      "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    );
    assert.equal(none && none.status, "unauthenticated");

    const json = parseGhAuthJson(
      JSON.stringify({
        hosts: {
          "github.com": [
            {
              state: "success",
              active: true,
              host: "github.com",
              login: "currentbits",
            },
          ],
        },
      }),
    );
    assert.equal(json && json.status, "authenticated");
    assert.equal(json && json.detail, "currentbits");
  });

  it("parses glab and az payloads", () => {
    const glab = parseGlabAuthText(
      "gitlab.com\n  ✓ Logged in to gitlab.com as jane (/Users/jane/.config/glab-cli/config.yml)",
    );
    assert.equal(glab && glab.status, "authenticated");
    assert.equal(glab && glab.detail, "jane");

    const az = parseAzAccountJson(
      JSON.stringify({ user: { name: "dev@example.com", type: "user" } }),
    );
    assert.equal(az && az.status, "authenticated");
    assert.equal(az && az.detail, "dev@example.com");
  });

  it("uses platform install hints", () => {
    assert.equal(installHintFor("github", "missing", "darwin"), "brew install gh");
    assert.equal(installHintFor("github", "login", "darwin"), "gh auth login");
    assert.equal(
      installHintFor("github", "outdated", "darwin"),
      "brew upgrade gh",
    );
    assert.equal(
      installHintFor("gitlab", "missing", "darwin"),
      "brew install glab",
    );
  });
});

describe("source control discovery probe", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-sc-"));
    invalidateDiscoveryCache();
  });

  afterEach(() => {
    invalidateDiscoveryCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function emptyBins() {
    return {
      gitlab: missingBin(tmp, "no-glab"),
      azure: missingBin(tmp, "no-az"),
    };
  }

  async function discover(githubBody, over = {}) {
    const github = writeGh(tmp, githubBody);
    return discoverSourceControl({
      bins: { github, ...emptyBins(), ...(over.bins || {}) },
      env: { ...process.env, ...(over.env || {}) },
      platform: "darwin",
      cache: over.cache,
      rescan: over.rescan,
    });
  }

  function byKind(result, kind) {
    return result.sourceControlProviders.find((p) => p.kind === kind);
  }

  it("reports GitHub signed-in-as from auth status JSON", async () => {
    const result = await discover(AUTHED_GH);
    const gh = byKind(result, "github");
    assert.equal(gh.status, "available");
    assert.equal(gh.auth.status, "authenticated");
    assert.equal(gh.auth.detail, "currentbits");
    assert.equal(gh.version, "2.97.0");
  });

  it("reports GitHub unauthenticated with a login hint, not raw stderr", async () => {
    const result = await discover(UNAUTH_GH);
    const gh = byKind(result, "github");
    assert.equal(gh.status, "available");
    assert.equal(gh.auth.status, "unauthenticated");
    assert.match(gh.auth.detail, /Not signed in/);
    assert.equal(gh.installHint, "gh auth login");
  });

  it("keeps an old but logged-in gh as available (text parse)", async () => {
    const result = await discover(OLD_AUTHED_GH);
    const gh = byKind(result, "github");
    assert.equal(gh.status, "available");
    assert.equal(gh.auth.status, "authenticated");
    assert.equal(gh.auth.detail, "olduser");
  });

  it("says upgrade, not auth failed, when old gh cannot report sign-in", async () => {
    const result = await discover(OLD_OPAQUE_GH);
    const gh = byKind(result, "github");
    assert.equal(gh.status, "outdated");
    assert.equal(gh.auth.status, "unknown");
    assert.match(gh.auth.detail, /2\.81\.0/);
    assert.equal(gh.installHint, "brew upgrade gh");
  });

  it("reports missing gh with an install command", async () => {
    const result = await discoverSourceControl({
      bins: {
        github: missingBin(tmp, "no-gh"),
        ...emptyBins(),
      },
      env: { ...process.env },
      platform: "darwin",
    });
    const gh = byKind(result, "github");
    assert.equal(gh.status, "missing");
    assert.equal(gh.installHint, "brew install gh");
    assert.equal(byKind(result, "gitlab").status, "missing");
    assert.equal(byKind(result, "azure-devops").status, "missing");
  });

  it("treats a Bitbucket access token as authenticated", async () => {
    const result = await discoverSourceControl({
      bins: { github: missingBin(tmp, "no-gh"), ...emptyBins() },
      env: { ...process.env, SOLENTA_BITBUCKET_ACCESS_TOKEN: "bb-token" },
      platform: "darwin",
    });
    const bb = byKind(result, "bitbucket");
    assert.equal(bb.auth.status, "authenticated");
    assert.match(bb.auth.detail, /Access token/);
  });

  it("caches until Rescan, and isGhAuthFailure busts the cache", async () => {
    const github = writeGh(tmp, AUTHED_GH);
    const bins = { github, ...emptyBins() };
    const env = { ...process.env };
    const first = await discoverSourceControl({
      bins,
      env,
      platform: "darwin",
      cache: true,
    });
    assert.equal(byKind(first, "github").auth.detail, "currentbits");

    writeGh(tmp, UNAUTH_GH);
    const cached = await discoverSourceControl({
      bins,
      env,
      platform: "darwin",
      cache: true,
    });
    assert.equal(byKind(cached, "github").auth.detail, "currentbits");

    assert.equal(isGhAuthFailure("please run: gh auth login"), true);
    const after = await discoverSourceControl({
      bins,
      env,
      platform: "darwin",
      cache: true,
    });
    assert.equal(byKind(after, "github").auth.status, "unauthenticated");

    writeGh(tmp, AUTHED_GH);
    const rescanned = await discoverSourceControl({
      bins,
      env,
      platform: "darwin",
      cache: true,
      rescan: true,
    });
    assert.equal(byKind(rescanned, "github").auth.detail, "currentbits");
  });
});
