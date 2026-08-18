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
} = require("../worktrees.js");
const { writeFakeBin } = require("./support/fakeBin.js");

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

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    if (prevState == null) delete process.env.CODER_FAKE_GH_STATE;
    else process.env.CODER_FAKE_GH_STATE = prevState;
    fs.rmSync(tmp, { recursive: true, force: true });
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
});
