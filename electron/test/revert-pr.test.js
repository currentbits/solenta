/**
 * #1531: "Open revert PR" on a merged PR. Real temp repos (a bare origin
 * reached through url.insteadOf), gh stubbed.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { openRevertPr } = require("../revertPr.js");
const { rmTree } = require("./support/rmTree.js");

const GH_URL = "https://github.com/acme/repo.git";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(cwd, file, text, msg) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", msg]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("openRevertPr", () => {
  let tmp;
  let bare;
  let work;
  let ghCalls;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revert-pr-test-"));
    bare = path.join(tmp, "origin.git");
    work = path.join(tmp, "work");
    git(tmp, ["init", "-q", "--bare", "-b", "main", bare]);
    git(tmp, ["init", "-q", "-b", "main", work]);
    git(work, ["config", "user.name", "T"]);
    git(work, ["config", "user.email", "t@example.com"]);
    git(work, ["config", "commit.gpgsign", "false"]);
    git(work, ["remote", "add", "origin", GH_URL]);
    git(work, ["config", `url.${bare}.insteadOf`, GH_URL]);
    commitFile(work, "a.txt", "a\n", "init");
    git(work, ["push", "-q", "origin", "main"]);
    ghCalls = [];
  });

  afterEach(() => rmTree(tmp));

  const storeFor = () => ({
    getThread: () => ({ id: "t1", projectId: "p1", prNumber: 5, prState: "MERGED" }),
    getProject: () => ({ id: "p1", path: work }),
  });

  const ghStub = (sha, { createFails = false } = {}) => async (_cwd, args) => {
    ghCalls.push(args);
    if (args[1] === "view") {
      return {
        ok: true,
        stdout: JSON.stringify({
          number: 5,
          title: "Add b",
          url: "https://github.com/acme/repo/pull/5",
          baseRefName: "main",
          mergeCommit: { oid: sha },
        }),
      };
    }
    if (createFails) return { ok: false, stdout: "", stderr: "boom", combined: "boom" };
    return { ok: true, stdout: "https://github.com/acme/repo/pull/6" };
  };

  /** The user's checkout is exactly as it was: same HEAD, clean, one worktree, no revert branch. */
  function assertCheckoutUntouched(head) {
    assert.equal(git(work, ["rev-parse", "HEAD"]), head);
    assert.equal(git(work, ["status", "--porcelain"]), "");
    assert.equal(git(work, ["worktree", "list"]).split("\n").length, 1);
    assert.equal(git(work, ["branch", "--list", "revert-pr-5"]), "");
  }

  it("reverts a squash commit on a pushed branch and opens the PR", async () => {
    const sha = commitFile(work, "b.txt", "b\n", "Add b (#5)");
    git(work, ["push", "-q", "origin", "main"]);
    const head = git(work, ["rev-parse", "HEAD"]);

    const res = await openRevertPr({ store: storeFor(), threadId: "t1", runGh: ghStub(sha) });

    assert.deepEqual(res, { ok: true, url: "https://github.com/acme/repo/pull/6", branch: "revert-pr-5" });
    const files = git(bare, ["ls-tree", "--name-only", "revert-pr-5"]).split("\n");
    assert.deepEqual(files, ["a.txt"]);
    const create = ghCalls.find((a) => a[1] === "create");
    assert.deepEqual(create, [
      "pr", "create", "--base", "main", "--head", "revert-pr-5",
      "--title", 'Revert "Add b"',
      "--body", "Reverts #5 (https://github.com/acme/repo/pull/5).",
    ]);
    assertCheckoutUntouched(head);
  });

  it("uses -m 1 for a true merge commit", async () => {
    git(work, ["checkout", "-q", "-b", "feat"]);
    commitFile(work, "b.txt", "b\n", "b");
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "-q", "--no-ff", "feat", "-m", "Merge #5"]);
    git(work, ["branch", "-q", "-D", "feat"]);
    const sha = git(work, ["rev-parse", "HEAD"]);
    git(work, ["push", "-q", "origin", "main"]);

    const res = await openRevertPr({ store: storeFor(), threadId: "t1", runGh: ghStub(sha) });

    assert.equal(res.ok, true);
    assert.deepEqual(git(bare, ["ls-tree", "--name-only", "revert-pr-5"]).split("\n"), ["a.txt"]);
    assertCheckoutUntouched(sha);
  });

  it("a conflicting revert reports it and leaves nothing behind", async () => {
    const sha = commitFile(work, "b.txt", "b\n", "Add b (#5)");
    const head = commitFile(work, "b.txt", "b changed later\n", "later");
    git(work, ["push", "-q", "origin", "main"]);

    const res = await openRevertPr({ store: storeFor(), threadId: "t1", runGh: ghStub(sha) });

    assert.equal(res.ok, false);
    assert.match(res.reason, /conflicts with later changes on main/);
    assert.equal(ghCalls.some((a) => a[1] === "create"), false);
    assert.equal(git(bare, ["branch", "--list", "revert-pr-5"]), "");
    assertCheckoutUntouched(head);
  });

  it("deletes the pushed branch when gh pr create fails", async () => {
    const sha = commitFile(work, "b.txt", "b\n", "Add b (#5)");
    git(work, ["push", "-q", "origin", "main"]);

    const res = await openRevertPr({
      store: storeFor(),
      threadId: "t1",
      runGh: ghStub(sha, { createFails: true }),
    });

    assert.deepEqual(res, { ok: false, reason: "boom" });
    assert.equal(git(bare, ["branch", "--list", "revert-pr-5"]), "");
    assertCheckoutUntouched(sha);
  });

  it("refuses a PR that is not merged", async () => {
    const store = {
      getThread: () => ({ id: "t1", projectId: "p1", prNumber: 5, prState: "OPEN" }),
      getProject: () => ({ id: "p1", path: work }),
    };
    const res = await openRevertPr({ store, threadId: "t1", runGh: ghStub("x") });
    assert.equal(res.ok, false);
    assert.equal(ghCalls.length, 0);
  });
});
