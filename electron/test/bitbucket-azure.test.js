"use strict";

/**
 * Bitbucket Cloud and Azure DevOps PR backends (issue #456): remote parsing,
 * prForge dispatch, and create / status / checks / merge against a stubbed
 * fetch (Bitbucket REST) and a fake az that records argv.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bitbucket = require("../bitbucket.js");
const azure = require("../azureDevops.js");
const { prForge, isForgeRemote } = require("../worktrees-pr.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

describe("forge remotes", () => {
  it("parses bitbucket.org https and ssh remotes", () => {
    const want = { workspace: "acme", repo: "demo" };
    assert.deepEqual(bitbucket.parseRemote("git@bitbucket.org:acme/demo.git"), want);
    assert.deepEqual(bitbucket.parseRemote("https://willem@bitbucket.org/acme/demo.git"), want);
    assert.deepEqual(bitbucket.parseRemote("ssh://git@bitbucket.org/acme/demo"), want);
    assert.equal(bitbucket.parseRemote("https://bitbucket.example.com/scm/acme/demo.git"), null);
    assert.equal(bitbucket.parseRemote("https://github.com/acme/demo.git"), null);
  });

  it("parses dev.azure.com, visualstudio.com and ssh v3 remotes", () => {
    assert.deepEqual(azure.parseRemote("https://acme@dev.azure.com/acme/My%20Proj/_git/demo"), {
      orgUrl: "https://dev.azure.com/acme",
      project: "My Proj",
      repo: "demo",
    });
    assert.deepEqual(azure.parseRemote("git@ssh.dev.azure.com:v3/acme/Proj/demo"), {
      orgUrl: "https://dev.azure.com/acme",
      project: "Proj",
      repo: "demo",
    });
    assert.deepEqual(azure.parseRemote("https://acme.visualstudio.com/DefaultCollection/Proj/_git/demo"), {
      orgUrl: "https://acme.visualstudio.com",
      project: "Proj",
      repo: "demo",
    });
    // Short form: project shares the repo's name.
    assert.deepEqual(azure.parseRemote("https://dev.azure.com/acme/_git/demo"), {
      orgUrl: "https://dev.azure.com/acme",
      project: "demo",
      repo: "demo",
    });
    assert.equal(azure.parseRemote("https://dev.azure.com/acme/Proj"), null);
  });

  it("prForge routes each origin to its backend; planboard forges stay GitHub/GitLab", () => {
    assert.equal(prForge("git@bitbucket.org:acme/demo.git").api.kind, "bitbucket");
    assert.equal(prForge("https://dev.azure.com/acme/P/_git/demo").api.kind, "azure-devops");
    assert.equal(prForge("git@gitlab.com:acme/demo.git").api.kind, "gitlab");
    assert.equal(prForge("https://github.com/acme/demo.git"), null);
    // isForgeRemote gates the planboard note: no second planboard (#456).
    assert.equal(isForgeRemote("git@bitbucket.org:acme/demo.git"), false);
  });
});

describe("bitbucket REST backend", () => {
  const remote = { workspace: "acme", repo: "demo" };
  const realFetch = globalThis.fetch;
  const prevEnv = { ...process.env };
  /** @type {{ method: string, url: string, headers: any, body: any }[]} */
  let calls = [];
  /** @type {Record<string, { status?: number, body: unknown }>} keyed "METHOD path" */
  let routes = {};

  const pr = (id, state, extra = {}) => ({
    id,
    state,
    title: `PR ${id}`,
    links: { html: { href: `https://bitbucket.org/acme/demo/pull-requests/${id}` } },
    source: { branch: { name: "feat/x" } },
    destination: { branch: { name: "main" } },
    ...extra,
  });

  before(() => {
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      calls.push({
        method: init.method,
        url: String(url),
        headers: init.headers,
        body: init.body ? JSON.parse(init.body) : null,
      });
      const hit = routes[`${init.method} ${u.pathname}`];
      const status = hit ? hit.status || 200 : 404;
      return new Response(JSON.stringify(hit ? hit.body : { error: { message: "nope" } }), { status });
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
    process.env = prevEnv;
  });
  beforeEach(() => {
    calls = [];
    routes = {};
    delete process.env.SOLENTA_BITBUCKET_ACCESS_TOKEN;
    process.env.SOLENTA_BITBUCKET_EMAIL = "me@acme.dev";
    process.env.SOLENTA_BITBUCKET_API_TOKEN = "tok";
  });

  const base = "/2.0/repositories/acme/demo";

  it("viewPr queries by source branch and prefers the open PR", async () => {
    routes[`GET ${base}/pullrequests`] = { body: { values: [pr(3, "MERGED"), pr(4, "OPEN")] } };
    const info = await bitbucket.viewPr("", remote, "feat/x");
    assert.deepEqual(info, {
      number: 4,
      url: "https://bitbucket.org/acme/demo/pull-requests/4",
      state: "OPEN",
      branch: "feat/x",
      created: false,
      title: "PR 4",
      baseRefName: "main",
    });
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get("q"), 'source.branch.name="feat/x"');
    assert.deepEqual(u.searchParams.getAll("state"), ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from("me@acme.dev:tok").toString("base64")}`);
  });

  it("createPr posts source/destination/draft; access token wins over email", async () => {
    process.env.SOLENTA_BITBUCKET_ACCESS_TOKEN = "atok";
    routes[`POST ${base}/pullrequests`] = { status: 201, body: pr(9, "OPEN") };
    const info = await bitbucket.createPr("", remote, {
      branch: "feat/x", baseBranch: "main", title: "T", body: "B", draft: true,
    });
    assert.equal(info.number, 9);
    assert.equal(info.created, true);
    assert.deepEqual(calls[0].body, {
      title: "T",
      description: "B",
      source: { branch: { name: "feat/x" } },
      destination: { branch: { name: "main" } },
      draft: true,
    });
    assert.equal(calls[0].headers.Authorization, "Bearer atok");
  });

  it("createPr returns the open PR on a create race, else rethrows", async () => {
    routes[`POST ${base}/pullrequests`] = { status: 400, body: { error: { message: "exists" } } };
    routes[`GET ${base}/pullrequests`] = { body: { values: [pr(5, "OPEN")] } };
    const args = { branch: "feat/x", baseBranch: "main", title: "T", body: "", draft: false };
    assert.equal((await bitbucket.createPr("", remote, args)).number, 5);
    routes[`GET ${base}/pullrequests`] = { body: { values: [] } };
    await assert.rejects(bitbucket.createPr("", remote, args), /400 exists/);
  });

  it("prChecks maps commit statuses; mergePr squashes", async () => {
    routes[`GET ${base}/pullrequests`] = { body: { values: [pr(4, "OPEN")] } };
    routes[`GET ${base}/pullrequests/4/statuses`] = {
      body: {
        values: [
          { name: "build", state: "SUCCESSFUL", url: "https://ci/1" },
          { key: "lint", state: "FAILED" },
          { name: "e2e", state: "INPROGRESS" },
          { name: "old", state: "STOPPED" },
        ],
      },
    };
    assert.deepEqual(await bitbucket.prChecks("", remote, "feat/x"), {
      ok: true,
      checks: [
        { name: "build", bucket: "pass", link: "https://ci/1" },
        { name: "lint", bucket: "fail" },
        { name: "e2e", bucket: "pending" },
        { name: "old", bucket: "cancel" },
      ],
    });
    routes[`POST ${base}/pullrequests/4/merge`] = { body: pr(4, "MERGED") };
    await bitbucket.mergePr("", remote, 4);
    assert.deepEqual(calls.at(-1).body, { merge_strategy: "squash" });
  });

  it("no token: a readable error, and the refresher stays silent", async () => {
    delete process.env.SOLENTA_BITBUCKET_EMAIL;
    await assert.rejects(bitbucket.viewPr("", remote, "b"), /SOLENTA_BITBUCKET_ACCESS_TOKEN/);
    assert.equal(await bitbucket.viewPrByNumber("", remote, 4), null);
    assert.equal(calls.length, 0);
  });
});

describe("azure devops az backend", { skip: process.platform === "win32" }, () => {
  const remote = { orgUrl: "https://dev.azure.com/acme", project: "My Proj", repo: "demo" };
  const prevBin = process.env.CODER_AZ_BIN;
  let tmp;
  let callsPath;
  let routesPath;

  const azPr = (id, status, extra = {}) => ({
    pullRequestId: id,
    status,
    title: `PR ${id}`,
    sourceRefName: "refs/heads/feat/x",
    targetRefName: "refs/heads/main",
    mergeStatus: "succeeded",
    ...extra,
  });

  /** Fake az: "repos pr <verb>" (plus "policy list") → canned stdout, or stderr + exit 1. */
  function route(map) {
    fs.writeFileSync(routesPath, JSON.stringify(map));
  }
  function takeCalls() {
    const calls = JSON.parse(fs.readFileSync(callsPath, "utf8"));
    fs.writeFileSync(callsPath, "[]");
    return calls;
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-az-"));
    callsPath = path.join(tmp, "calls.json");
    routesPath = path.join(tmp, "routes.json");
    fs.writeFileSync(callsPath, "[]");
    route({});
    process.env.CODER_AZ_BIN = writeFakeBin(
      path.join(tmp, "az"),
      `const fs = require("fs");
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(${JSON.stringify(callsPath)}, "utf8"));
calls.push(args);
fs.writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesPath)}, "utf8"));
const key = args[2] === "policy" ? "policy list" : args[2];
const hit = routes[key];
if (!hit || hit.err) { process.stderr.write(hit ? hit.err : "ERROR: unknown"); process.exit(1); }
process.stdout.write(JSON.stringify(hit.out));
`,
    );
  });
  after(() => {
    if (prevBin === undefined) delete process.env.CODER_AZ_BIN;
    else process.env.CODER_AZ_BIN = prevBin;
    rmTree(tmp);
  });

  it("viewPr lists by source branch, prefers active, builds the web URL", async () => {
    route({ list: { out: [azPr(3, "completed"), azPr(4, "active", { mergeStatus: "conflicts" })] } });
    const info = await azure.viewPr(tmp, remote, "feat/x");
    assert.deepEqual(info, {
      number: 4,
      url: "https://dev.azure.com/acme/My%20Proj/_git/demo/pullrequest/4",
      state: "OPEN",
      branch: "feat/x",
      created: false,
      title: "PR 4",
      baseRefName: "main",
      mergeable: "CONFLICTING",
    });
    const [call] = takeCalls();
    assert.deepEqual(call, [
      "repos", "pr", "list",
      "--org", "https://dev.azure.com/acme", "--project", "My Proj", "--repository", "demo",
      "--source-branch", "feat/x", "--status", "all", "--top", "20", "-o", "json",
    ]);
  });

  it("createPr passes title/body as --opt=value, truncates past 4000, and sets draft", async () => {
    route({ create: { out: azPr(9, "active") } });
    const body = `- bullet\n${"x".repeat(5000)}`;
    const info = await azure.createPr(tmp, remote, {
      branch: "feat/x", baseBranch: "main", title: "-T", body, draft: true,
    });
    assert.equal(info.number, 9);
    assert.equal(info.created, true);
    const [call] = takeCalls();
    assert.ok(call.includes("--title=-T"));
    const desc = call.find((a) => a.startsWith("--description="));
    assert.equal(desc.length, "--description=".length + 4000);
    assert.ok(desc.startsWith("--description=- bullet\n"));
    assert.deepEqual(call.slice(call.indexOf("--draft"), call.indexOf("--draft") + 2), ["--draft", "true"]);
  });

  it("createPr returns the active PR on TF401179, and classifies auth", async () => {
    route({ create: { err: "TF401179: An active pull request already exists" }, list: { out: [azPr(5, "active")] } });
    const args = { branch: "feat/x", baseBranch: "main", title: "T", body: "", draft: false };
    assert.equal((await azure.createPr(tmp, remote, args)).number, 5);
    route({ create: { err: "ERROR: Please run 'az login' to setup account." }, list: { out: [] } });
    await assert.rejects(azure.createPr(tmp, remote, args), /az login/);
    takeCalls();
  });

  it("prChecks maps policy evaluations; mergePr squash-completes", async () => {
    route({
      list: { out: [azPr(4, "active")] },
      "policy list": {
        out: [
          { status: "approved", configuration: { type: { displayName: "Build" }, settings: { displayName: "CI build" } } },
          { status: "rejected", configuration: { type: { displayName: "Minimum number of reviewers" } } },
          { status: "running", configuration: { type: { displayName: "Status check" } } },
          { status: "notApplicable", configuration: { type: { displayName: "Comment requirements" } } },
        ],
      },
      update: { out: azPr(4, "completed") },
    });
    assert.deepEqual(await azure.prChecks(tmp, remote, "feat/x"), {
      ok: true,
      checks: [
        { name: "CI build", bucket: "pass" },
        { name: "Minimum number of reviewers", bucket: "fail" },
        { name: "Status check", bucket: "pending" },
        { name: "Comment requirements", bucket: "skipping" },
      ],
    });
    takeCalls();
    await azure.mergePr(tmp, remote, 4);
    assert.deepEqual(takeCalls()[0], [
      "repos", "pr", "update", "--id", "4", "--org", "https://dev.azure.com/acme",
      "--status", "completed", "--squash", "true", "-o", "json",
    ]);
  });
});
