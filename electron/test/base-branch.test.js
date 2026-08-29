/**
 * Issue #187 / #775: optional stacked base at create, plus change after
 * create. Unset still targets origin/HEAD → main. A recorded base
 * retargets setupWorktree, mergeWorktree, and createPr. setBaseBranch
 * validates local branches, refuses after the first PR, and rebases a
 * bound worktree onto the new start-point.
 * Run: npm run test:electron -- --test-name-pattern="base-branch|setBaseBranch|#187"
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
  createPr,
  listBranches,
} = require("../worktrees.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFakeGh(dir) {
  const bin = path.join(dir, "fake-gh");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const statePath = process.env.CODER_FAKE_GH_STATE;
function load() { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
function save(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2), "utf8"); }
function flagValue(args, name) {
  const i = args.indexOf(name);
  return i < 0 || i + 1 >= args.length ? null : args[i + 1];
}
const args = process.argv.slice(2);
const state = load();
state.calls = state.calls || [];
state.calls.push(args.slice());
state.prs = state.prs || {};
save(state);
if (args[0] === "pr" && args[1] === "view") {
  const branch = args[2];
  const pr = state.prs[branch];
  if (!pr) {
    process.stderr.write("no pull requests found for branch \\"" + branch + "\\"\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    number: pr.number, url: pr.url, state: pr.state || "OPEN",
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = flagValue(args, "--head");
  const base = flagValue(args, "--base");
  const number = state.nextNumber || 42;
  state.nextNumber = number + 1;
  state.createCount = (state.createCount || 0) + 1;
  const url = "https://github.com/acme/demo/pull/" + number;
  state.prs[head] = { number, url, state: "OPEN", base };
  save(state);
  process.stdout.write(url + "\\n");
  process.exit(0);
}
process.stderr.write("fake-gh: unhandled " + JSON.stringify(args) + "\\n");
process.exit(2);
`;
  return writeFakeBin(bin, body);
}

describe("base-branch (#187)", () => {
  let tmpDir;
  let store;
  let repo;
  let project;
  let worktreeBase;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-base-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main
    }
    project = await services.addProject(store, repo);
  });

  afterEach(() => {
    try {
      for (const t of store.getThreads()) {
        if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
          try {
            git(repo, ["worktree", "remove", "--force", t.worktreePath]);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createThread defaults baseBranch to null", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Unset",
    });
    assert.equal(thread.baseBranch, null);
    assert.equal(store.getThread(thread.id).baseBranch, null);
  });

  it("createThread records a stacked base", () => {
    git(repo, ["checkout", "-b", "stacked-base"]);
    git(repo, ["checkout", "main"]);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "API",
      baseBranch: "stacked-base",
    });
    assert.equal(thread.baseBranch, "stacked-base");
    assert.equal(store.getThread(thread.id).baseBranch, "stacked-base");
  });

  it("listBranches puts the repo default first and lists local heads", () => {
    git(repo, ["checkout", "-b", "stacked-base"]);
    git(repo, ["checkout", "main"]);
    const listed = listBranches(repo);
    assert.equal(listed.defaultBranch, "main");
    assert.ok(listed.branches.includes("main"));
    assert.ok(listed.branches.includes("stacked-base"));
    assert.equal(listed.branches[0], "main");
  });

  it("setupWorktree without a base starts from origin/HEAD, not the checkout branch", () => {
    const mainHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "coder/feature-checkout"]);
    fs.writeFileSync(path.join(repo, "feature-only.txt"), "on feature\n");
    git(repo, ["add", "feature-only.txt"]);
    git(repo, ["commit", "-m", "feature commit"]);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Unset setup",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      mainHead,
      "unset worktree must start at the repo default",
    );
    assert.ok(!fs.existsSync(path.join(setup.worktreePath, "feature-only.txt")));
  });

  it("setupWorktree with a recorded base starts at that branch", () => {
    git(repo, ["checkout", "-b", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Stacked setup",
      baseBranch: "stacked-base",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    assert.equal(git(setup.worktreePath, ["rev-parse", "HEAD"]), stackedHead);
    assert.ok(fs.existsSync(path.join(setup.worktreePath, "schema.txt")));
  });

  it("mergeWorktree without baseBranch lands on main when the checkout is on a feature", () => {
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Unset merge",
    });
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "stacked.txt"), "from worker\n");
    const featureHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "coder/feature-base"]);
    assert.equal(git(repo, ["branch", "--show-current"]), "coder/feature-base");
    assert.equal(store.getThread(thread.id).baseBranch, null);

    mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.ok(fs.existsSync(path.join(repo, "stacked.txt")));
    assert.match(git(repo, ["log", "main", "-1", "--oneline"]), /Merge worktree/i);
    assert.equal(
      git(repo, ["rev-parse", "coder/feature-base"]),
      featureHead,
      "feature branch HEAD must stay put",
    );
    assert.equal(git(repo, ["branch", "--show-current"]), "main");
  });

  it("mergeWorktree with baseBranch=feature lands there, not on main", () => {
    git(repo, ["checkout", "-b", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const baseHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);
    const mainHead = git(repo, ["rev-parse", "HEAD"]);

    const stacked = services.createThread(store, {
      projectId: project.id,
      title: "API on schema",
      baseBranch: "stacked-base",
    });
    const setup = setupWorktree({
      store,
      threadId: stacked.id,
      worktreeBase,
      broadcast: () => {},
    });
    assert.equal(git(setup.worktreePath, ["rev-parse", "HEAD"]), baseHead);
    fs.writeFileSync(path.join(setup.worktreePath, "api.txt"), "api\n");

    mergeWorktree({
      store,
      threadId: stacked.id,
      broadcast: () => {},
    });

    assert.equal(git(repo, ["rev-parse", "main"]), mainHead, "main HEAD unchanged");
    assert.equal(git(repo, ["branch", "--show-current"]), "stacked-base");
    assert.equal(fs.readFileSync(path.join(repo, "api.txt"), "utf8"), "api\n");
    assert.equal(fs.readFileSync(path.join(repo, "schema.txt"), "utf8"), "schema\n");
    assert.match(
      git(repo, ["log", "stacked-base", "-1", "--oneline"]),
      /Merge worktree/i,
    );
  });

  describe("createPr", () => {
    const prevGhBin = process.env.CODER_GH_BIN;
    const prevGhState = process.env.CODER_FAKE_GH_STATE;

    afterEach(() => {
      if (prevGhBin === undefined) delete process.env.CODER_GH_BIN;
      else process.env.CODER_GH_BIN = prevGhBin;
      if (prevGhState === undefined) delete process.env.CODER_FAKE_GH_STATE;
      else process.env.CODER_FAKE_GH_STATE = prevGhState;
    });

    function preparePr(thread) {
      const setup = setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase,
        broadcast: () => {},
      });
      fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feat\n");
      git(setup.worktreePath, ["add", "feature.txt"]);
      git(setup.worktreePath, ["commit", "-m", "feature commit"]);
      const bare = path.join(tmpDir, "remote.git");
      git(tmpDir, ["init", "--bare", bare]);
      git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
      git(repo, ["remote", "set-url", "--push", "origin", bare]);
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const fakeDir = path.join(tmpDir, "fake-bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      process.env.CODER_GH_BIN = writeFakeGh(fakeDir);
      const statePath = path.join(tmpDir, "gh-state.json");
      fs.writeFileSync(
        statePath,
        JSON.stringify({ scenario: "success", prs: {}, calls: [], nextNumber: 42 }),
        "utf8",
      );
      process.env.CODER_FAKE_GH_STATE = statePath;
      return { setup, statePath };
    }

    it("unset baseBranch still targets origin/HEAD → main", async () => {
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Unset PR",
      });
      assert.equal(store.getThread(thread.id).baseBranch, null);
      const { setup, statePath } = preparePr(thread);
      git(repo, ["checkout", "-b", "coder/feature-checkout"]);
      await createPr({
        store,
        threadId: thread.id,
        title: "Ship feature",
        broadcast: () => {},
      });
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const createCall = state.calls.find((c) => c[0] === "pr" && c[1] === "create");
      assert.ok(createCall, `expected pr create: ${JSON.stringify(state.calls)}`);
      assert.equal(createCall[createCall.indexOf("--base") + 1], "main");
      assert.equal(state.prs[setup.branch].base, "main");
    });

    it("createPr with baseBranch=feature uses that --base", async () => {
      git(repo, ["checkout", "-b", "stacked-base"]);
      fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
      git(repo, ["add", "schema.txt"]);
      git(repo, ["commit", "-m", "schema"]);
      git(repo, ["checkout", "main"]);
      const stacked = services.createThread(store, {
        projectId: project.id,
        title: "PR onto feature",
        baseBranch: "stacked-base",
      });
      const { setup, statePath } = preparePr(stacked);
      await createPr({
        store,
        threadId: stacked.id,
        title: "API on schema",
        broadcast: () => {},
      });
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const createCall = state.calls.find((c) => c[0] === "pr" && c[1] === "create");
      assert.ok(createCall, `expected pr create: ${JSON.stringify(state.calls)}`);
      assert.equal(createCall[createCall.indexOf("--base") + 1], "stacked-base");
      assert.equal(state.prs[setup.branch].base, "stacked-base");
    });
  });
});

describe("setBaseBranch", () => {
  let tmpDir;
  let store;
  let repo;
  let threadId;
  let worktreeBase;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-base-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");
    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main
    }
    git(repo, ["checkout", "-b", "stacked-base"]);
    git(repo, ["checkout", "main"]);
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "API",
    }).id;
  });

  afterEach(() => {
    try {
      for (const t of store.getThreads()) {
        if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
          try {
            git(repo, ["worktree", "remove", "--force", t.worktreePath]);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a local branch as the stacked base", () => {
    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.baseBranch, "stacked-base");
    assert.equal(store.getThread(threadId).baseBranch, "stacked-base");
  });

  it("clears the stacked base back to the repo default", () => {
    services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    const cleared = services.setBaseBranch(store, {
      threadId,
      baseBranch: null,
    });
    assert.equal(cleared.baseBranch, null);
    assert.equal(store.getThread(threadId).baseBranch, null);
  });

  it("rejects a name that is not a local branch", () => {
    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "does-not-exist",
        }),
      /Unknown base branch|not a local branch/i,
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
  });

  it("rejects after the first pull request", () => {
    store.updateThread(threadId, { prNumber: 42, prUrl: "https://example/p/42" });
    store.save();
    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "stacked-base",
        }),
      /after the first pull request|already has a pull request/i,
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
  });

  it("does not bump updatedAt", () => {
    const before = store.getThread(threadId).updatedAt;
    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.updatedAt, before);
    assert.equal(store.getThread(threadId).updatedAt, before);
  });

  it("moves a clean worktree HEAD onto the new base (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    const startHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);
    assert.notEqual(startHead, stackedHead, "worktree must start off the new base");

    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.baseBranch, "stacked-base");
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      stackedHead,
      "worktree HEAD must land on the new base",
    );
    assert.ok(fs.existsSync(path.join(setup.worktreePath, "schema.txt")));
  });

  it("refuses a dirty worktree and leaves the recorded base unchanged (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    const startHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(setup.worktreePath, "dirty.txt"), "uncommitted\n");

    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "stacked-base",
        }),
      /dirty|uncommitted/i,
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      startHead,
      "dirty refuse must not move HEAD",
    );
    assert.notEqual(startHead, stackedHead);
    assert.ok(
      fs.existsSync(path.join(setup.worktreePath, "dirty.txt")),
      "dirty file must survive the refuse",
    );
  });

  it("keeps a unique thread commit on top of the new base (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feature\n");
    git(setup.worktreePath, ["add", "feature.txt"]);
    git(setup.worktreePath, ["commit", "-m", "unique feature"]);
    const uniqueHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);

    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.baseBranch, "stacked-base");

    const head = git(setup.worktreePath, ["rev-parse", "HEAD"]);
    assert.notEqual(
      head,
      stackedHead,
      "HEAD must be the rebased tip, not the base tip",
    );
    assert.notEqual(head, uniqueHead, "rebase rewrites the unique commit");
    assert.equal(
      git(setup.worktreePath, ["rev-list", "--count", `${stackedHead}..HEAD`]),
      "1",
    );
    assert.equal(
      git(setup.worktreePath, ["log", "-1", "--format=%s"]),
      "unique feature",
    );
    git(setup.worktreePath, [
      "merge-base",
      "--is-ancestor",
      stackedHead,
      "HEAD",
    ]);
    assert.ok(fs.existsSync(path.join(setup.worktreePath, "feature.txt")));
    assert.ok(fs.existsSync(path.join(setup.worktreePath, "schema.txt")));
  });

  it("names conflicted paths on rebase refuse and leaves HEAD unchanged (#776)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "README.md"), "stacked\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "stacked readme"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "README.md"), "feature\n");
    git(setup.worktreePath, ["add", "README.md"]);
    git(setup.worktreePath, ["commit", "-m", "feature readme"]);
    const startHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);

    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "stacked-base",
        }),
      (err) => {
        assert.match(String(err && err.message), /WORKTREE_REBASE_CONFLICT/);
        assert.match(
          String(err && err.message),
          /README\.md/,
          "conflict error must name at least one conflicted path",
        );
        return true;
      },
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      startHead,
      "conflict must not move HEAD",
    );
    assert.equal(
      fs.readFileSync(path.join(setup.worktreePath, "README.md"), "utf8"),
      "feature\n",
    );
    const gitDir = git(setup.worktreePath, ["rev-parse", "--git-dir"]);
    assert.ok(
      !fs.existsSync(path.join(gitDir, "rebase-merge")) &&
        !fs.existsSync(path.join(gitDir, "rebase-apply")),
      "conflict must abort the rebase, not leave it in progress",
    );
  });

  it("clearing the base moves a clean worktree HEAD to the repo default (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    git(repo, ["checkout", "main"]);
    const mainHead = git(repo, ["rev-parse", "main"]);

    store.updateThread(threadId, { baseBranch: "stacked-base" });
    store.save();
    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    assert.notEqual(git(setup.worktreePath, ["rev-parse", "HEAD"]), mainHead);

    const cleared = services.setBaseBranch(store, {
      threadId,
      baseBranch: null,
    });
    assert.equal(cleared.baseBranch, null);
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      mainHead,
      "cleared base must land the worktree on the repo default",
    );
  });

  it("keeps a unique thread commit on top of the new base (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feature\n");
    git(setup.worktreePath, ["add", "feature.txt"]);
    git(setup.worktreePath, ["commit", "-m", "unique feature"]);
    const uniqueHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);

    const updated = services.setBaseBranch(store, {
      threadId,
      baseBranch: "stacked-base",
    });
    assert.equal(updated.baseBranch, "stacked-base");

    const head = git(setup.worktreePath, ["rev-parse", "HEAD"]);
    assert.notEqual(
      head,
      stackedHead,
      "HEAD must be the rebased tip, not the base tip",
    );
    assert.notEqual(head, uniqueHead, "rebase rewrites the unique commit");
    assert.equal(
      git(setup.worktreePath, ["rev-list", "--count", `${stackedHead}..HEAD`]),
      "1",
    );
    assert.equal(
      git(setup.worktreePath, ["log", "-1", "--format=%s"]),
      "unique feature",
    );
    git(setup.worktreePath, [
      "merge-base",
      "--is-ancestor",
      stackedHead,
      "HEAD",
    ]);
    assert.ok(fs.existsSync(path.join(setup.worktreePath, "feature.txt")));
    assert.ok(fs.existsSync(path.join(setup.worktreePath, "schema.txt")));
  });

  it("aborts a conflicting rebase and leaves the recorded base unchanged (#775)", () => {
    git(repo, ["checkout", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "README.md"), "stacked\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "stacked readme"]);
    git(repo, ["checkout", "main"]);

    const setup = setupWorktree({
      store,
      threadId,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "README.md"), "feature\n");
    git(setup.worktreePath, ["add", "README.md"]);
    git(setup.worktreePath, ["commit", "-m", "feature readme"]);
    const startHead = git(setup.worktreePath, ["rev-parse", "HEAD"]);

    assert.throws(
      () =>
        services.setBaseBranch(store, {
          threadId,
          baseBranch: "stacked-base",
        }),
      /conflict|rebase/i,
    );
    assert.equal(store.getThread(threadId).baseBranch, null);
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      startHead,
      "conflict must not move HEAD",
    );
    assert.equal(
      fs.readFileSync(path.join(setup.worktreePath, "README.md"), "utf8"),
      "feature\n",
    );
    const gitDir = git(setup.worktreePath, ["rev-parse", "--git-dir"]);
    assert.ok(
      !fs.existsSync(path.join(gitDir, "rebase-merge")) &&
        !fs.existsSync(path.join(gitDir, "rebase-apply")),
      "conflict must abort the rebase, not leave it in progress",
    );
  });
});
