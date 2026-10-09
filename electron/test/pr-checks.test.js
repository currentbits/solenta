"use strict";

/**
 * prChecks parsers + rollup, plus a small fake-gh loop for fallback/merge.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  parsePrChecksJson,
  parsePrChecksText,
  rollupPrChecks,
  prChecks,
  mergePr,
  setupWorktree,
  prStatus,
  setGithubApi,
} = require("../worktrees.js");
const { fakeGithubApi } = require("./support/fakeGithubApi.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

const JSON_FIXTURE = `[
  {
    "name": "test",
    "state": "SUCCESS",
    "bucket": "pass",
    "link": "https://github.com/acme/demo/actions/runs/1"
  },
  {
    "name": "lint",
    "state": "FAILURE",
    "bucket": "fail",
    "link": "https://github.com/acme/demo/actions/runs/2"
  },
  {
    "name": "deploy",
    "state": "IN_PROGRESS",
    "bucket": "pending"
  },
  {
    "name": "docs",
    "state": "SKIPPED",
    "bucket": "skipping"
  },
  {
    "name": "nightly",
    "state": "CANCELLED",
    "bucket": "cancel"
  }
]`;

const TEXT_FIXTURE = [
  "test\tpass\t1m2s\thttps://github.com/acme/demo/actions/runs/1",
  "lint\tfail\t12s\thttps://github.com/acme/demo/actions/runs/2",
  "Some Check Name\tpending\t0\thttps://github.com/acme/demo/actions/runs/3",
  "3/4 checks failing",
].join("\n");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("parsePrChecksJson", () => {
  it("parses name, bucket, and optional link", () => {
    const checks = parsePrChecksJson(JSON_FIXTURE);
    assert.equal(checks.length, 5);
    assert.deepEqual(checks[0], {
      name: "test",
      bucket: "pass",
      link: "https://github.com/acme/demo/actions/runs/1",
    });
    assert.equal(checks[1].bucket, "fail");
    assert.equal(checks[2].bucket, "pending");
    assert.equal(checks[2].link, undefined);
    assert.equal(checks[3].bucket, "skipping");
    assert.equal(checks[4].bucket, "cancel");
  });

  it("maps state when bucket is missing", () => {
    const checks = parsePrChecksJson(
      '[{"name":"ci","state":"SUCCESS"},{"name":"e2e","state":"FAILURE"}]',
    );
    assert.equal(checks[0].bucket, "pass");
    assert.equal(checks[1].bucket, "fail");
  });

  it("treats empty stdout as an empty list", () => {
    assert.deepEqual(parsePrChecksJson(""), []);
  });

  it("throws on unparseable JSON", () => {
    assert.throws(
      () => parsePrChecksJson("not-json"),
      /unparseable PR checks JSON/,
    );
  });

  it("throws on a row missing a name", () => {
    assert.throws(
      () => parsePrChecksJson('[{"bucket":"pass"}]'),
      /incomplete PR checks JSON/,
    );
  });
});

describe("parsePrChecksText", () => {
  it("parses tab-separated name / pass-fail-pending rows", () => {
    const checks = parsePrChecksText(TEXT_FIXTURE);
    assert.equal(checks.length, 3);
    assert.deepEqual(checks[0], {
      name: "test",
      bucket: "pass",
      link: "https://github.com/acme/demo/actions/runs/1",
    });
    assert.equal(checks[1].bucket, "fail");
    assert.equal(checks[2].name, "Some Check Name");
    assert.equal(checks[2].bucket, "pending");
  });

  it("parses multi-space columns from older gh", () => {
    const checks = parsePrChecksText(
      "build    pass    30s    https://example.com/1\n",
    );
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, "build");
    assert.equal(checks[0].bucket, "pass");
    assert.equal(checks[0].link, "https://example.com/1");
  });

  it("skips summary lines that have no bucket token", () => {
    assert.deepEqual(parsePrChecksText("All checks were successful\n"), []);
  });
});

describe("rollupPrChecks", () => {
  it("counts each known bucket and ignores unknown", () => {
    const counts = rollupPrChecks([
      { name: "a", bucket: "pass" },
      { name: "b", bucket: "pass" },
      { name: "c", bucket: "fail" },
      { name: "d", bucket: "pending" },
      { name: "e", bucket: "skipping" },
      { name: "f", bucket: "cancel" },
      { name: "g", bucket: "mystery" },
    ]);
    assert.deepEqual(counts, {
      pass: 2,
      fail: 1,
      pending: 1,
      skipping: 1,
      cancel: 1,
    });
  });

  it("returns zeros for an empty list", () => {
    assert.deepEqual(rollupPrChecks([]), {
      pass: 0,
      fail: 0,
      pending: 0,
      skipping: 0,
      cancel: 0,
    });
  });
});

function writeFakeGh(dir) {
  const bin = path.join(dir, "fake-gh");
  return writeFakeBin(
    bin,
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const statePath = process.env.CODER_FAKE_GH_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls = state.calls || [];
state.calls.push(args.slice());
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

function flagValue(name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
}

if (args[0] === "pr" && args[1] === "view") {
  const branch = args[2];
  const pr = state.prs && state.prs[branch];
  if (!pr) {
    process.stderr.write('no pull requests found for branch "' + branch + '"\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    number: pr.number,
    url: pr.url,
    state: pr.state || "OPEN",
    title: pr.title || "",
  }) + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "checks") {
  const wantsJson = args.includes("--json");
  if (state.scenario === "checks-no-json" && wantsJson) {
    process.stderr.write('Unknown JSON field: "bucket"\\n');
    process.exit(1);
  }
  if (state.scenario === "auth-fail") {
    process.stderr.write("gh auth login\\n");
    process.exit(1);
  }
  const checks = state.checks || [];
  if (wantsJson) {
    process.stdout.write(JSON.stringify(checks) + "\\n");
  } else {
    for (const c of checks) {
      process.stdout.write(
        c.name + "\\t" + c.bucket + "\\t0\\t" + (c.link || "") + "\\n",
      );
    }
  }
  if (checks.some((c) => c.bucket === "fail")) process.exit(1);
  if (checks.some((c) => c.bucket === "pending")) process.exit(8);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "merge") {
  const number = Number(args[2]);
  const squash = args.includes("--squash");
  if (!squash) {
    process.stderr.write("fake-gh: expected --squash\\n");
    process.exit(1);
  }
  let found = null;
  for (const key of Object.keys(state.prs || {})) {
    if (state.prs[key].number === number) found = state.prs[key];
  }
  if (!found) {
    process.stderr.write("no pull request found\\n");
    process.exit(1);
  }
  if ((found.state || "OPEN") !== "OPEN") {
    process.stderr.write(
      "X Pull request acme/demo#" + number + " is not mergeable: the pull request is not open\\n",
    );
    process.exit(1);
  }
  found.state = "MERGED";
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}

process.stderr.write("fake-gh: unhandled " + JSON.stringify(args) + "\\n");
process.exit(2);
`,
  );
}

describe("prChecks / mergePr", () => {
  let tmp;
  let store;
  let repo;
  let thread;
  let prevGh;
  let prevState;
  let statePath;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-prchecks-"));
    store = new Store(path.join(tmp, "store.json"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Checks feature",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase: path.join(tmp, "wt"),
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feat.txt"), "x\n");
    git(setup.worktreePath, ["add", "feat.txt"]);
    git(setup.worktreePath, ["commit", "-qm", "feat"]);

    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir);
    const fakeGh = writeFakeGh(fakeDir);
    statePath = path.join(tmp, "gh-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        scenario: "success",
        prs: {
          [setup.branch]: {
            number: 12,
            url: "https://github.com/acme/demo/pull/12",
            state: "OPEN",
            title: "Checks feature",
          },
        },
        checks: [
          {
            name: "test",
            state: "SUCCESS",
            bucket: "pass",
            link: "https://github.com/acme/demo/actions/runs/1",
          },
          {
            name: "e2e",
            state: "FAILURE",
            bucket: "fail",
            link: "https://github.com/acme/demo/actions/runs/2",
          },
        ],
        calls: [],
      }),
      "utf8",
    );
    prevGh = process.env.CODER_GH_BIN;
    prevState = process.env.CODER_FAKE_GH_STATE;
    process.env.CODER_GH_BIN = fakeGh;
    process.env.CODER_FAKE_GH_STATE = statePath;
  });

  afterEach(async () => {
    setGithubApi(null);
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    if (prevState == null) delete process.env.CODER_FAKE_GH_STATE;
    else process.env.CODER_FAKE_GH_STATE = prevState;
    await rmTree(tmp);
  });

  it("returns failing checks as ok:true even when gh exits 1", async () => {
    const result = await prChecks({ store, threadId: thread.id });
    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].bucket, "pass");
    assert.equal(result.checks[1].bucket, "fail");
  });

  it("falls back to the text table when --json is rejected", async () => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.scenario = "checks-no-json";
    fs.writeFileSync(statePath, JSON.stringify(state));
    const result = await prChecks({ store, threadId: thread.id });
    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].name, "test");
    assert.equal(result.checks[1].bucket, "fail");
  });

  it("returns auth without throwing", async () => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.scenario = "auth-fail";
    fs.writeFileSync(statePath, JSON.stringify(state));
    const result = await prChecks({ store, threadId: thread.id });
    assert.deepEqual(result, { ok: false, reason: "auth" });
  });

  it("squash-merges an OPEN PR and returns MERGED via prStatus", async () => {
    const info = await mergePr({ store, threadId: thread.id });
    assert.equal(info.state, "MERGED");
    assert.equal(info.number, 12);
    const stored = store.getThread(thread.id);
    assert.equal(stored.prState, "MERGED");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const mergeCall = state.calls.find(
      (c) => c[0] === "pr" && c[1] === "merge",
    );
    assert.ok(mergeCall, "must invoke gh pr merge");
    assert.ok(mergeCall.includes("--squash"));
  });

  it("surfaces gh's own error for a CLOSED PR", async () => {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const branch = Object.keys(state.prs)[0];
    state.prs[branch].state = "CLOSED";
    fs.writeFileSync(statePath, JSON.stringify(state));
    await assert.rejects(
      () => mergePr({ store, threadId: thread.id }),
      /not open|not mergeable/i,
    );
  });

  it("merges a non-overlapping main commit into the worktree before squash-merge", async () => {
    const wt = store.getThread(thread.id).worktreePath;
    fs.writeFileSync(path.join(repo, "other.txt"), "from main\n");
    git(repo, ["add", "other.txt"]);
    git(repo, ["commit", "-qm", "main moved"]);

    const originBare = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", originBare]);
    git(repo, ["remote", "set-url", "--push", "origin", originBare]);
    git(repo, ["push", originBare, "main:main"]);

    const info = await mergePr({ store, threadId: thread.id });
    assert.equal(info.state, "MERGED");
    assert.equal(
      fs.readFileSync(path.join(wt, "other.txt"), "utf8"),
      "from main\n",
      "the worktree must pick up the new main commit before gh pr merge",
    );
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(
      state.calls.some((c) => c[0] === "pr" && c[1] === "merge"),
      "must still squash-merge after a clean update",
    );
  });

  it("throws MERGE_CONFLICT and skips gh pr merge when main overlaps", async () => {
    const wt = store.getThread(thread.id).worktreePath;
    fs.writeFileSync(path.join(repo, "feat.txt"), "main side\n");
    git(repo, ["add", "feat.txt"]);
    git(repo, ["commit", "-qm", "main took feat.txt"]);

    await assert.rejects(
      () => mergePr({ store, threadId: thread.id }),
      (err) => {
        assert.match(String(err && err.message), /MERGE_CONFLICT:/);
        assert.match(String(err && err.message), /feat\.txt/);
        return true;
      },
    );
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(
      !state.calls.some((c) => c[0] === "pr" && c[1] === "merge"),
      "must not call gh pr merge while the worktree is conflicted",
    );
    assert.match(
      fs.readFileSync(path.join(wt, "feat.txt"), "utf8"),
      /<<<<<<</,
    );
  });

  it("finishes an in-progress merge after conflict markers are gone", async () => {
    const wt = store.getThread(thread.id).worktreePath;
    fs.writeFileSync(path.join(repo, "feat.txt"), "main side\n");
    git(repo, ["add", "feat.txt"]);
    git(repo, ["commit", "-qm", "main took feat.txt"]);

    await assert.rejects(
      () => mergePr({ store, threadId: thread.id }),
      /MERGE_CONFLICT:/,
    );

    fs.writeFileSync(path.join(wt, "feat.txt"), "resolved\n");
    const originBare = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", originBare]);
    git(repo, ["remote", "set-url", "--push", "origin", originBare]);

    const info = await mergePr({ store, threadId: thread.id });
    assert.equal(info.state, "MERGED");
    assert.equal(fs.readFileSync(path.join(wt, "feat.txt"), "utf8"), "resolved\n");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(state.calls.some((c) => c[0] === "pr" && c[1] === "merge"));
  });

  it("tells the user to close the PR when the branch matches main", async () => {
    const wt = store.getThread(thread.id).worktreePath;
    fs.copyFileSync(path.join(wt, "feat.txt"), path.join(repo, "feat.txt"));
    git(repo, ["add", "feat.txt"]);
    git(repo, ["commit", "-qm", "already landed on main"]);

    await assert.rejects(
      () => mergePr({ store, threadId: thread.id }),
      /already on main|close the PR/i,
    );
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(
      !state.calls.some((c) => c[0] === "pr" && c[1] === "merge"),
      "an empty unique tree must not squash-merge",
    );
  });

  describe("over the GitHub API (#1534)", () => {
    function api(extra) {
      const branch = Object.keys(JSON.parse(fs.readFileSync(statePath, "utf8")).prs)[0];
      return fakeGithubApi({
        prs: [
          { number: 3, url: "https://github.com/acme/demo/pull/3", headRefName: branch, state: "MERGED" },
          { number: 12, url: "https://github.com/acme/demo/pull/12", headRefName: branch, title: "Checks feature", mergeable: "CONFLICTING", additions: 4, deletions: 2, changedFiles: 1 },
          { number: 13, url: "https://github.com/fork/demo/pull/13", headRefName: branch, isCrossRepository: true },
        ],
        checks: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
          { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "TIMED_OUT", detailsUrl: "https://ci/2" },
          { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
          { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "NEUTRAL", detailsUrl: null },
          { __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "CANCELLED", detailsUrl: null },
          { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci/3" },
        ],
        ...extra,
      });
    }
    const ghPrCalls = () =>
      JSON.parse(fs.readFileSync(statePath, "utf8")).calls.filter((c) => c[0] === "pr");

    it("prStatus picks the same-repo OPEN PR and persists mergeable", async () => {
      setGithubApi(api());
      const info = await prStatus({ store, threadId: thread.id });
      assert.equal(info.number, 12);
      assert.equal(info.state, "OPEN");
      assert.equal(info.mergeable, "CONFLICTING");
      assert.equal(info.additions, 4);
      assert.equal(info.baseRefName, "main");
      assert.equal(store.getThread(thread.id).prMergeable, "CONFLICTING");
      assert.deepEqual(ghPrCalls(), []);
    });

    it("prChecks maps CheckRun/StatusContext onto gh's buckets", async () => {
      setGithubApi(api());
      const result = await prChecks({ store, threadId: thread.id });
      assert.deepEqual(result, {
        ok: true,
        checks: [
          { name: "test", bucket: "pass", link: "https://ci/1" },
          { name: "e2e", bucket: "fail", link: "https://ci/2" },
          { name: "lint", bucket: "pending" },
          { name: "docs", bucket: "skipping" },
          { name: "deploy", bucket: "cancel" },
          { name: "ci/legacy", bucket: "pass", link: "https://ci/3" },
        ],
      });
      assert.deepEqual(ghPrCalls(), []);
    });

    it("prChecks reports no PR from the API without running gh", async () => {
      const a = api();
      a.state.prs = [];
      setGithubApi(a);
      assert.deepEqual(await prChecks({ store, threadId: thread.id }), { ok: false, reason: "no PR" });
      assert.equal(await prStatus({ store, threadId: thread.id }), null);
      assert.deepEqual(ghPrCalls(), []);
    });

    it("mergePr squash-merges over REST", async () => {
      const a = api();
      setGithubApi(a);
      const info = await mergePr({ store, threadId: thread.id });
      assert.equal(info.state, "MERGED");
      assert.equal(store.getThread(thread.id).prState, "MERGED");
      const put = a.state.calls.find((c) => c.method === "PUT");
      assert.match(put.url, /\/pulls\/12\/merge$/);
      assert.deepEqual(ghPrCalls(), []);
    });

    it("falls back to gh when the API is down", async () => {
      setGithubApi(api({ failWith: 502 }));
      const info = await mergePr({ store, threadId: thread.id });
      assert.equal(info.state, "MERGED");
      assert.ok(ghPrCalls().some((c) => c[1] === "merge"));
      const checks = await prChecks({ store, threadId: thread.id });
      assert.equal(checks.ok, true);
      assert.equal(checks.checks.length, 2);
    });
  });
});
