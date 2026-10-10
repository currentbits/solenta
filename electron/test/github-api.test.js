"use strict";

/**
 * GitHub API transport (#1528): remote parsing, endpoint choice, batching,
 * token cache, and the refresher's one-request-per-repo path with gh fallback.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const github = require("../github.js");
const { writeFakeBin } = require("./support/fakeBin.js");

describe("github.parseRemote", () => {
  it("handles https, ssh, scp, GHE, and rejects local paths", () => {
    assert.deepEqual(github.parseRemote("https://github.com/acme/app.git"), {
      host: "github.com", owner: "acme", repo: "app",
    });
    assert.deepEqual(github.parseRemote("git@github.com:acme/app.git"), {
      host: "github.com", owner: "acme", repo: "app",
    });
    assert.deepEqual(github.parseRemote("ssh://git@ssh.github.com:443/acme/app"), {
      host: "github.com", owner: "acme", repo: "app",
    });
    assert.deepEqual(github.parseRemote("https://GHE.corp.example/team/svc/"), {
      host: "ghe.corp.example", owner: "team", repo: "svc",
    });
    assert.equal(github.parseRemote("/srv/git/app.git"), null);
    assert.equal(github.parseRemote("C:\\repos\\app"), null);
    assert.equal(github.parseRemote(""), null);
  });

  it("picks api.github.com for github.com and /api/graphql for GHE", () => {
    assert.equal(github.graphqlUrl("github.com"), "https://api.github.com/graphql");
    assert.equal(github.graphqlUrl("ghe.corp.example"), "https://ghe.corp.example/api/graphql");
  });
});

describe("github.fetchPrStates", () => {
  const remote = { host: "github.com", owner: "acme", repo: "app" };

  it("asks for every PR in one aliased query and skips unresolvable ones", async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            repository: {
              p1: { number: 1, url: "https://github.com/acme/app/pull/1", state: "MERGED" },
              p2: null,
            },
          },
          errors: [{ type: "NOT_FOUND", path: ["repository", "p2"] }],
        }),
      };
    };
    const got = await github.fetchPrStates(remote, [1, 2, 1], { token: "t0k", fetchFn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, "bearer t0k");
    assert.match(calls[0].body.query, /p1: pullRequest\(number: 1\)/);
    assert.match(calls[0].body.query, /p2: pullRequest\(number: 2\)/);
    assert.deepEqual(calls[0].body.variables, { owner: "acme", name: "app" });
    assert.deepEqual([...got.keys()], [1]);
    assert.equal(got.get(1).state, "MERGED");
  });

  it("chunks past PR_BATCH", async () => {
    let n = 0;
    const fetchFn = async () => {
      n += 1;
      return { ok: true, status: 200, json: async () => ({ data: { repository: {} } }) };
    };
    const nums = Array.from({ length: github.PR_BATCH + 1 }, (_, i) => i + 1);
    await github.fetchPrStates(remote, nums, { token: "t", fetchFn });
    assert.equal(n, 2);
  });

  it("throws without a token and on HTTP failure, so callers fall back to gh", async () => {
    await assert.rejects(github.fetchPrStates(remote, [1], { token: null }), /No GitHub token/);
    const fetchFn = async () => ({ ok: false, status: 502, json: async () => ({}) });
    await assert.rejects(
      github.fetchPrStates(remote, [1], { token: "t", fetchFn }),
      (err) => err.status === 502,
    );
  });
});

describe("github.githubToken", () => {
  let dir;
  afterEach(() => {
    github.forgetToken();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs gh auth token --hostname once per host and caches misses too", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-token-"));
    const log = path.join(dir, "calls.log");
    const bin = writeFakeBin(
      path.join(dir, "fake-gh-token"),
      `const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[3] === "github.com") { process.stdout.write("gho_abc\\n"); process.exit(0); }
process.exit(1);
`,
    );
    assert.equal(await github.githubToken("github.com", { ghBin: bin, timeoutMs: 60_000 }), "gho_abc");
    assert.equal(await github.githubToken("github.com", { ghBin: bin, timeoutMs: 60_000 }), "gho_abc");
    assert.equal(await github.githubToken("gitlab.com", { ghBin: bin, timeoutMs: 60_000 }), null);
    assert.equal(await github.githubToken("gitlab.com", { ghBin: bin, timeoutMs: 60_000 }), null);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(lines, ["auth token --hostname github.com", "auth token --hostname gitlab.com"]);
  });
});

describe("github.ghPr (#1534)", () => {
  const { fakeGithubApi } = require("./support/fakeGithubApi.js");
  const remote = { host: "github.com", owner: "acme", repo: "demo" };
  const pr = { number: 5, url: "https://github.com/acme/demo/pull/5", headRefName: "feat/x" };

  it("uses /api/v3 for GHE REST and api.github.com for github.com", async () => {
    assert.equal(github.restUrl("github.com"), "https://api.github.com");
    assert.equal(github.restUrl("ghe.corp.example"), "https://ghe.corp.example/api/v3");
    const api = fakeGithubApi({ prs: [pr] });
    await github.ghPr({ ...remote, host: "ghe.corp.example" }, ["pr", "close", "5"], { token: "t", fetchFn: api.fetchFn });
    assert.equal(api.state.calls[0].url, "https://ghe.corp.example/api/v3/repos/acme/demo/pulls/5");
    assert.equal(api.state.prs[0].state, "CLOSED");
  });

  it("tags a missing PR notFound with gh's wording, but not a missing repo", async () => {
    const api = fakeGithubApi({ prs: [] });
    await assert.rejects(
      github.ghPr(remote, ["pr", "view", "feat/x", "--json", "number"], { token: "t", fetchFn: api.fetchFn }),
      (err) => err.notFound === true && /no pull requests found for branch "feat\/x"/.test(err.message),
    );
    const noRepo = async () => ({ ok: true, status: 200, json: async () => ({ data: { repository: null } }) });
    await assert.rejects(
      github.ghPr(remote, ["pr", "view", "5", "--json", "number"], { token: "t", fetchFn: noRepo }),
      (err) => !err.notFound && /not found on github.com/.test(err.message),
    );
  });

  it("surfaces GitHub's message and status on a failed write", async () => {
    const api = fakeGithubApi({ prs: [{ ...pr, state: "CLOSED" }] });
    await assert.rejects(
      github.ghPr(remote, ["pr", "merge", "5", "--squash"], { token: "t", fetchFn: api.fetchFn }),
      (err) => err.status === 405 && /not mergeable/.test(err.message),
    );
  });

  it("throws on GraphQL mutation errors instead of reporting success", async () => {
    let n = 0;
    const fetchFn = async () => {
      n += 1;
      const body = n === 1
        ? { data: { repository: { pullRequest: { id: "PR_5", ...pr } } } }
        : { data: { markPullRequestReadyForReview: null }, errors: [{ message: "not permitted" }] };
      return { ok: true, status: 200, json: async () => body };
    };
    await assert.rejects(github.ghPr(remote, ["pr", "ready", "5"], { token: "t", fetchFn }), /not permitted/);
  });

  it("rejects argv it does not translate so the caller runs gh", async () => {
    for (const args of [["pr", "checkout", "5"], ["pr", "merge", "5", "--rebase"], ["pr", "diff", "5"]]) {
      await assert.rejects(
        github.ghPr(remote, args, { token: "t", fetchFn: async () => assert.fail("no request") }),
        (err) => err instanceof github.Unsupported,
      );
    }
  });
});

describe("per-host GitHub settings (#1528 / #1533)", () => {
  const { Store } = require("../store.js");
  const { redactSettings } = require("../mcp.js");
  const { parseGhAccounts } = require("../sourceControl.js");
  let dir;
  afterEach(() => {
    github.setHostSettings(null);
    github.forgetToken();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("store validates, dedupes, and keeps a saved token when a row omits it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-hosts-"));
    const store = new Store(path.join(dir, "store.json"));
    assert.deepEqual(store.getSettings().githubHosts, []);
    store.setSettings({
      githubHosts: [
        { host: "GitHub.com", account: "me", token: "ghp_1" },
        { host: "ghe.corp.example", account: null, token: null },
      ],
    });
    // The empty GHE row is dropped; host is lowercased.
    assert.deepEqual(store.getSettings().githubHosts, [
      { host: "github.com", account: "me", token: "ghp_1" },
    ]);
    // Round-tripping the redacted shape keeps the token.
    const shown = redactSettings(store.getSettings()).githubHosts;
    assert.deepEqual(shown, [{ host: "github.com", account: "me", hasToken: true }]);
    store.setSettings({ githubHosts: [{ ...shown[0], account: "work" }] });
    assert.deepEqual(store.getSettings().githubHosts, [
      { host: "github.com", account: "work", token: "ghp_1" },
    ]);
    store.setSettings({ githubHosts: [{ host: "github.com", account: "work", token: null }] });
    assert.deepEqual(store.getSettings().githubHosts, [
      { host: "github.com", account: "work", token: null },
    ]);
    assert.throws(() => store.setSettings({ githubHosts: [{ host: "not a host", token: "x" }] }), /hostname/);
    assert.throws(() => store.setSettings({ githubHosts: "nope" }), /array/);
  });

  it("githubToken: saved token beats gh; chosen account adds --user", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-hosts-"));
    const log = path.join(dir, "calls.log");
    const bin = writeFakeBin(
      path.join(dir, "fake-gh-user"),
      `const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
process.stdout.write(args.includes("--user") ? "gho_work\\n" : "gho_default\\n");
`,
    );
    const opts = { ghBin: bin, timeoutMs: 60_000 };
    let rows = [{ host: "ghe.corp.example", account: null, token: "ghp_saved" }];
    github.setHostSettings(() => rows);
    assert.equal(await github.githubToken("ghe.corp.example", opts), "ghp_saved");
    assert.equal(await github.githubToken("github.com", opts), "gho_default");
    rows = [{ host: "github.com", account: "work", token: null }];
    assert.equal(await github.githubToken("github.com", opts), "gho_work");
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(lines, [
      "auth token --hostname github.com",
      "auth token --hostname github.com --user work",
    ]);
  });

  it("parseGhAccounts lists signed-in logins per host", () => {
    const out = parseGhAccounts(JSON.stringify({
      hosts: {
        "github.com": [
          { state: "success", active: true, host: "github.com", login: "me" },
          { state: "success", active: false, host: "github.com", login: "work" },
          { state: "error", active: false, host: "github.com", login: "expired" },
        ],
        "ghe.corp.example": [{ state: "success", active: true, login: "corp" }],
      },
    }));
    assert.deepEqual(out, [
      { host: "github.com", login: "me", active: true },
      { host: "github.com", login: "work", active: false },
      { host: "ghe.corp.example", login: "corp", active: true },
    ]);
    assert.deepEqual(parseGhAccounts("not json"), []);
  });
});

describe("join: Settings token drives interactive PR ops (#1533 × #1534)", () => {
  const { execFileSync } = require("node:child_process");
  const { ghApiTryAsync, setGithubApi } = require("../worktrees.js");
  const { fakeGithubApi } = require("./support/fakeGithubApi.js");
  let dir;
  afterEach(() => {
    setGithubApi(null);
    github.setHostSettings(null);
    github.forgetToken();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("ghApiTryAsync authenticates with the token saved for the origin's host", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-join-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], { cwd: dir });
    const fake = fakeGithubApi({
      prs: [{ number: 5, url: "https://github.com/acme/demo/pull/5", headRefName: "feat/x" }],
    });
    const auth = [];
    // No tokenFn: the real githubToken must resolve it from Settings.
    setGithubApi({
      fetchFn: async (url, init) => {
        auth.push(init.headers.Authorization);
        return fake.fetchFn(url, init);
      },
    });
    github.setHostSettings(() => [{ host: "github.com", account: null, token: "ghp_from_settings" }]);
    const out = await ghApiTryAsync(dir, ["pr", "view", "5", "--json", "number,url,state"]);
    assert.equal(out.ok, true, out.stderr);
    assert.equal(JSON.parse(out.stdout).number, 5);
    assert.ok(auth.length > 0);
    assert.ok(auth.every((a) => /ghp_from_settings$/.test(a)), auth.join(","));
  });

  it("ghApiTryAsync takes opts.originUrl when cwd is no checkout (ssh remote, #180)", async () => {
    const fake = fakeGithubApi({
      prs: [{ number: 5, url: "https://github.com/acme/remote/pull/5", headRefName: "feat/x" }],
    });
    const urls = [];
    setGithubApi({
      fetchFn: async (url, init) => {
        urls.push(`${url} ${init && init.body ? init.body : ""}`);
        return fake.fetchFn(url, init);
      },
      tokenFn: async () => "ghp_test",
    });
    const out = await ghApiTryAsync(os.tmpdir(), ["pr", "view", "5", "--json", "number,url,state"], {
      originUrl: "git@github.com:acme/remote.git",
    });
    assert.equal(out.ok, true, out.stderr);
    assert.equal(JSON.parse(out.stdout).number, 5);
    assert.ok(urls.some((u) => /acme\/remote|"owner":"acme","name":"remote"|"repo":"remote"/.test(u)), urls.join(","));
  });
});
