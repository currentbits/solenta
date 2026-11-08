"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const gitlab = require("../gitlab.js");
const issues = require("../issues.js");
const { prForge, isForgeRemote } = require("../worktrees-pr.js");
const { repoInfoFromRemote } = require("../services-git.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const envKeys = [
  "GLAB_CONFIG_DIR", "CODER_GLAB_BIN", "GITLAB_HOST", "GITLAB_URI", "GL_HOST",
  "GITLAB_URL", "GITLAB_API_HOST", "GLAB_API_PROTOCOL", "API_PROTOCOL", "GITLAB_REPO",
  "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN", "GITLAB_CI",
  "JOB_TOKEN", "GLAB_IS_OAUTH2", "OAUTH2_REFRESH_TOKEN", "REFRESH_TOKEN",
  "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS",
];

describe("GitLab origin routing with isolated config", () => {
  let tmp;
  let previous;

  beforeEach(() => {
    previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-gitlab-origin-"));
    process.env.GLAB_CONFIG_DIR = tmp;
  });

  afterEach(() => {
    mock.restoreAll();
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    return rmTree(tmp);
  });

  function configure(text) {
    fs.writeFileSync(path.join(tmp, "config.yml"), text);
  }

  function discoveryConfig(dir, host) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), `hosts:\n    ${host}:\n        api_protocol: http\n`);
  }

  function discoveryHome() {
    const home = path.join(tmp, "home");
    mock.method(os, "homedir", () => home);
    delete process.env.GLAB_CONFIG_DIR;
    process.env.XDG_CONFIG_DIRS = path.join(tmp, "system");
    return home;
  }

  it("discovers the macOS Application Support config", { skip: process.platform !== "darwin" }, () => {
    const home = discoveryHome();
    discoveryConfig(path.join(home, "Library", "Application Support", "glab-cli"), "code.example:8080");
    assert.equal(gitlab.gitlabRemote("git@code.example:group/repo.git")?.origin, "http://code.example:8080");
  });

  it("falls back to the macOS Preferences config search path", { skip: process.platform !== "darwin" }, () => {
    const home = discoveryHome();
    process.env.XDG_CONFIG_DIRS = "relative-path-is-ignored";
    discoveryConfig(path.join(home, "Library", "Preferences", "glab-cli"), "preferences.example:8080");
    assert.equal(gitlab.gitlabRemote("git@preferences.example:group/repo.git")?.origin, "http://preferences.example:8080");
  });

  it("prefers the legacy config over XDG_CONFIG_HOME, just like glab", () => {
    const home = discoveryHome();
    process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
    discoveryConfig(path.join(home, ".config", "glab-cli"), "legacy.example:8080");
    discoveryConfig(path.join(process.env.XDG_CONFIG_HOME, "glab-cli"), "xdg.example:8080");
    assert.equal(gitlab.gitlabRemote("git@legacy.example:group/repo.git")?.origin, "http://legacy.example:8080");
    assert.equal(gitlab.gitlabRemote("git@xdg.example:group/repo.git"), null);
  });

  it("uses XDG_CONFIG_HOME before system config directories", () => {
    discoveryHome();
    process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
    discoveryConfig(path.join(process.env.XDG_CONFIG_HOME, "glab-cli"), "xdg.example:8080");
    discoveryConfig(path.join(process.env.XDG_CONFIG_DIRS, "glab-cli"), "system.example:8080");
    assert.equal(gitlab.gitlabRemote("git@xdg.example:group/repo.git")?.origin, "http://xdg.example:8080");
    assert.equal(gitlab.gitlabRemote("git@system.example:group/repo.git"), null);
  });

  it("expands a home-relative XDG_CONFIG_HOME as glab does", () => {
    const home = discoveryHome();
    process.env.XDG_CONFIG_HOME = "~/xdg-config";
    discoveryConfig(path.join(home, "xdg-config", "glab-cli"), "xdg.example:8080");
    assert.equal(gitlab.gitlabRemote("git@xdg.example:group/repo.git")?.origin, "http://xdg.example:8080");
  });

  it("searches XDG_CONFIG_DIRS in order when no user config exists", () => {
    discoveryHome();
    const missing = path.join(tmp, "missing");
    const first = path.join(tmp, "first");
    const second = path.join(tmp, "second");
    process.env.XDG_CONFIG_DIRS = [missing, first, second].join(path.delimiter);
    discoveryConfig(path.join(first, "glab-cli"), "first.example:8080");
    discoveryConfig(path.join(second, "glab-cli"), "second.example:8080");
    assert.equal(gitlab.gitlabRemote("git@first.example:group/repo.git")?.origin, "http://first.example:8080");
    assert.equal(gitlab.gitlabRemote("git@second.example:group/repo.git"), null);
  });

  it("never falls through a missing GLAB_CONFIG_DIR override", () => {
    const home = discoveryHome();
    discoveryConfig(path.join(home, ".config", "glab-cli"), "legacy.example:8080");
    process.env.GLAB_CONFIG_DIR = path.join(tmp, "missing-override");
    assert.equal(gitlab.gitlabRemote("git@legacy.example:group/repo.git"), null);
  });

  function fakeGlab() {
    const calls = path.join(tmp, "calls.jsonl");
    process.env.CODER_GLAB_BIN = writeFakeBin(path.join(tmp, "glab"), `
const fs = require("node:fs");
const args = process.argv.slice(2);
const keys = ${JSON.stringify(envKeys)};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, env: Object.fromEntries(keys.map(k => [k, process.env[k] || ""]))}) + "\\n");
const endpoint = args[args.indexOf("-X") + 2];
const origin = process.env.GLAB_API_PROTOCOL + "://" + args[args.indexOf("--hostname") + 1];
if (endpoint === "graphql") console.log(JSON.stringify({data: {currentUser: {id: origin}}}));
else if (endpoint.endsWith("/notes")) console.log('{"id":77}');
else if (endpoint.includes("/issues/")) console.log(JSON.stringify({iid:5,title:"Fixture",web_url: origin + "/other/project/-/issues/5"}));
else console.log('[]');
`);
    return () => fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  }

  for (const [input, origin, host] of [
    ["http://gitlab.example:8080/group/repo.git", "http://gitlab.example:8080", "gitlab.example:8080"],
    ["https://gitlab.example:8443/group/repo.git/", "https://gitlab.example:8443", "gitlab.example:8443"],
    ["https://user:secret@GitLab.example/group/repo.git", "https://gitlab.example", "gitlab.example"],
    ["ssh://git@gitlab.example:2222/group/repo.git", "https://gitlab.example", "gitlab.example"],
    ["git@gitlab.example:group/repo.git", "https://gitlab.example", "gitlab.example"],
    ["gitlab.example:group/repo.git", "https://gitlab.example", "gitlab.example"],
  ]) {
    it(`retains the web origin for ${input.replace("user:secret@", "")}`, () => {
      assert.deepEqual(gitlab.gitlabRemote(input), { host, origin, path: "group/repo" });
    });
  }

  it("requires exact explicit configuration for neutral web hosts", () => {
    assert.equal(gitlab.gitlabRemote("https://code.example:8443/group/repo.git"), null);
    configure('hosts:\n    "code.example:8443":\n        api_protocol: https\n        token: fixture-only\n');
    const remote = { host: "code.example:8443", origin: "https://code.example:8443", path: "group/repo" };
    assert.deepEqual(gitlab.gitlabRemote("https://code.example:8443/group/repo.git"), remote);
    assert.deepEqual(prForge("https://code.example:8443/group/repo.git").remote, remote);
    assert.equal(isForgeRemote("https://code.example:8443/group/repo.git"), true);
    assert.equal(gitlab.gitlabRemote("https://code.example:9443/group/repo.git"), null);
    assert.equal(gitlab.gitlabRemote("https://code.example.evil:8443/group/repo.git"), null);
  });

  it("maps SSH and scp to a configured HTTP origin without reusing the SSH port", () => {
    configure("hosts:\n    code.example:8080:\n        api_protocol: http\n");
    for (const input of ["ssh://git@code.example:2222/group/repo.git", "git@code.example:group/repo.git"]) {
      assert.deepEqual(gitlab.gitlabRemote(input), {
        host: "code.example:8080", origin: "http://code.example:8080", path: "group/repo",
      });
    }
  });

  it("keeps the origin and subgroup path in repository links", () => {
    configure("hosts:\n    code.example:8080:\n        api_protocol: http\n");
    for (const input of ["http://code.example:8080/group/sub/repo.git", "ssh://git@code.example:2222/group/sub/repo.git"]) {
      assert.deepEqual(repoInfoFromRemote(input), {
        owner: "sub", repo: "repo", webUrl: "http://code.example:8080/group/sub/repo",
      });
    }
  });

  it("uses per-host protocol for a bare environment host", () => {
    configure("hosts:\n    code.example:8080:\n        api_protocol: http\n");
    process.env.GITLAB_HOST = "code.example:8080";
    assert.equal(gitlab.gitlabRemote("git@code.example:group/repo.git").origin, "http://code.example:8080");
  });

  it("matches configured SSH hostnames without case sensitivity", () => {
    process.env.GITLAB_HOST = "https://code.example:8443";
    assert.equal(gitlab.gitlabRemote("ssh://git@CODE.example:2222/group/repo.git")?.origin, "https://code.example:8443");
    assert.equal(gitlab.gitlabRemote("git@CODE.example:group/repo.git")?.origin, "https://code.example:8443");
  });

  it("rejects malformed issue authorities without throwing", () => {
    for (const ref of ["https://gitlab.example:bad/a/b/-/issues/1", "http://user:token@gitlab.example/a/b/-/issues/1"]) {
      assert.equal(gitlab.parseGitlabIssueUrl(ref), null);
    }
  });

  it("does not guess between multiple configured web ports for an SSH host", () => {
    configure("hosts:\n    code.example:8080:\n        api_protocol: http\n    code.example:8443:\n        api_protocol: https\n");
    assert.equal(gitlab.gitlabRemote("git@code.example:group/repo.git"), null);
    process.env.GITLAB_HOST = "https://code.example:8443";
    assert.equal(gitlab.gitlabRemote("git@code.example:group/repo.git").origin, "https://code.example:8443");
  });

  for (const key of ["GITLAB_HOST", "GITLAB_URI", "GL_HOST"]) {
    it(`accepts explicit neutral host configuration through ${key}`, () => {
      process.env[key] = "http://code.example:8080";
      assert.deepEqual(gitlab.gitlabRemote("git@code.example:group/repo.git"), {
        host: "code.example:8080", origin: "http://code.example:8080", path: "group/repo",
      });
      assert.equal(gitlab.gitlabRemote("https://unconfigured.example/group/repo.git"), null);
    });
  }

  it("rejects malformed paths and non-web protocols", () => {
    for (const input of ["/tmp/repo.git", "file://gitlab.example/group/repo", "ftp://gitlab.example/group/repo", "https://gitlab.example/group", "https://gitlab.example/group/../repo", "https://gitlab.example/group/repo?query=1"]) {
      assert.equal(gitlab.gitlabRemote(input), null, input);
    }
  });

  for (const origin of ["http://gitlab.example:8080", "https://gitlab.example:8443"]) {
    it(`routes REST, GraphQL, cross-project issues and note URLs through ${origin}`, { skip: process.platform === "win32" }, async () => {
      const calls = fakeGlab();
      const remote = gitlab.gitlabRemote(`${origin}/group/repo.git`);
      const host = origin.split("://")[1];
      process.env.GITLAB_API_HOST = "wrong.example:9999";
      process.env.GLAB_API_PROTOCOL = "ftp";
      assert.equal((await gitlab.glabApi(tmp, remote, "GET", "/merge_requests")).ok, true);
      const graphql = await gitlab.glabGraphql(tmp, remote, "query { currentUser { id } }");
      assert.equal(graphql.data.currentUser.id, origin);
      const fetched = await gitlab.fetchIssue(tmp, remote, { number: 5, owner: "other", repo: "project" });
      assert.equal(fetched.issue.url, `${origin}/other/project/-/issues/5`);
      assert.deepEqual(await gitlab.addNote(tmp, remote, 5, "fixture"), {
        ok: true, url: `${origin}/group/repo/-/issues/5#note_77`,
      });
      for (const call of calls()) {
        assert.equal(call.args[2], host);
        assert.equal(call.env.GITLAB_API_HOST, host);
        assert.equal(call.env.GLAB_API_PROTOCOL, origin.split(":")[0]);
      }
      assert.equal(calls()[2].args[5], "projects/other%2Fproject/issues/5");
    });
  }

  it("never forwards another authority's environment credentials", { skip: process.platform === "win32" }, async () => {
    const calls = fakeGlab();
    process.env.GITLAB_HOST = "https://gitlab.example:8443";
    process.env.GITLAB_TOKEN = "fixture-token";
    process.env.GITLAB_ACCESS_TOKEN = "fixture-access";
    process.env.OAUTH_TOKEN = "fixture-oauth";
    process.env.JOB_TOKEN = "fixture-direct-job";
    process.env.GLAB_IS_OAUTH2 = "true";
    process.env.OAUTH2_REFRESH_TOKEN = "fixture-refresh";
    process.env.REFRESH_TOKEN = "fixture-legacy-refresh";
    process.env.CI_JOB_TOKEN = "fixture-job";
    process.env.GITLAB_CI = "true";
    const selected = gitlab.gitlabRemote("https://gitlab.example:8443/a/b.git");
    await gitlab.glabApi(tmp, selected, "GET", "/issues");
    for (const input of ["https://gitlab.example:9443/a/b.git", "https://gitlab.other/a/b.git", "https://gitlab.com/a/b.git"]) {
      await gitlab.glabApi(tmp, gitlab.gitlabRemote(input), "GET", "/issues");
    }
    assert.equal(calls()[0].env.GITLAB_TOKEN, "fixture-token");
    assert.equal(calls()[0].env.JOB_TOKEN, "fixture-direct-job");
    assert.equal(calls()[0].env.GLAB_IS_OAUTH2, "true");
    assert.equal(calls()[0].env.OAUTH2_REFRESH_TOKEN, "fixture-refresh");
    assert.equal(calls()[0].env.REFRESH_TOKEN, "fixture-legacy-refresh");
    for (const call of calls().slice(1)) {
      for (const key of ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN", "GITLAB_CI", "JOB_TOKEN", "GLAB_IS_OAUTH2", "OAUTH2_REFRESH_TOKEN", "REFRESH_TOKEN"]) assert.equal(call.env[key], "", key);
    }
    assert.equal(process.env.GITLAB_TOKEN, "fixture-token");
  });

  it("keeps public GitLab's default environment token scoped to gitlab.com", { skip: process.platform === "win32" }, async () => {
    const calls = fakeGlab();
    process.env.GITLAB_TOKEN = "fixture-public-token";
    await gitlab.glabApi(tmp, gitlab.gitlabRemote("git@gitlab.com:a/b.git"), "GET", "/issues");
    await gitlab.glabApi(tmp, gitlab.gitlabRemote("git@gitlab.example:a/b.git"), "GET", "/issues");
    assert.equal(calls()[0].env.GITLAB_TOKEN, "fixture-public-token");
    assert.equal(calls()[1].env.GITLAB_TOKEN, "");
  });

  it("scopes an environment token to the explicit default host in glab config", { skip: process.platform === "win32" }, async () => {
    const calls = fakeGlab();
    configure("host: code.example:8443\nhosts:\n    code.example:8443:\n        api_protocol: https\n");
    process.env.GITLAB_TOKEN = "fixture-default-token";
    await gitlab.glabApi(tmp, gitlab.gitlabRemote("git@code.example:a/b.git"), "GET", "/issues");
    await gitlab.glabApi(tmp, gitlab.gitlabRemote("git@gitlab.com:a/b.git"), "GET", "/issues");
    assert.equal(calls()[0].env.GITLAB_TOKEN, "fixture-default-token");
    assert.equal(calls()[1].env.GITLAB_TOKEN, "");
  });

  it("preserves pasted issue origins and refuses a different origin before invoking glab", { skip: process.platform === "win32" }, async () => {
    const calls = fakeGlab();
    configure("hosts:\n    code.example:8080:\n        api_protocol: http\n");
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "http://code.example:8080/group/repo.git"], { cwd: repo });
    assert.equal((await issues.fetchIssue(repo, "http://code.example:8080/other/project/-/issues/5")).ok, true);
    assert.equal(calls().length, 1);
    for (const ref of ["https://code.example:8080/other/project/-/issues/5", "http://code.example:9090/other/project/-/issues/5", "https://gitlab.com/other/project/-/issues/5"]) {
      assert.equal((await issues.fetchIssue(repo, ref)).ok, false);
    }
    assert.equal(calls().length, 1);
  });
});
