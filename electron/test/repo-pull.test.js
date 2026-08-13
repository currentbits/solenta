const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  repoInfoFromRemote,
  gitRepoInfo,
  summarizePullOutput,
  pullFailureReason,
  gitPull,
} = require("../services.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Minimal repo with one commit and user config. Returns its path. */
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "1");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

describe("repoInfoFromRemote", () => {
  it("parses scp-style ssh remotes", () => {
    assert.deepEqual(repoInfoFromRemote("git@github.com:owner/repo.git"), {
      owner: "owner",
      repo: "repo",
      webUrl: "https://github.com/owner/repo",
    });
  });

  it("parses https remotes with and without .git", () => {
    assert.deepEqual(repoInfoFromRemote("https://github.com/owner/repo.git"), {
      owner: "owner",
      repo: "repo",
      webUrl: "https://github.com/owner/repo",
    });
    assert.deepEqual(repoInfoFromRemote("https://github.com/owner/repo"), {
      owner: "owner",
      repo: "repo",
      webUrl: "https://github.com/owner/repo",
    });
  });

  it("parses ssh:// URLs", () => {
    assert.deepEqual(repoInfoFromRemote("ssh://git@github.com/owner/repo.git"), {
      owner: "owner",
      repo: "repo",
      webUrl: "https://github.com/owner/repo",
    });
  });

  it("derives an https URL for non-GitHub hosts", () => {
    assert.deepEqual(repoInfoFromRemote("git@gitlab.com:owner/repo.git"), {
      owner: "owner",
      repo: "repo",
      webUrl: "https://gitlab.com/owner/repo",
    });
  });

  it("takes the last two segments for nested groups", () => {
    assert.deepEqual(
      repoInfoFromRemote("https://gitlab.com/group/sub/repo.git"),
      {
        owner: "sub",
        repo: "repo",
        webUrl: "https://gitlab.com/sub/repo",
      },
    );
  });

  it("returns null for empty or unparseable input", () => {
    assert.equal(repoInfoFromRemote(""), null);
    assert.equal(repoInfoFromRemote(null), null);
    assert.equal(repoInfoFromRemote(undefined), null);
    assert.equal(repoInfoFromRemote("not a url"), null);
    assert.equal(repoInfoFromRemote("https://github.com/owner"), null);
    assert.equal(repoInfoFromRemote("file:///tmp/repo"), null);
  });
});

describe("gitRepoInfo", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-repoinfo-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok:false for a missing path", () => {
    assert.deepEqual(gitRepoInfo(path.join(tmp, "nope")), { ok: false });
  });

  it("returns ok:false for a directory that is not a repo", () => {
    const dir = path.join(tmp, "plain");
    fs.mkdirSync(dir);
    assert.deepEqual(gitRepoInfo(dir), { ok: false });
  });

  it("returns ok:false for a repo with no origin", () => {
    const repo = initRepo(path.join(tmp, "repo"));
    assert.deepEqual(gitRepoInfo(repo), { ok: false });
  });

  it("returns owner/repo and webUrl for a repo with an origin", () => {
    const repo = initRepo(path.join(tmp, "repo"));
    git(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    assert.deepEqual(gitRepoInfo(repo), {
      ok: true,
      owner: "acme",
      repo: "widgets",
      webUrl: "https://github.com/acme/widgets",
    });
  });
});

describe("summarizePullOutput", () => {
  it("maps up-to-date output", () => {
    assert.equal(summarizePullOutput("Already up to date."), "Already up to date");
    assert.equal(summarizePullOutput("Already up-to-date."), "Already up to date");
  });

  it("maps a fast-forward", () => {
    const out =
      "Updating 3f1a2b4..9c8d7e6\nFast-forward\n src/app.ts | 2 +-\n 1 file changed";
    assert.equal(summarizePullOutput(out), "Fast-forwarded");
  });

  it("falls back to the first line, or up-to-date when empty", () => {
    assert.equal(summarizePullOutput("something unexpected\nmore"), "something unexpected");
    assert.equal(summarizePullOutput(""), "Already up to date");
  });
});

describe("pullFailureReason", () => {
  it("maps a dirty working tree", () => {
    const msg =
      "Command failed: git pull --ff-only\n" +
      "error: Your local changes to the following files would be overwritten by merge:\n" +
      "\tfoo.txt\n" +
      "Please commit your changes or stash them before you merge.\nAborting";
    assert.equal(pullFailureReason(msg), "Working tree has uncommitted changes");
  });

  it("maps a missing upstream", () => {
    const msg =
      "Command failed: git pull --ff-only\n" +
      "There is no tracking information for the current branch.";
    assert.equal(pullFailureReason(msg), "No upstream configured for this branch");
  });

  it("maps a diverged branch", () => {
    const msg =
      "Command failed: git pull --ff-only\n" +
      "hint: You have divergent branches and need to specify how to reconcile them.\n" +
      "fatal: Not possible to fast-forward, aborting.";
    assert.equal(pullFailureReason(msg), "Branch has diverged from upstream");
  });

  it("maps not-a-repo", () => {
    const msg =
      "Command failed: git pull --ff-only\n" +
      "fatal: not a git repository (or any of the parent directories): .git";
    assert.equal(pullFailureReason(msg), "Not a git repository");
  });

  it("falls back to the fatal line, skipping the wrapper line", () => {
    const msg =
      "Command failed: git pull --ff-only\n" +
      "fatal: couldn't find remote ref main";
    assert.equal(pullFailureReason(msg), "fatal: couldn't find remote ref main");
    assert.equal(pullFailureReason(""), "Pull failed");
  });
});

describe("gitPull", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-pull-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Clone of a local source repo, fully offline. */
  function clonePair() {
    const src = initRepo(path.join(tmp, "src"));
    const repo = path.join(tmp, "repo");
    git(tmp, ["clone", "-q", src, repo]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    return { src, repo };
  }

  it("returns not-a-repo for a plain directory", () => {
    const dir = path.join(tmp, "plain");
    fs.mkdirSync(dir);
    assert.deepEqual(gitPull(dir), { ok: false, reason: "Not a git repository" });
  });

  it("reports Already up to date when nothing changed upstream", () => {
    const { repo } = clonePair();
    assert.deepEqual(gitPull(repo), { ok: true, summary: "Already up to date" });
  });

  it("reports Fast-forwarded when upstream advanced", () => {
    const { src, repo } = clonePair();
    fs.writeFileSync(path.join(src, "b.txt"), "2");
    git(src, ["add", "."]);
    git(src, ["commit", "-qm", "upstream work"]);
    assert.deepEqual(gitPull(repo), { ok: true, summary: "Fast-forwarded" });
  });

  it("maps a dirty tree conflict to an in-band reason", () => {
    const { src, repo } = clonePair();
    fs.writeFileSync(path.join(src, "a.txt"), "upstream");
    git(src, ["add", "."]);
    git(src, ["commit", "-qm", "upstream edit"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "local edit");
    const res = gitPull(repo);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "Working tree has uncommitted changes");
  });

  it("maps a diverged branch to an in-band reason", () => {
    const { src, repo } = clonePair();
    fs.writeFileSync(path.join(src, "b.txt"), "upstream");
    git(src, ["add", "."]);
    git(src, ["commit", "-qm", "upstream work"]);
    fs.writeFileSync(path.join(repo, "c.txt"), "local");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "local work"]);
    const res = gitPull(repo);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "Branch has diverged from upstream");
  });

  it("maps a branch without upstream to an in-band reason", () => {
    const repo = initRepo(path.join(tmp, "solo"));
    const res = gitPull(repo);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "No upstream configured for this branch");
  });
});
