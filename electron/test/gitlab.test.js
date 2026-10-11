"use strict";

/**
 * GitLab forge backend (issue #193): remote parsing, MR → PrInfo mapping,
 * and the glab api calls behind the issue/planboard and CI seams, driven
 * through a fake glab that replays canned responses per endpoint.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const gitlab = require("../gitlab.js");
const issues = require("../issues.js");
const { isForgeRemote } = require("../worktrees.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

describe("gitlabRemote", () => {
  it("parses gitlab.com and self-hosted remotes, including subgroups", () => {
    assert.deepEqual(gitlab.gitlabRemote("git@gitlab.com:acme/sub/demo.git"), {
      host: "gitlab.com",
      path: "acme/sub/demo",
    });
    assert.deepEqual(gitlab.gitlabRemote("https://gitlab.com/acme/demo.git"), {
      host: "gitlab.com",
      path: "acme/demo",
    });
    assert.deepEqual(
      gitlab.gitlabRemote("ssh://git@gitlab.acme.dev:2222/team/demo.git"),
      { host: "gitlab.acme.dev", path: "team/demo" },
    );
    assert.deepEqual(
      gitlab.gitlabRemote("https://oauth2:tok@GitLab.example.com/a/b"),
      { host: "gitlab.example.com", path: "a/b" },
    );
  });

  it("rejects GitHub, local, and project-less remotes", () => {
    assert.equal(gitlab.gitlabRemote("https://github.com/acme/demo.git"), null);
    assert.equal(gitlab.gitlabRemote("/tmp/local-bare.git"), null);
    assert.equal(gitlab.gitlabRemote("https://gitlab.com/acme"), null);
    assert.equal(isForgeRemote("git@gitlab.com:acme/demo.git"), true);
    assert.equal(isForgeRemote("/tmp/local-bare.git"), false);
  });
});

describe("prInfoFromMr", () => {
  it("maps state, base, and merge status onto PrInfo", () => {
    const info = gitlab.prInfoFromMr(
      {
        iid: 7,
        web_url: "https://gitlab.com/acme/demo/-/merge_requests/7",
        state: "merged",
        title: "T",
        target_branch: "main",
        changes_count: "3",
        detailed_merge_status: "mergeable",
      },
      "feat",
      false,
    );
    assert.deepEqual(info, {
      number: 7,
      url: "https://gitlab.com/acme/demo/-/merge_requests/7",
      state: "MERGED",
      branch: "feat",
      created: false,
      title: "T",
      baseRefName: "main",
      changedFiles: 3,
      mergeable: "MERGEABLE",
    });
    assert.equal(
      gitlab.prInfoFromMr({ iid: 1, web_url: "u", state: "opened", has_conflicts: true }, "b").mergeable,
      "CONFLICTING",
    );
  });
});

describe("parseIssueRef with GitLab URLs", () => {
  it("parses /-/issues/ URLs with subgroups", () => {
    assert.deepEqual(
      issues.parseIssueRef("https://gitlab.com/acme/sub/demo/-/issues/12#note_1"),
      { number: 12, owner: "acme/sub", repo: "demo" },
    );
  });
});

describe("glab api backend", { skip: process.platform === "win32" }, () => {
  let tmp;
  let repo;
  let callsPath;
  const prevBin = process.env.CODER_GLAB_BIN;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-gitlab-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:acme/demo.git"], { cwd: repo });
    callsPath = path.join(tmp, "calls.json");
    fs.writeFileSync(callsPath, "[]");
    // Responses keyed by "METHOD path-without-query".
    const responses = {
      "GET projects/acme%2Fdemo/merge_requests": [
        { iid: 3, state: "merged", web_url: "https://gitlab.com/acme/demo/-/merge_requests/3" },
        { iid: 4, state: "opened", web_url: "https://gitlab.com/acme/demo/-/merge_requests/4", target_branch: "main" },
      ],
      "GET projects/acme%2Fdemo/merge_requests/4": {
        iid: 4, state: "opened", web_url: "https://gitlab.com/acme/demo/-/merge_requests/4", head_pipeline: { id: 99 },
      },
      "GET projects/acme%2Fdemo/pipelines/99/jobs": [
        { name: "test", status: "success", web_url: "https://gitlab.com/j/1" },
        { name: "lint", status: "failed" },
        { name: "flaky", status: "failed", allow_failure: true },
        { name: "deploy", status: "running" },
        { name: "manual", status: "canceled" },
      ],
      "GET projects/acme%2Fdemo/issues/5": {
        iid: 5, title: "Bug", description: "body", web_url: "https://gitlab.com/acme/demo/-/issues/5",
        state: "opened", labels: ["plan:doing"],
      },
      "GET projects/acme%2Fdemo/issues": [
        { iid: 5, title: "Bug", web_url: "https://gitlab.com/acme/demo/-/issues/5", state: "opened", labels: ["plan:todo"], updated_at: "2026-10-01T00:00:00Z" },
      ],
      "PUT projects/acme%2Fdemo/issues/5": { iid: 5 },
      "POST projects/acme%2Fdemo/issues/5/notes": { id: 77 },
      "POST projects/acme%2Fdemo/issues": { iid: 9, web_url: "https://gitlab.com/acme/demo/-/issues/9" },
    };
    process.env.CODER_GLAB_BIN = writeFakeBin(
      path.join(tmp, "glab"),
      `const fs = require("fs");
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(${JSON.stringify(callsPath)}, "utf8"));
calls.push(args);
fs.writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
const method = args[args.indexOf("-X") + 1];
const endpoint = args[args.indexOf("-X") + 2].split("?")[0];
const body = ${JSON.stringify(responses)}[method + " " + endpoint];
if (body === undefined) { process.stderr.write("glab: 404 Not Found (HTTP 404)"); process.exit(1); }
process.stdout.write(JSON.stringify(body));
`,
    );
  });

  after(() => {
    if (prevBin === undefined) delete process.env.CODER_GLAB_BIN;
    else process.env.CODER_GLAB_BIN = prevBin;
    rmTree(tmp);
  });

  function takeCalls() {
    const calls = JSON.parse(fs.readFileSync(callsPath, "utf8"));
    fs.writeFileSync(callsPath, "[]");
    return calls;
  }

  const remote = { host: "gitlab.com", path: "acme/demo" };

  it("viewMr prefers the open MR for the branch", async () => {
    const info = await gitlab.viewMr(repo, remote, "feat/x");
    assert.equal(info.number, 4);
    assert.equal(info.state, "OPEN");
    const [call] = takeCalls();
    assert.deepEqual(call.slice(0, 5), ["api", "--hostname", "gitlab.com", "-X", "GET"]);
    assert.match(call[5], /source_branch=feat%2Fx/);
  });

  it("mrChecks maps head-pipeline jobs onto check buckets", async () => {
    const res = await gitlab.mrChecks(repo, remote, "feat/x");
    takeCalls();
    assert.deepEqual(res, {
      ok: true,
      checks: [
        { name: "test", bucket: "pass", link: "https://gitlab.com/j/1" },
        { name: "lint", bucket: "fail" },
        { name: "flaky", bucket: "skipping" },
        { name: "deploy", bucket: "pending" },
        { name: "manual", bucket: "cancel" },
      ],
    });
  });

  it("issues.js routes fetch/list/plan/comment/complete/create to glab", async () => {
    const fetched = await issues.fetchIssue(repo, "5");
    assert.equal(fetched.ok, true);
    assert.equal(fetched.issue.url, "https://gitlab.com/acme/demo/-/issues/5");

    const listed = await issues.listIssuePage(repo, { state: "open", limit: 50 });
    assert.deepEqual(listed.issues[0].labels, ["plan:todo"]);
    assert.equal(listed.nextCursor, null);
    takeCalls();

    assert.deepEqual(await issues.setPlanStatus(repo, 5, "doing"), { ok: true });
    const [put] = takeCalls();
    assert.ok(put.includes("add_labels=plan:doing"));
    assert.ok(put.includes("remove_labels=plan:todo,plan:done"));

    const commented = await issues.commentIssue(repo, 5, "hi");
    assert.deepEqual(commented, {
      ok: true,
      url: "https://gitlab.com/acme/demo/-/issues/5#note_77",
    });
    takeCalls();

    assert.deepEqual(await issues.completeIssue(repo, 5, { comment: "landed" }), { ok: true });
    const closeCall = takeCalls().find((c) => c.includes("PUT"));
    assert.ok(closeCall.includes("state_event=close"));

    assert.deepEqual(await issues.createIssue(repo, { title: "New", body: "b" }), {
      ok: true,
      number: 9,
      url: "https://gitlab.com/acme/demo/-/issues/9",
    });
    assert.ok(takeCalls()[0].includes("labels=plan:todo"));

    assert.deepEqual(await issues.fetchIssue(repo, "404"), {
      ok: false,
      reason: "issue not found",
    });
  });
});
