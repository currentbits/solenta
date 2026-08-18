/**
 * Next-git-action decision table (issue #382).
 *
 * Run: node --experimental-strip-types --test test/nextGitAction.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  suggestNextGitAction,
  summarizeChecks,
  type NextGitActionInput,
} from "../src/nextGitAction.ts";
import type { GitSyncInfo, PrChecksResult } from "../src/shared/ipc.ts";

const synced: GitSyncInfo = { hasUpstream: true, ahead: 0, behind: 0 };
const ahead1: GitSyncInfo = { hasUpstream: true, ahead: 1, behind: 0 };
const noUpstream: GitSyncInfo = { hasUpstream: false };

function input(over: Partial<NextGitActionInput> = {}): NextGitActionInput {
  return {
    dirty: false,
    fileCount: 0,
    sync: synced,
    hasWorktree: true,
    remoteProject: false,
    prNumber: null,
    prUrl: null,
    prState: null,
    checks: null,
    ...over,
  };
}

describe("suggestNextGitAction", () => {
  it("hides on remote projects even when dirty", () => {
    const action = suggestNextGitAction(
      input({ dirty: true, fileCount: 3, remoteProject: true }),
    );
    assert.equal(action.kind, "idle");
  });

  it("prefers commit over push, PR, and checks", () => {
    const action = suggestNextGitAction(
      input({
        dirty: true,
        fileCount: 3,
        sync: ahead1,
        prNumber: 12,
        prState: "OPEN",
        checks: { ok: true, checks: [{ name: "ci", bucket: "pass" }] },
      }),
    );
    assert.equal(action.kind, "commit");
    assert.equal(action.label, "Commit 3 files");
    assert.equal(action.primary, true);
    assert.equal(action.actionable, true);
  });

  it("labels a single dirty file in the singular", () => {
    const action = suggestNextGitAction(input({ dirty: true, fileCount: 1 }));
    assert.equal(action.label, "Commit 1 file");
  });

  it("falls back to Commit when the file count is unknown", () => {
    const action = suggestNextGitAction(input({ dirty: true }));
    assert.equal(action.label, "Commit");
  });

  it("pushes unpushed commits before offering Create PR or merge", () => {
    const action = suggestNextGitAction(
      input({
        sync: ahead1,
        prNumber: 4,
        prState: "OPEN",
        checks: { ok: true, checks: [] },
      }),
    );
    assert.equal(action.kind, "push");
    assert.equal(action.label, "Push");
    assert.equal(action.title, "Push 1 commit to origin");
  });

  it("pushes a worktree that has never been published", () => {
    const action = suggestNextGitAction(
      input({ sync: noUpstream, hasWorktree: true }),
    );
    assert.equal(action.kind, "push");
    assert.equal(action.title, "Push this branch to origin");
  });

  it("does not invent a first push on a main checkout with no upstream", () => {
    const action = suggestNextGitAction(
      input({ sync: noUpstream, hasWorktree: false }),
    );
    assert.equal(action.kind, "idle");
  });

  it("offers Create PR once the branch is pushed and has no PR", () => {
    const action = suggestNextGitAction(input({ sync: synced, prNumber: null }));
    assert.equal(action.kind, "create-pr");
    assert.equal(action.label, "Create PR");
    assert.equal(action.primary, true);
  });

  it("waits for sync before offering Create PR", () => {
    const action = suggestNextGitAction(input({ sync: null }));
    assert.equal(action.kind, "idle");
  });

  it("hides after the PR is merged or closed", () => {
    assert.equal(
      suggestNextGitAction(input({ prNumber: 8, prState: "MERGED" })).kind,
      "idle",
    );
    assert.equal(
      suggestNextGitAction(input({ prNumber: 8, prState: "CLOSED" })).kind,
      "idle",
    );
  });

  it("shows Checking… until checks arrive for an open PR", () => {
    const action = suggestNextGitAction(
      input({
        prNumber: 9,
        prUrl: "https://github.com/acme/repo/pull/9",
        prState: "OPEN",
        checks: null,
      }),
    );
    assert.equal(action.kind, "watch-checks");
    assert.equal(action.label, "Checking…");
    assert.equal(action.actionable, false);
    assert.equal(action.href, "https://github.com/acme/repo/pull/9");
  });

  it("treats a PR number with no stored state as open", () => {
    const action = suggestNextGitAction(
      input({ prNumber: 3, prState: null, checks: null }),
    );
    assert.equal(action.kind, "watch-checks");
  });

  it("lets a failed checks fetch retry", () => {
    const action = suggestNextGitAction(
      input({
        prNumber: 2,
        prState: "OPEN",
        checks: { ok: false, reason: "gh missing" },
      }),
    );
    assert.equal(action.kind, "watch-checks");
    assert.equal(action.label, "Retry checks");
    assert.equal(action.title, "gh missing");
    assert.equal(action.actionable, true);
  });

  it("watches while any check is pending", () => {
    const checks: PrChecksResult = {
      ok: true,
      checks: [
        { name: "lint", bucket: "pass" },
        { name: "test", bucket: "pending" },
      ],
    };
    const action = suggestNextGitAction(
      input({ prNumber: 5, prState: "OPEN", checks }),
    );
    assert.equal(action.kind, "watch-checks");
    assert.equal(action.label, "Checks 1/2");
    assert.equal(action.primary, false);
  });

  it("does not offer merge when checks have failed", () => {
    const action = suggestNextGitAction(
      input({
        prNumber: 5,
        prState: "OPEN",
        checks: {
          ok: true,
          checks: [
            { name: "lint", bucket: "pass" },
            { name: "test", bucket: "fail" },
          ],
        },
      }),
    );
    assert.equal(action.kind, "checks-failed");
    assert.equal(action.label, "Checks failed");
    assert.equal(action.primary, false);
    assert.equal(action.actionable, true);
  });

  it("offers merge when every check passed, or when there is no CI", () => {
    const green = suggestNextGitAction(
      input({
        prNumber: 11,
        prState: "OPEN",
        checks: { ok: true, checks: [{ name: "ci", bucket: "pass" }] },
      }),
    );
    assert.equal(green.kind, "merge");
    assert.equal(green.label, "Merge PR #11");
    assert.equal(green.primary, true);

    const none = suggestNextGitAction(
      input({
        prNumber: 11,
        prState: "OPEN",
        checks: { ok: true, checks: [] },
      }),
    );
    assert.equal(none.kind, "merge");
  });

  it("treats skipping as pass and cancel as fail", () => {
    const skip = suggestNextGitAction(
      input({
        prNumber: 1,
        prState: "OPEN",
        checks: { ok: true, checks: [{ name: "opt", bucket: "skipping" }] },
      }),
    );
    assert.equal(skip.kind, "merge");

    const cancel = suggestNextGitAction(
      input({
        prNumber: 1,
        prState: "OPEN",
        checks: { ok: true, checks: [{ name: "job", bucket: "cancel" }] },
      }),
    );
    assert.equal(cancel.kind, "checks-failed");
  });

  it("drops an empty prUrl rather than inventing a href", () => {
    const action = suggestNextGitAction(
      input({
        prNumber: 4,
        prUrl: "  ",
        prState: "OPEN",
        checks: null,
      }),
    );
    assert.equal(action.href, null);
  });
});

describe("summarizeChecks", () => {
  it("buckets pass/fail/pending", () => {
    assert.deepEqual(
      summarizeChecks([
        { bucket: "pass" },
        { bucket: "skipping" },
        { bucket: "fail" },
        { bucket: "cancel" },
        { bucket: "pending" },
      ]),
      { pass: 2, fail: 2, pending: 1, total: 5 },
    );
  });
});
