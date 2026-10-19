"use strict";

/**
 * Publish a checkout with no origin (issue #456): fake gh / glab / az that
 * record argv, a stubbed fetch for Bitbucket, and a local bare repo standing
 * in for the forge (url.insteadOf), so the real `git push` is exercised.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { publishRepo } = require("../publish.js");
const { gitRepoInfo } = require("../services-git.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Fake CLI: appends argv to $CODER_FAKE_PUBLISH_LOG, then runs `body`. */
function fakeCli(dir, name, body) {
  return writeFakeBin(
    path.join(dir, name),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CODER_FAKE_PUBLISH_LOG, JSON.stringify(args) + "\\n");
${body}
`,
  );
}

describe("publishRepo", { skip: process.platform === "win32" }, () => {
  let tmp;
  let repo;
  let bare;
  let log;
  let store;
  const prevEnv = { ...process.env };
  const realFetch = globalThis.fetch;

  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const run = (input) => publishRepo({ store, threadId: "t1", ...input });
  /** Route pushes for `url` to the local bare repo. */
  const routeTo = (url) => git(repo, ["config", `url.${bare}.insteadOf`, url]);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-publish-"));
    repo = path.join(tmp, "demo");
    bare = path.join(tmp, "forge.git");
    log = path.join(tmp, "calls.jsonl");
    fs.mkdirSync(repo);
    git(tmp, ["init", "--bare", "-q", bare]);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "T"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    const thread = { id: "t1", projectId: "p1" };
    const project = { id: "p1", path: repo };
    store = { getThread: (id) => (id === "t1" ? thread : null), getProject: () => project };
    process.env.CODER_FAKE_PUBLISH_LOG = log;
    delete process.env.CODER_GUARDRAILS;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
    globalThis.fetch = realFetch;
    rmTree(tmp);
  });

  it("gitRepoInfo flags a repo with no origin so the header offers Publish", async () => {
    assert.deepEqual(await gitRepoInfo(repo), { ok: false, noOrigin: true });
    git(repo, ["remote", "add", "origin", "not a url"]);
    assert.deepEqual(await gitRepoInfo(repo), { ok: false });
  });

  it("GitHub: gh repo create --source . --push adds origin and pushes", async () => {
    process.env.CODER_GH_BIN = fakeCli(
      tmp,
      "gh",
      `execFileSync("git", ["remote", "add", "origin", ${JSON.stringify(bare)}]);
execFileSync("git", ["push", "-q", "-u", "origin", "HEAD"]);
process.stdout.write("https://github.com/acme/demo\\n");`,
    );
    const out = await run({ forge: "github", name: "acme/demo", visibility: "private" });
    assert.deepEqual(out, { forge: "github", webUrl: "https://github.com/acme/demo", branch: "main" });
    assert.deepEqual(calls(), [
      ["repo", "create", "acme/demo", "--source", ".", "--remote", "origin", "--push", "--private"],
    ]);
    assert.equal(git(bare, ["rev-parse", "main"]), git(repo, ["rev-parse", "HEAD"]));
  });

  it("GitLab: glab repo create, then Solenta adds origin from the printed URL and pushes", async () => {
    process.env.CODER_GLAB_BIN = fakeCli(
      tmp,
      "glab",
      `process.stdout.write("✓ Created repository acme / demo on GitLab: https://gitlab.com/acme/demo\\n");`,
    );
    routeTo("https://gitlab.com/acme/demo.git");
    const out = await run({ forge: "gitlab", name: "demo", visibility: "public" });
    assert.equal(out.webUrl, "https://gitlab.com/acme/demo");
    assert.deepEqual(calls(), [["repo", "create", "demo", "--public"]]);
    assert.equal(git(repo, ["config", "remote.origin.url"]), "https://gitlab.com/acme/demo.git");
    assert.equal(git(bare, ["rev-parse", "main"]), git(repo, ["rev-parse", "HEAD"]));
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main");
  });

  it("Azure DevOps: az repos create, remote add origin <remoteUrl>, push", async () => {
    const remoteUrl = "https://acme@dev.azure.com/acme/My%20Proj/_git/demo";
    process.env.CODER_AZ_BIN = fakeCli(
      tmp,
      "az",
      `process.stdout.write(JSON.stringify({ remoteUrl: ${JSON.stringify(remoteUrl)}, webUrl: "https://dev.azure.com/acme/My%20Proj/_git/demo" }));`,
    );
    routeTo(remoteUrl);
    const out = await run({ forge: "azure-devops", name: "demo", visibility: "private", org: "acme", project: "My Proj" });
    assert.equal(out.webUrl, "https://dev.azure.com/acme/My%20Proj/_git/demo");
    assert.deepEqual(calls(), [
      ["repos", "create", "--name=demo", "--project=My Proj", "--org", "https://dev.azure.com/acme", "-o", "json"],
    ]);
    assert.equal(git(repo, ["config", "remote.origin.url"]), remoteUrl);
    assert.equal(git(bare, ["rev-parse", "main"]), git(repo, ["rev-parse", "HEAD"]));
  });

  it("Bitbucket: POST /repositories/{ws}/{slug} with the token, then push the https clone URL", async () => {
    process.env.SOLENTA_BITBUCKET_ACCESS_TOKEN = "bb-token";
    const cloneUrl = "https://x@bitbucket.org/acme/demo.git";
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      const body = {
        links: {
          html: { href: "https://bitbucket.org/acme/demo" },
          clone: [
            { name: "https", href: cloneUrl },
            { name: "ssh", href: "git@bitbucket.org:acme/demo.git" },
          ],
        },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    routeTo(cloneUrl);
    const out = await run({ forge: "bitbucket", name: "Demo", visibility: "private", workspace: "acme" });
    assert.equal(out.webUrl, "https://bitbucket.org/acme/demo");
    assert.deepEqual(seen, [
      {
        url: "https://api.bitbucket.org/2.0/repositories/acme/demo",
        method: "POST",
        auth: "Bearer bb-token",
        body: { scm: "git", is_private: true },
      },
    ]);
    assert.equal(git(bare, ["rev-parse", "main"]), git(repo, ["rev-parse", "HEAD"]));
  });

  it("secret-scans the whole history: a key deleted in a later commit still blocks, before any forge call", async () => {
    fs.writeFileSync(path.join(repo, "creds.txt"), "aws=AKIAIOSFODNN7EXAMPLE\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "oops"]);
    fs.rmSync(path.join(repo, "creds.txt"));
    git(repo, ["commit", "-qam", "remove creds"]);
    // An unrelated tip commit: a HEAD~1..HEAD scan would see neither side of the key.
    fs.writeFileSync(path.join(repo, "README.md"), "hi again\n");
    git(repo, ["commit", "-qam", "docs"]);
    process.env.CODER_GH_BIN = fakeCli(tmp, "gh", "");
    await assert.rejects(run({ forge: "github", name: "demo", visibility: "private" }), /Blocked by Solenta guardrails/);
    assert.deepEqual(calls(), []);
  });

  it("refuses an existing origin, a flag-shaped name, and missing Azure/Bitbucket fields", async () => {
    process.env.CODER_GH_BIN = fakeCli(tmp, "gh", "");
    await assert.rejects(run({ forge: "github", name: "--evil", visibility: "private" }), /Invalid repository name/);
    await assert.rejects(run({ forge: "azure-devops", name: "demo", org: "acme" }), /project is required/);
    await assert.rejects(run({ forge: "bitbucket", name: "demo" }), /Invalid Bitbucket workspace/);
    git(repo, ["remote", "add", "origin", bare]);
    await assert.rejects(run({ forge: "github", name: "demo" }), /already has an origin/);
    assert.deepEqual(calls(), []);
  });

  it("names the created repo when the follow-up push fails", async () => {
    process.env.CODER_GLAB_BIN = fakeCli(
      tmp,
      "glab",
      `process.stdout.write("Created repository on GitLab: https://gitlab.invalid/acme/demo\\n");`,
    );
    await assert.rejects(
      run({ forge: "gitlab", name: "demo", visibility: "private" }),
      /Created https:\/\/gitlab\.invalid\/acme\/demo, but the push failed/,
    );
    // origin stays, so the header's plain Push can retry.
    assert.equal(git(repo, ["config", "remote.origin.url"]), "https://gitlab.invalid/acme/demo.git");
  });
});
