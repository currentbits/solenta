/**
 * Issue #510: CI/workflow diffs are a privilege-escalation. mergePr and
 * mergeWorktree refuse without an explicit ciWorkflowApproved flag.
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
  setupWorktree,
  mergeWorktree,
  mergePr,
  diff,
} = require("../worktrees.js");
const {
  isCiWorkflowPath,
  CI_WORKFLOW_BLOCK_PREFIX,
  assertCiWorkflowSignOff,
} = require("../blastRadius.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeWorkflow(dir, body) {
  const wfDir = path.join(dir, ".github", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "jira_issue.yml"), body);
}

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

if (args[0] === "pr" && args[1] === "merge") {
  const number = Number(args[2]);
  let found = null;
  for (const key of Object.keys(state.prs || {})) {
    if (state.prs[key].number === number) found = state.prs[key];
  }
  if (!found) {
    process.stderr.write("no pull request found\\n");
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

describe("electron blastRadius matcher", () => {
  it("matches the #510 list and not package.json", () => {
    assert.equal(isCiWorkflowPath(".github/workflows/ci.yml"), true);
    assert.equal(isCiWorkflowPath("Jenkinsfile"), true);
    assert.equal(isCiWorkflowPath("package.json"), false);
  });

  it("assertCiWorkflowSignOff is a hard rule, not a preset", () => {
    assert.throws(
      () => assertCiWorkflowSignOff([".github/workflows/ci.yml"], false),
      (err) => String(err.message).startsWith(CI_WORKFLOW_BLOCK_PREFIX),
    );
    assert.doesNotThrow(() =>
      assertCiWorkflowSignOff([".github/workflows/ci.yml"], true),
    );
    assert.doesNotThrow(() => assertCiWorkflowSignOff([], false));
  });
});

describe("mergeWorktree CI workflow gate", () => {
  let tmp;
  let store;
  let repo;
  let thread;
  let worktreeBase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-blast-wt-"));
    store = new Store(path.join(tmp, "store.json"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "CI gate",
    });
    worktreeBase = path.join(tmp, "wt");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a workflow-file merge until ciWorkflowApproved", () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    writeWorkflow(
      setup.worktreePath,
      "name: jira\non: issues\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
    );

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          broadcast: () => {},
        }),
      (err) => {
        assert.match(err.message, /^CI_WORKFLOW:/);
        assert.match(err.message, /jira_issue\.yml/);
        return true;
      },
    );
    assert.ok(fs.existsSync(setup.worktreePath), "must not merge on refusal");

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      ciWorkflowApproved: true,
      broadcast: () => {},
    });
    assert.equal(merged.worktreePath, null);
    assert.ok(
      fs.existsSync(path.join(repo, ".github", "workflows", "jira_issue.yml")),
    );
  });
});

describe("mergePr CI workflow gate", () => {
  let tmp;
  let store;
  let repo;
  let thread;
  let prevGh;
  let prevState;
  let statePath;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-blast-pr-"));
    store = new Store(path.join(tmp, "store.json"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "CI PR gate",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase: path.join(tmp, "wt"),
      broadcast: () => {},
    });
    writeWorkflow(
      setup.worktreePath,
      'name: jira\non: issues\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.issue.title }}"\n',
    );
    git(setup.worktreePath, ["add", "."]);
    git(setup.worktreePath, ["commit", "-qm", "unsafe workflow"]);

    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir);
    const fakeGh = writeFakeGh(fakeDir);
    statePath = path.join(tmp, "gh-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        prs: {
          [setup.branch]: {
            number: 12,
            url: "https://github.com/acme/demo/pull/12",
            state: "OPEN",
            title: "CI PR gate",
          },
        },
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

  it("classifies the committed workflow on git.diff", async () => {
    const result = await diff({ store, threadId: thread.id });
    assert.ok(result.blastRadius);
    assert.ok(
      result.blastRadius.files.some((p) => p.includes("jira_issue.yml")),
    );
  });

  it("refuses squash-merge until ciWorkflowApproved, then merges", async () => {
    await assert.rejects(
      () => mergePr({ store, threadId: thread.id }),
      (err) => {
        assert.match(err.message, /^CI_WORKFLOW:/);
        return true;
      },
    );
    const stateBefore = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      (stateBefore.calls || []).some((c) => c[0] === "pr" && c[1] === "merge"),
      false,
      "must not call gh pr merge before sign-off",
    );

    const info = await mergePr({
      store,
      threadId: thread.id,
      ciWorkflowApproved: true,
    });
    assert.equal(info.state, "MERGED");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(
      (state.calls || []).some((c) => c[0] === "pr" && c[1] === "merge"),
    );
  });
});
