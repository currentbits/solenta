"use strict";

/**
 * Repro R7, P1, P2 (commit 615b38a0).
 *
 * R7: IPC `git:mergeWorktree` / `git:removeWorktree` (ipc.js:1714-1720, 1745)
 *     never ask the runner whether the thread is running (the renderer
 *     disables its buttons while working, but the IPC and web bridge do not).
 * P1: isPrRefreshCandidate skips archived threads (worktrees.js:4317-4327),
 *     and sweepCrew archives finished workers, so worker PRs never refresh.
 * P2: maybeCleanupMergedWorktree (worktrees.js:5539-5595) removes the
 *     worktree of a thread that is running right now.
 *
 * Convention: asserts the CORRECT behaviour, so it FAILS while the bug is real.
 * Run: node --test electron/test/repro-r7-p1-p2-git-guards.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { setupWorktree, refreshPrStates } = require("../worktrees.js");
const { IPC_HANDLERS } = require("../ipc.js");
const { rmTree } = require("./support/rmTree.js");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Repo with a GitHub fetch URL (PR paths engage) and a local bare push URL. */
async function makeFixture({ commit = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-gitguards-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const repo = path.join(tmpDir, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  const bare = path.join(tmpDir, "remote.git");
  git(tmpDir, ["init", "--bare", bare]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  git(repo, ["remote", "set-url", "--push", "origin", bare]);
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, { projectId: project.id, title: "Busy thread" });
  const setup = setupWorktree({ store, threadId: thread.id, worktreeBase: path.join(tmpDir, "worktrees"), broadcast: () => {} });
  if (commit) {
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feat\n");
    git(setup.worktreePath, ["add", "-A"]);
    git(setup.worktreePath, ["commit", "-m", "feature"]);
  }
  return { tmpDir, store, repo, project, threadId: thread.id, wtPath: setup.worktreePath, branch: setup.branch };
}

describe("R7: merge/remove IPC while the thread is running", () => {
  let fx;
  afterEach(async () => fx && rmTree(fx.tmpDir));

  function ctxFor(fx) {
    fx.store.updateThread(fx.threadId, { status: "working" });
    return {
      store: fx.store,
      runner: { isRunning: (id) => id === fx.threadId },
      broadcast: () => {},
    };
  }

  it("git:mergeWorktree must refuse a running thread", async () => {
    fx = await makeFixture();
    let outcome;
    try {
      outcome = await IPC_HANDLERS["git:mergeWorktree"](ctxFor(fx), { threadId: fx.threadId });
    } catch (e) {
      outcome = e;
    }
    const facts = {
      refused: outcome instanceof Error,
      error: outcome instanceof Error ? outcome.message.slice(0, 100) : null,
      liveCwdStillExists: fs.existsSync(fx.wtPath),
      featureOnMain: fs.existsSync(path.join(fx.repo, "feature.txt")),
      threadWorktreePath: fx.store.getThread(fx.threadId).worktreePath,
    };
    console.log("R7 merge facts:", JSON.stringify(facts));
    assert.equal(facts.refused, true, "merged and deleted the cwd of a live run");
    assert.equal(facts.liveCwdStillExists, true);
  });

  it("git:removeWorktree must refuse a running thread", async () => {
    fx = await makeFixture({ commit: false }); // clean, nothing unmerged: no WORKTREE_DIRTY refusal
    let outcome;
    try {
      outcome = await IPC_HANDLERS["git:removeWorktree"](ctxFor(fx), { threadId: fx.threadId });
    } catch (e) {
      outcome = e;
    }
    const facts = {
      refused: outcome instanceof Error,
      error: outcome instanceof Error ? outcome.message.slice(0, 100) : null,
      liveCwdStillExists: fs.existsSync(fx.wtPath),
    };
    console.log("R7 remove facts:", JSON.stringify(facts));
    assert.equal(facts.refused, true, "removed the cwd of a live run");
  });
});

describe("P1/P2: PR refresher", () => {
  let fx;
  afterEach(async () => fx && rmTree(fx.tmpDir));

  const merged = (number) => async (_cwd, args) => {
    calls.push(args.join(" "));
    return { ok: true, stdout: JSON.stringify({ number, url: `https://github.com/acme/demo/pull/${number}`, state: "MERGED" }) };
  };
  let calls = [];

  it("P1: an archived worker whose PR is OPEN must still be refreshed", async () => {
    calls = [];
    fx = await makeFixture();
    // What sweepCrew leaves behind after thread_pr: archived orchWorker, PR OPEN.
    fx.store.updateThread(fx.threadId, {
      orchWorker: true,
      archived: true,
      status: "done",
      prNumber: 7,
      prUrl: "https://github.com/acme/demo/pull/7",
      prState: "OPEN",
    });
    const res = await refreshPrStates(fx.store, { ghTryAsyncFn: merged(7), broadcast: () => {} });
    const facts = { res, ghCalls: calls, prStateAfter: fx.store.getThread(fx.threadId).prState };
    console.log("P1 facts:", JSON.stringify(facts));
    assert.equal(facts.prStateAfter, "MERGED", "archived worker PR never refreshed");
  });

  it("P2: a MERGED flip must not delete the worktree of a thread that is running", async () => {
    calls = [];
    fx = await makeFixture();
    git(fx.wtPath, ["push", "-u", "origin", fx.branch]); // clean + local == origin/<branch>
    // A worker sent back to fix review comments: live, mid-run, nothing edited yet.
    fx.store.updateThread(fx.threadId, {
      orchWorker: true,
      status: "working",
      prNumber: 7,
      prUrl: "https://github.com/acme/demo/pull/7",
      prState: "OPEN",
    });
    const res = await refreshPrStates(fx.store, {
      ghTryAsyncFn: merged(7),
      broadcast: () => {},
      isRunning: (id) => id === fx.threadId, // the dep the item-7 design injects; ignored today
    });
    const facts = {
      res,
      prStateAfter: fx.store.getThread(fx.threadId).prState,
      liveCwdStillExists: fs.existsSync(fx.wtPath),
      threadWorktreePath: fx.store.getThread(fx.threadId).worktreePath,
      branchStillExists: git(fx.repo, ["branch", "--list", fx.branch]) !== "",
    };
    console.log("P2 facts:", JSON.stringify(facts));
    assert.equal(facts.prStateAfter, "MERGED");
    assert.equal(facts.liveCwdStillExists, true, "deleted the cwd of a running thread");
  });
});
