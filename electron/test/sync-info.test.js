const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseRevListCount, gitSyncInfo } = require("../services.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("parseRevListCount", () => {
  it("parses tab-separated behind/ahead from rev-list --left-right --count", () => {
    assert.deepEqual(parseRevListCount("0\t0"), {
      hasUpstream: true,
      behind: 0,
      ahead: 0,
    });
    assert.deepEqual(parseRevListCount("2\t0"), {
      hasUpstream: true,
      behind: 2,
      ahead: 0,
    });
    assert.deepEqual(parseRevListCount("0\t3"), {
      hasUpstream: true,
      behind: 0,
      ahead: 3,
    });
    assert.deepEqual(parseRevListCount("1\t4"), {
      hasUpstream: true,
      behind: 1,
      ahead: 4,
    });
  });

  it("accepts spaces instead of a tab", () => {
    assert.deepEqual(parseRevListCount("5 6"), {
      hasUpstream: true,
      behind: 5,
      ahead: 6,
    });
  });

  it("returns no-upstream for empty or unparseable output", () => {
    assert.deepEqual(parseRevListCount(""), { hasUpstream: false });
    assert.deepEqual(parseRevListCount("   "), { hasUpstream: false });
    assert.deepEqual(parseRevListCount("garbage"), { hasUpstream: false });
    assert.deepEqual(parseRevListCount("ahead 1"), { hasUpstream: false });
    assert.deepEqual(parseRevListCount(null), { hasUpstream: false });
    assert.deepEqual(parseRevListCount(undefined), { hasUpstream: false });
  });

  it("uses the first line only", () => {
    assert.deepEqual(parseRevListCount("2\t1\nwarning: something"), {
      hasUpstream: true,
      behind: 2,
      ahead: 1,
    });
  });
});

describe("gitSyncInfo", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-sync-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns no-upstream for a missing path", () => {
    assert.deepEqual(gitSyncInfo(path.join(tmp, "nope")), {
      hasUpstream: false,
    });
  });

  it("returns no-upstream for a directory that is not a repo", () => {
    const dir = path.join(tmp, "plain");
    fs.mkdirSync(dir);
    assert.deepEqual(gitSyncInfo(dir), { hasUpstream: false });
  });

  it("returns no-upstream for a repo with no upstream", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "1");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    assert.deepEqual(gitSyncInfo(repo), { hasUpstream: false });
  });

  it("reports ahead/behind against a configured upstream", () => {
    const src = path.join(tmp, "src");
    fs.mkdirSync(src);
    git(src, ["init", "-q", "-b", "main"]);
    git(src, ["config", "user.email", "t@example.com"]);
    git(src, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(src, "a.txt"), "1");
    git(src, ["add", "."]);
    git(src, ["commit", "-qm", "init"]);

    const repo = path.join(tmp, "repo");
    git(tmp, ["clone", "-q", src, repo]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);

    assert.deepEqual(gitSyncInfo(repo), {
      hasUpstream: true,
      ahead: 0,
      behind: 0,
    });

    fs.writeFileSync(path.join(repo, "b.txt"), "2");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "ahead"]);
    assert.deepEqual(gitSyncInfo(repo), {
      hasUpstream: true,
      ahead: 1,
      behind: 0,
    });
  });
});
