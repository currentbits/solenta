/**
 * Merge method picker + auto-merge (#1493 D): `gh pr merge` gets the chosen
 * method (default squash) and `--auto`; the repo's allowed methods come from
 * `gh repo view --json` and are cached.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mergeFlags, repoMergeOptions } = require("../worktrees-pr.js");

describe("mergeFlags", () => {
  it("defaults to squash and appends --auto on request", () => {
    assert.deepEqual(mergeFlags(undefined), ["--squash"]);
    assert.deepEqual(mergeFlags({ method: "rebase" }), ["--rebase"]);
    assert.deepEqual(mergeFlags({ method: "merge", auto: true }), ["--merge", "--auto"]);
    assert.throws(() => mergeFlags({ method: "octopus" }), /Unknown merge method/);
  });
});

describe("repoMergeOptions", () => {
  it("lists allowed methods, preselects the viewer default, and caches", async () => {
    let calls = 0;
    const runGh = async () => {
      calls += 1;
      return {
        ok: true,
        stdout: JSON.stringify({
          squashMergeAllowed: false,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
          viewerDefaultMergeMethod: "REBASE",
        }),
      };
    };
    const cwd = `/tmp/merge-opts-${Date.now()}`;
    const first = await repoMergeOptions(cwd, { runGh, now: 1 });
    assert.deepEqual(first, { ok: true, methods: ["merge", "rebase"], defaultMethod: "rebase" });
    await repoMergeOptions(cwd, { runGh, now: 2 });
    assert.equal(calls, 1, "second read is cached");
    await repoMergeOptions(cwd, { runGh, now: 11 * 60 * 1000 });
    assert.equal(calls, 2, "cache expires");
  });

  it("falls back to squash when the viewer default is not allowed, and keeps failures in-band", async () => {
    const ok = await repoMergeOptions(`/tmp/merge-opts-b-${Date.now()}`, {
      runGh: async () => ({ ok: true, stdout: JSON.stringify({ viewerDefaultMergeMethod: "" }) }),
    });
    assert.equal(ok.defaultMethod, "squash");
    const bad = await repoMergeOptions(`/tmp/merge-opts-c-${Date.now()}`, {
      runGh: async () => ({ ok: false, stdout: "", stderr: "HTTP 401" }),
    });
    assert.equal(bad.ok, false);
  });
});
