/**
 * Merge method picker + auto-merge (#1493 D): `gh pr merge` gets the chosen
 * method (default squash) and `--auto`; the repo's allowed methods come from
 * `gh repo view --json` and are cached.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mergeFlags, repoMergeOptions, resolveMergeMethod } = require("../worktrees-pr.js");

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

describe("resolveMergeMethod (#1781)", () => {
  const repo = { methods: ["squash", "merge", "rebase"], defaultMethod: "squash" };

  it("falls back to the repo default when neither project nor app set a method", () => {
    assert.equal(resolveMergeMethod(null, null, repo), "squash");
    assert.equal(resolveMergeMethod({}, {}, repo), "squash");
    assert.equal(resolveMergeMethod({ defaultMergeMethod: null }, { defaultMergeMethod: null }, repo), "squash");
  });

  it("the app setting wins when the project has no override", () => {
    assert.equal(resolveMergeMethod(null, { defaultMergeMethod: "rebase" }, repo), "rebase");
    assert.equal(
      resolveMergeMethod({ defaultMergeMethod: null }, { defaultMergeMethod: "merge" }, repo),
      "merge",
    );
  });

  it("the project override wins over the app setting", () => {
    assert.equal(
      resolveMergeMethod({ defaultMergeMethod: "merge" }, { defaultMergeMethod: "rebase" }, repo),
      "merge",
    );
  });

  it("a pick the repo does not allow falls back to the repo default", () => {
    const squashOnly = { methods: ["squash"], defaultMethod: "squash" };
    assert.equal(resolveMergeMethod({ defaultMergeMethod: "rebase" }, null, squashOnly), "squash");
    assert.equal(resolveMergeMethod(null, { defaultMergeMethod: "merge" }, squashOnly), "squash");
  });
});

describe("mergeOptions for a project checkout", () => {
  it("refuses a non-GitHub origin without calling gh", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const { execFileSync } = require("node:child_process");
    const { mergeOptions } = require("../worktrees-pr.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-opts-proj-"));
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/a/b.git"], { cwd: dir });
    assert.deepEqual(await mergeOptions({ projectPath: dir }), {
      ok: false,
      reason: "not a GitHub repo",
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves defaultMethod through the project's override, for the dropdown (#1781)", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const { execFileSync } = require("node:child_process");
    const { writeFakeBin } = require("./support/fakeBin.js");
    const { mergeOptions } = require("../worktrees-pr.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-opts-proj-b-"));
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: dir });
    const fakeGh = writeFakeBin(
      path.join(dir, "fake-gh"),
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: true,
  viewerDefaultMergeMethod: "SQUASH",
}) + "\\n");
`,
    );
    const prevGh = process.env.CODER_GH_BIN;
    process.env.CODER_GH_BIN = fakeGh;
    try {
      const store = {
        getSettings: () => ({ defaultMergeMethod: "merge" }),
        getProjects: () => [{ id: "p1", path: dir, defaultMergeMethod: "rebase" }],
      };
      const result = await mergeOptions({ store, projectPath: dir });
      assert.equal(result.ok, true);
      assert.deepEqual(result.methods, ["squash", "merge", "rebase"]);
      // project override (rebase) wins over the app setting (merge).
      assert.equal(result.defaultMethod, "rebase");
    } finally {
      if (prevGh == null) delete process.env.CODER_GH_BIN;
      else process.env.CODER_GH_BIN = prevGh;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
