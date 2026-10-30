"use strict";

/**
 * Issue #1763: delete a merged/closed PR's GitHub head branch. Unit tests
 * for the gh-CLI path (worktrees.maybeDeleteHeadBranch, used by worktrees-pr
 * mergePr and prWorkspace closePr/mergePrAt) plus wiring checks for
 * closePr and mergePrAt themselves.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { maybeDeleteHeadBranch, setGithubApi } = require("../worktrees.js");
const { closePr, mergePrAt } = require("../prWorkspace.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Fake `gh`: pr view (by number or branch), pr close, pr merge, api -X DELETE. */
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

function findPr(key) {
  return (state.prs || []).find(
    (p) => String(p.number) === String(key) || p.branch === key,
  );
}

if (args[0] === "pr" && args[1] === "view") {
  const pr = findPr(args[2]);
  if (!pr) {
    process.stderr.write('no pull requests found for "' + args[2] + '"\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    number: pr.number,
    state: pr.state || "OPEN",
    isCrossRepository: Boolean(pr.isCrossRepository),
    url: "https://github.com/acme/demo/pull/" + pr.number,
    title: pr.title || "",
    headRefName: pr.branch,
  }) + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && (args[1] === "close" || args[1] === "merge")) {
  const pr = findPr(args[2]);
  if (!pr) {
    process.stderr.write("no pull request found\\n");
    process.exit(1);
  }
  pr.state = args[1] === "close" ? "CLOSED" : "MERGED";
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}

if (args[0] === "api" && args.includes("DELETE")) {
  if (state.scenario === "delete-fails") {
    process.stderr.write("HTTP 422: Reference does not exist\\n");
    process.exit(1);
  }
  state.deletedBranches = state.deletedBranches || [];
  state.deletedBranches.push(args[args.length - 1]);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}

process.stderr.write("fake-gh: unhandled " + JSON.stringify(args) + "\\n");
process.exit(2);
`,
  );
}

describe("maybeDeleteHeadBranch over gh (#1763)", () => {
  let tmp;
  let repo;
  let store;
  let statePath;
  let prevGh;
  let prevState;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-branch-delete-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);

    store = new Store(path.join(tmp, "store.json"));

    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir);
    const fakeGh = writeFakeGh(fakeDir);
    statePath = path.join(tmp, "gh-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ prs: [{ number: 12, branch: "feat", state: "MERGED" }], calls: [] }),
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

  function state() {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  }

  it("deletes the branch when the setting is on (the default)", async () => {
    await maybeDeleteHeadBranch({ store, cwd: repo, prNumber: 12, headRefName: "feat" });
    assert.deepEqual(state().deletedBranches, [
      "repos/{owner}/{repo}/git/refs/heads/feat",
    ]);
  });

  it("skips when the setting is off", async () => {
    store.setSettings({ deleteBranchOnMergeOrClose: false });
    await maybeDeleteHeadBranch({ store, cwd: repo, prNumber: 12, headRefName: "feat" });
    assert.equal(state().deletedBranches, undefined);
  });

  it("skips a fork PR (isCrossRepository)", async () => {
    const s = state();
    s.prs[0].isCrossRepository = true;
    fs.writeFileSync(statePath, JSON.stringify(s));
    await maybeDeleteHeadBranch({ store, cwd: repo, prNumber: 12, headRefName: "feat" });
    assert.equal(state().deletedBranches, undefined);
  });

  it("skips the repo's default branch", async () => {
    await maybeDeleteHeadBranch({ store, cwd: repo, prNumber: 12, headRefName: "main" });
    assert.equal(state().deletedBranches, undefined);
  });

  it("skips while another open PR still targets this head branch", async () => {
    const s = state();
    s.prs.push({ number: 99, branch: "feat", state: "OPEN" });
    // findPr matches by number OR branch; put the open duplicate first so
    // "pr view feat" (branch lookup) resolves to it, same as gh would for
    // the only non-merged PR left on that branch.
    s.prs.reverse();
    fs.writeFileSync(statePath, JSON.stringify(s));
    await maybeDeleteHeadBranch({ store, cwd: repo, prNumber: 12, headRefName: "feat" });
    assert.equal(state().deletedBranches, undefined);
  });

  it("a deletion failure is logged as a quiet event, never thrown", async () => {
    const s = state();
    s.scenario = "delete-fails";
    fs.writeFileSync(statePath, JSON.stringify(s));
    const project = await services.addProject(store, repo);
    const thread = services.createThread(store, { projectId: project.id, title: "Ship it" });
    await maybeDeleteHeadBranch({
      store,
      cwd: repo,
      prNumber: 12,
      headRefName: "feat",
      threadId: thread.id,
    });
    const messages = store.getMessages(thread.id);
    assert.ok(messages.some((m) => m.role === "event" && /Could not delete branch feat/.test(m.text)));
  });
});

describe("closePr / mergePrAt delete the branch (#1763)", () => {
  let tmp;
  let repo;
  let store;
  let statePath;
  let prevGh;
  let prevState;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-branch-delete-panel-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);

    store = new Store(path.join(tmp, "store.json"));

    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir);
    const fakeGh = writeFakeGh(fakeDir);
    statePath = path.join(tmp, "gh-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ prs: [{ number: 12, branch: "feat", state: "OPEN" }], calls: [] }),
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

  function state() {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  }

  it("closePr deletes the branch when the setting is on", async () => {
    const out = await closePr(repo, { prNumber: 12 }, { store });
    assert.equal(out.ok, true);
    assert.deepEqual(state().deletedBranches, [
      "repos/{owner}/{repo}/git/refs/heads/feat",
    ]);
  });

  it("closePr skips deletion when the setting is off", async () => {
    store.setSettings({ deleteBranchOnMergeOrClose: false });
    const out = await closePr(repo, { prNumber: 12 }, { store });
    assert.equal(out.ok, true);
    assert.equal(state().deletedBranches, undefined);
  });

  it("mergePrAt deletes the branch when the setting is on", async () => {
    const out = await mergePrAt(repo, { prNumber: 12 }, { store });
    assert.equal(out.ok, true);
    assert.deepEqual(state().deletedBranches, [
      "repos/{owner}/{repo}/git/refs/heads/feat",
    ]);
  });

  it("mergePrAt skips deletion when the setting is off", async () => {
    store.setSettings({ deleteBranchOnMergeOrClose: false });
    const out = await mergePrAt(repo, { prNumber: 12 }, { store });
    assert.equal(out.ok, true);
    assert.equal(state().deletedBranches, undefined);
  });
});
