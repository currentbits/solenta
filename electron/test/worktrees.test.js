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
  defaultBranch,
  diff,
  commit,
  mergeWorktree,
  conflictContext,
  removeWorktree,
  push,
  createPr,
  prStatus,
  parsePrJson,
  isGitHubRemote,
  gitTry,
  gitTryAsync,
} = require("../worktrees.js");
const { reviewItineraryPathFor } = require("../reviewItinerary.js");
const ssh = require("../ssh.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Write a fake `gh` that reads CODER_FAKE_GH_STATE (JSON file) for scenario +
 * in-memory PR map. No network. Mirrors the CODER_*_BIN fakes used for AI CLIs.
 * @param {string} dir
 * @returns {string} path to the fake binary
 */
function writeFakeGh(dir) {
  const bin = path.join(dir, "fake-gh");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

const statePath = process.env.CODER_FAKE_GH_STATE;
if (!statePath) {
  process.stderr.write("fake-gh: CODER_FAKE_GH_STATE not set\\n");
  process.exit(2);
}

function load() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}
function save(s) {
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2), "utf8");
}

const args = process.argv.slice(2);
const state = load();
state.calls = state.calls || [];
state.calls.push(args.slice());
state.prs = state.prs || {};
save(state);

const scenario = state.scenario || "success";

if (scenario === "timeout") {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    /* busy-wait so execFileSync timeout kills us */
  }
  process.exit(0);
}

if (scenario === "create-fail" && args[0] === "pr" && args[1] === "create") {
  process.stderr.write(
    "GraphQL: GitHub Actions is not permitted to create or approve pull requests\\n",
  );
  process.exit(1);
}

if (scenario === "http-404") {
  process.stderr.write(
    "HTTP 404: Not Found (https://api.github.com/repos/owner/repo/pulls)\\n",
  );
  process.exit(1);
}

if (scenario === "auth-fail") {
  process.stderr.write(
    "To get started with GitHub CLI, please run:  gh auth login\\n" +
      "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\\n",
  );
  process.exit(1);
}

function flagValue(name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
}

if (args[0] === "pr" && args[1] === "view") {
  const branch = args[2];
  const pr = state.prs[branch];
  if (!pr) {
    process.stderr.write("no pull requests found for branch \\"" + branch + "\\"\\n");
    process.exit(1);
  }
  const jsonFields = (flagValue("--json") || "number,url,state").split(",");
  if (scenario === "unknown-json-field") {
    const extra = jsonFields.filter(function (f) {
      return f !== "number" && f !== "url" && f !== "state";
    });
    if (extra.length) {
      process.stderr.write("Unknown JSON field: \\"" + extra[0] + "\\"\\n");
      process.exit(1);
    }
  }
  const out = {
    number: pr.number,
    url: pr.url,
    state: pr.state || "OPEN",
  };
  for (const f of jsonFields) {
    if (f === "title" && pr.title != null) out.title = pr.title;
    if (f === "additions" && pr.additions != null) out.additions = pr.additions;
    if (f === "deletions" && pr.deletions != null) out.deletions = pr.deletions;
    if (f === "changedFiles" && pr.changedFiles != null) {
      out.changedFiles = pr.changedFiles;
    }
  }
  process.stdout.write(JSON.stringify(out) + "\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  const head = flagValue("--head");
  const title = flagValue("--title") || "";
  const base = flagValue("--base") || "main";
  const draft = args.includes("--draft");
  if (state.prs[head] && (state.prs[head].state || "OPEN") === "OPEN") {
    process.stderr.write("a pull request for branch \\"" + head + "\\" already exists\\n");
    process.exit(1);
  }
  state.createCount = (state.createCount || 0) + 1;
  const number = state.nextNumber || 42;
  state.nextNumber = number + 1;
  const url =
    "https://github.com/acme/demo/pull/" + number;
  state.prs[head] = {
    number,
    url,
    state: "OPEN",
    title,
    base,
    draft: Boolean(draft),
  };
  save(state);
  process.stdout.write(url + "\\n");
  process.exit(0);
}

process.stderr.write("fake-gh: unhandled argv " + JSON.stringify(args) + "\\n");
process.exit(2);
`;
  return writeFakeBin(bin, body);
}

/**
 * Prepare a worktree with one commit ahead of main and a fake GitHub origin.
 * @returns {{ setup: object, bare: string, statePath: string, fakeGh: string }}
 */
function preparePrFixture(ctx) {
  const { store, thread, worktreeBase, repo, tmpDir } = ctx;
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
  // Fetch URL is github.com so isGitHubRemote accepts it; push URL is a local
  // bare repo so push() works offline without network.
  git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  git(repo, ["remote", "set-url", "--push", "origin", bare]);

  const fakeDir = path.join(tmpDir, "fake-bin");
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeGh = writeFakeGh(fakeDir);
  const statePath = path.join(tmpDir, "gh-state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({ scenario: "success", prs: {}, calls: [], nextNumber: 42 }),
    "utf8",
  );
  process.env.CODER_GH_BIN = fakeGh;
  process.env.CODER_FAKE_GH_STATE = statePath;

  return { setup, bare, statePath, fakeGh };
}

describe("worktrees", () => {
  let tmpDir;
  let store;
  let repo;
  let project;
  let thread;
  let worktreeBase;
  let broadcasts;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wt-"));
    store = new Store(path.join(tmpDir, "store.json"));
    worktreeBase = path.join(tmpDir, "worktrees");
    broadcasts = [];

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);

    // Ensure a real branch name for worktree base
    try {
      git(repo, ["checkout", "-b", "main"]);
    } catch {
      // already on main/master
    }

    project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "My Feature Work",
    });
  });

  afterEach(() => {
    // Remove worktrees first so rm of tmpDir succeeds
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

  it("setupWorktree creates branch and worktree, is idempotent", async () => {
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.ok(updated.worktreePath);
    assert.ok(fs.existsSync(updated.worktreePath));
    assert.ok(fs.existsSync(path.join(updated.worktreePath, "README.md")));
    assert.ok(updated.branch);
    assert.match(updated.branch, /^coder\//);
    assert.ok(updated.branch.includes(thread.id.slice(0, 6)));
    assert.match(updated.branch, /my-feature-work/i);

    const branchInWt = git(updated.worktreePath, ["branch", "--show-current"]);
    assert.equal(branchInWt, updated.branch);

    assert.ok(broadcasts.some((b) => b.ch === "threads:changed"));

    const again = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });
    assert.equal(again.worktreePath, updated.worktreePath);
    assert.equal(again.branch, updated.branch);
  });

  it("diff reports modified and untracked files with patch", async () => {
    const updated = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    fs.writeFileSync(
      path.join(updated.worktreePath, "README.md"),
      "hello\nworld\n",
    );
    fs.writeFileSync(
      path.join(updated.worktreePath, "new-file.txt"),
      "line1\nline2\nline3\n",
    );
    // Untracked directory: -uall must list the inner file individually,
    // never a collapsed "?? newdir/" row.
    fs.mkdirSync(path.join(updated.worktreePath, "newdir"));
    fs.writeFileSync(
      path.join(updated.worktreePath, "newdir", "inner.txt"),
      "a\nb\n",
    );

    const result = await diff({ store, threadId: thread.id });

    assert.ok(Array.isArray(result.files));
    assert.equal(typeof result.patch, "string");
    assert.equal(typeof result.truncated, "boolean");

    // Exact count: README.md + new-file.txt + newdir/inner.txt. Phantom or
    // mangled rows (e.g. "EADME.md" from trimming the XY column) must fail.
    assert.equal(
      result.files.length,
      3,
      `files=${JSON.stringify(result.files)}`,
    );
    const paths = result.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["README.md", "new-file.txt", "newdir/inner.txt"]);

    const readme = result.files.find((f) => f.path === "README.md");
    assert.ok(readme, `files=${JSON.stringify(result.files)}`);
    assert.match(readme.status, /M/);
    assert.ok(readme.additions >= 1);

    const untracked = result.files.find((f) => f.path === "new-file.txt");
    assert.ok(untracked, `files=${JSON.stringify(result.files)}`);
    assert.equal(untracked.status, "??");
    assert.equal(untracked.additions, 3);
    assert.equal(untracked.deletions, 0);

    const inner = result.files.find((f) => f.path === "newdir/inner.txt");
    assert.ok(inner, `files=${JSON.stringify(result.files)}`);
    assert.equal(inner.status, "??");
    assert.equal(inner.additions, 2);

    assert.ok(
      result.patch.includes("README.md") || result.patch.includes("hello"),
      `patch should mention README changes: ${result.patch.slice(0, 200)}`,
    );
  });

  it("diff does not call execFileSync", async () => {
    setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(store.getThread(thread.id).worktreePath, "x.txt"), "x\n");
    ssh.setExecFileSync(() => {
      throw new Error("execFileSync should not run on the diff path");
    });
    try {
      const result = await diff({ store, threadId: thread.id });
      assert.ok(Array.isArray(result.files));
    } finally {
      ssh.setExecFileSync(null);
    }
  });

  it("gitTryAsync matches gitTry failure shape including error and timedOut", async () => {
    const missing = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(missing);
    const sync = gitTry(missing, ["status"]);
    const asyncResult = await gitTryAsync(missing, ["status"]);
    assert.equal(sync.ok, false);
    assert.equal(asyncResult.ok, false);
    assert.equal(typeof asyncResult.stdout, "string");
    assert.equal(typeof asyncResult.stderr, "string");
    assert.equal(typeof asyncResult.combined, "string");
    assert.ok(asyncResult.error, "failed gitTryAsync must carry the raw error");
    assert.equal(asyncResult.timedOut, false);
  });

  it("gitTryAsync sets timedOut when the child is killed by timeout", async () => {
    // cat-file --batch waits on stdin, so the timeout is what kills it.
    const result = await gitTryAsync(repo, ["cat-file", "--batch"], {
      timeout: 80,
    });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.error);
  });

  it("mergeWorktree commits worktree changes, squash-merges, cleans up", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    fs.writeFileSync(path.join(wtPath, "feature.txt"), "from worktree\n");

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(merged.worktreePath, null);
    assert.equal(merged.branch, null);
    assert.ok(fs.existsSync(path.join(repo, "feature.txt")));
    assert.equal(
      fs.readFileSync(path.join(repo, "feature.txt"), "utf8"),
      "from worktree\n",
    );
    assert.ok(!fs.existsSync(wtPath));

    const branches = git(repo, ["branch"]);
    assert.ok(
      !branches.includes(branch),
      `branch ${branch} should be deleted: ${branches}`,
    );

    const log = git(repo, ["log", "-1", "--oneline"]);
    assert.match(log, /Merge worktree/i);
    assert.match(log, new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const stored = store.getThread(thread.id);
    assert.equal(stored.worktreePath, null);
    assert.equal(stored.branch, null);
    assert.ok(broadcasts.some((b) => b.ch === "threads:changed"));
  });

  it("defaultBranch falls back to main when the project checkout is detached", () => {
    const sha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "--detach", sha]);
    assert.equal(git(repo, ["branch", "--show-current"]), "");
    assert.equal(defaultBranch(repo), "main");
  });

  it("mergeWorktree lands on main when the project checkout is detached", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "from worktree\n");
    git(repo, ["checkout", "--detach", "HEAD"]);
    assert.equal(git(repo, ["branch", "--show-current"]), "");

    mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.equal(git(repo, ["branch", "--show-current"]), "main");
    assert.ok(fs.existsSync(path.join(repo, "feature.txt")));
    assert.match(git(repo, ["log", "main", "-1", "--oneline"]), /Merge worktree/i);
  });

  it("mergeWorktree follows main into another worktree when the project is detached", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "from worktree\n");
    const nightly = path.join(tmpDir, "nightly");
    git(repo, ["checkout", "--detach", "HEAD"]);
    git(repo, ["worktree", "add", nightly, "main"]);
    assert.equal(git(repo, ["branch", "--show-current"]), "");
    assert.equal(git(nightly, ["branch", "--show-current"]), "main");

    mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.ok(fs.existsSync(path.join(nightly, "feature.txt")));
    assert.match(git(nightly, ["log", "-1", "--oneline"]), /Merge worktree/i);
    assert.equal(git(nightly, ["branch", "--show-current"]), "main");
    assert.ok(!fs.existsSync(setup.worktreePath));
  });

  it("mergeWorktree without baseBranch lands on main when the checkout is on a feature (#187/#770)", async () => {
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
    assert.equal(
      git(repo, ["log", "main", "-1", "--format=%s"]),
      git(repo, ["log", "-1", "--format=%s"]),
    );
    assert.match(git(repo, ["log", "main", "-1", "--oneline"]), /Merge worktree/i);
    assert.equal(
      git(repo, ["rev-parse", "coder/feature-base"]),
      featureHead,
      "feature branch HEAD must stay put",
    );
    assert.equal(git(repo, ["branch", "--show-current"]), "main");
  });

  it("mergeWorktree with baseBranch=feature lands there, not on main (#187)", async () => {
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
    assert.equal(store.getThread(stacked.id).baseBranch, "stacked-base");

    const setup = setupWorktree({
      store,
      threadId: stacked.id,
      worktreeBase,
      broadcast: () => {},
    });
    assert.equal(
      git(setup.worktreePath, ["rev-parse", "HEAD"]),
      baseHead,
      "worktree must start at the recorded base",
    );
    fs.writeFileSync(path.join(setup.worktreePath, "api.txt"), "api\n");

    mergeWorktree({
      store,
      threadId: stacked.id,
      broadcast: () => {},
    });

    assert.equal(git(repo, ["rev-parse", "main"]), mainHead, "main HEAD unchanged");
    assert.equal(git(repo, ["branch", "--show-current"]), "stacked-base");
    assert.equal(
      fs.readFileSync(path.join(repo, "api.txt"), "utf8"),
      "api\n",
    );
    assert.equal(
      fs.readFileSync(path.join(repo, "schema.txt"), "utf8"),
      "schema\n",
    );
    assert.match(
      git(repo, ["log", "stacked-base", "-1", "--oneline"]),
      /Merge worktree/i,
    );
  });

  it("changing baseBranch after create retargets merge (#187)", async () => {
    git(repo, ["checkout", "-b", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const baseHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);
    const mainHead = git(repo, ["rev-parse", "HEAD"]);

    assert.equal(store.getThread(thread.id).baseBranch, null);
    services.setBaseBranch(store, {
      threadId: thread.id,
      baseBranch: "stacked-base",
    });
    assert.equal(store.getThread(thread.id).baseBranch, "stacked-base");

    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "api.txt"), "api\n");

    mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.equal(git(repo, ["rev-parse", "main"]), mainHead, "main HEAD unchanged");
    assert.equal(git(repo, ["branch", "--show-current"]), "stacked-base");
    assert.equal(fs.readFileSync(path.join(repo, "api.txt"), "utf8"), "api\n");
    assert.notEqual(git(repo, ["rev-parse", "stacked-base"]), baseHead);
    assert.match(
      git(repo, ["log", "stacked-base", "-1", "--oneline"]),
      /Merge worktree/i,
    );
  });

  it("clearing baseBranch returns merge to the repo default (#187)", async () => {
    git(repo, ["checkout", "-b", "stacked-base"]);
    fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
    git(repo, ["add", "schema.txt"]);
    git(repo, ["commit", "-m", "schema"]);
    const stackedHead = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const stacked = services.createThread(store, {
      projectId: project.id,
      title: "Then clear",
      baseBranch: "stacked-base",
    });
    services.setBaseBranch(store, {
      threadId: stacked.id,
      baseBranch: null,
    });
    assert.equal(store.getThread(stacked.id).baseBranch, null);

    const setup = setupWorktree({
      store,
      threadId: stacked.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "api.txt"), "api\n");

    mergeWorktree({
      store,
      threadId: stacked.id,
      broadcast: () => {},
    });

    assert.equal(
      git(repo, ["rev-parse", "stacked-base"]),
      stackedHead,
      "cleared base must leave stacked-base put",
    );
    assert.equal(git(repo, ["branch", "--show-current"]), "main");
    assert.ok(fs.existsSync(path.join(repo, "api.txt")));
    assert.match(git(repo, ["log", "main", "-1", "--oneline"]), /Merge worktree/i);
  });

  /**
   * #791 fixture: origin/main gains one commit the local main lacks. Returns
   * the dir that holds `main` checked out (the project checkout sits on a
   * feature branch, like the nightly/release worktree did in #770).
   * @param {{ originFile?: string, originContent?: string }} [opts]
   */
  function mainBehindOrigin(opts = {}) {
    const originFile = opts.originFile ?? "stale.txt";
    const originContent = opts.originContent ?? "on origin only\n";
    const bare = path.join(tmpDir, "origin.git");
    git(tmpDir, ["init", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);

    fs.writeFileSync(path.join(repo, originFile), originContent);
    git(repo, ["add", originFile]);
    git(repo, ["commit", "-m", "origin moves ahead"]);
    git(repo, ["push", "origin", "main"]);
    git(repo, ["reset", "--hard", "HEAD~1"]);

    git(repo, ["checkout", "-b", "coder/feature-on-checkout"]);
    const nightly = path.join(tmpDir, "nightly");
    git(repo, ["worktree", "add", nightly, "main"]);
    assert.equal(git(nightly, ["branch", "--show-current"]), "main");
    return nightly;
  }

  it("mergeWorktree fast-forwards a behind-only main instead of refusing (#791)", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "unique-791.txt"), "wt\n");
    const nightly = mainBehindOrigin();

    mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.ok(fs.existsSync(path.join(nightly, "stale.txt")), "origin work");
    assert.ok(
      fs.existsSync(path.join(nightly, "unique-791.txt")),
      "worktree work landed",
    );
    assert.match(
      git(nightly, ["log", "main", "-1", "--format=%s"]),
      /Merge worktree/i,
    );
    assert.match(
      git(nightly, ["log", "main", "--format=%s"]),
      /origin moves ahead/,
      "fast-forward pulled origin's commit in",
    );
  });

  it("mergeWorktree auto-merges a diverged main when the merge is clean (#791)", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "unique-791.txt"), "wt\n");
    const nightly = mainBehindOrigin();
    // Local main diverges: one commit upstream never saw, disjoint file.
    fs.writeFileSync(path.join(nightly, "local-only.txt"), "local work\n");
    git(nightly, ["add", "local-only.txt"]);
    git(nightly, ["commit", "-m", "local main moves ahead"]);

    mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.ok(fs.existsSync(path.join(nightly, "stale.txt")), "origin work");
    assert.ok(
      fs.existsSync(path.join(nightly, "local-only.txt")),
      "local-only commit survives the sync",
    );
    assert.ok(
      fs.existsSync(path.join(nightly, "unique-791.txt")),
      "worktree work landed",
    );
    assert.match(
      git(nightly, ["log", "main", "--format=%s"]),
      /Merge remote-tracking branch 'origin\/main'/,
      "sync merge commit",
    );
    assert.match(
      git(nightly, ["log", "main", "-1", "--format=%s"]),
      /Merge worktree/i,
    );
  });

  it("mergeWorktree still refuses a diverged main when the merge would conflict (#791)", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "unique-791.txt"), "wt\n");
    const nightly = mainBehindOrigin({
      originFile: "README.md",
      originContent: "origin rewrote it\n",
    });
    fs.writeFileSync(path.join(nightly, "README.md"), "local rewrote it\n");
    git(nightly, ["add", "README.md"]);
    git(nightly, ["commit", "-m", "local main moves ahead"]);
    const mainHead = git(nightly, ["rev-parse", "main"]);

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          broadcast: () => {},
        }),
      /behind origin\/main.*reset --hard/s,
    );
    assert.ok(fs.existsSync(setup.worktreePath), "worktree stays on refuse");
    assert.equal(
      git(nightly, ["rev-parse", "main"]),
      mainHead,
      "failed sync leaves main put",
    );
    assert.equal(
      git(nightly, ["status", "--porcelain", "-uno"]),
      "",
      "failed sync leaves no merge state behind",
    );
  });

  it("mergeWorktree refuses to sync a dirty checkout holding main (#791)", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "unique-791.txt"), "wt\n");
    const nightly = mainBehindOrigin();
    fs.writeFileSync(path.join(nightly, "README.md"), "uncommitted edit\n");
    const mainHead = git(nightly, ["rev-parse", "main"]);

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          broadcast: () => {},
        }),
      /behind origin\/main/i,
    );
    assert.ok(fs.existsSync(setup.worktreePath), "worktree stays on refuse");
    assert.equal(git(nightly, ["rev-parse", "main"]), mainHead);
    assert.equal(
      fs.readFileSync(path.join(nightly, "README.md"), "utf8"),
      "uncommitted edit\n",
      "uncommitted work untouched",
    );
  });

  it("mergeWorktree with intoPath still lands on that checkout's branch (#770)", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "worker.txt"), "worker\n");
    const lead = path.join(tmpDir, "lead");
    git(repo, ["worktree", "add", "-b", "coder/lead", lead]);
    const leadHead = git(lead, ["rev-parse", "HEAD"]);
    const mainHead = git(repo, ["rev-parse", "main"]);

    mergeWorktree({
      store,
      threadId: thread.id,
      intoPath: lead,
      broadcast: () => {},
    });

    assert.equal(
      fs.readFileSync(path.join(lead, "worker.txt"), "utf8"),
      "worker\n",
    );
    assert.equal(git(repo, ["rev-parse", "main"]), mainHead);
    assert.notEqual(git(lead, ["rev-parse", "HEAD"]), leadHead);
    assert.match(git(lead, ["log", "-1", "--oneline"]), /Merge worktree/i);
  });

  it("mergeWorktree with paths commits only those files and refuses leftovers", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const wtPath = setup.worktreePath;
    fs.writeFileSync(path.join(wtPath, "keep.txt"), "keep\n");
    fs.writeFileSync(path.join(wtPath, "skip.txt"), "skip\n");

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          paths: ["keep.txt"],
          broadcast: () => {},
        }),
      /Uncommitted files remain/i,
    );

    assert.ok(fs.existsSync(wtPath), "worktree stays until leftovers are gone");
    assert.match(git(wtPath, ["status", "--porcelain"]), /skip\.txt/);
    assert.doesNotMatch(git(wtPath, ["status", "--porcelain"]), /keep\.txt/);
    assert.match(
      git(wtPath, ["log", "-1", "--format=%s"]),
      /coder: session changes/,
    );
    assert.equal(
      git(wtPath, ["show", "--name-only", "--format=", "HEAD"]),
      "keep.txt",
    );
    assert.equal(
      fs.existsSync(path.join(repo, "keep.txt")),
      false,
      "squash merge did not run",
    );
  });

  it("mergeWorktree with empty paths refuses leftover dirty files", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const wtPath = setup.worktreePath;
    fs.writeFileSync(path.join(wtPath, "keep.txt"), "keep\n");
    fs.writeFileSync(path.join(wtPath, "skip.txt"), "skip\n");
    commit({
      store,
      threadId: thread.id,
      message: "feat: keep",
      paths: ["keep.txt"],
    });

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          paths: [],
          broadcast: () => {},
        }),
      /Uncommitted files remain/i,
    );
    assert.ok(fs.existsSync(wtPath));
    assert.match(git(wtPath, ["status", "--porcelain"]), /skip\.txt/);
    assert.equal(git(wtPath, ["log", "-1", "--format=%s"]), "feat: keep");
  });

  it("mergeWorktree with every dirty path squash-merges", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const wtPath = setup.worktreePath;
    fs.writeFileSync(path.join(wtPath, "keep.txt"), "keep\n");
    fs.writeFileSync(path.join(wtPath, "skip.txt"), "skip\n");

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      paths: ["keep.txt", "skip.txt"],
      broadcast: () => {},
    });

    assert.equal(merged.worktreePath, null);
    assert.ok(fs.existsSync(path.join(repo, "keep.txt")));
    assert.ok(fs.existsSync(path.join(repo, "skip.txt")));
    assert.ok(!fs.existsSync(wtPath));
  });

  it("mergeWorktree ignores an unrelated untracked file in the project (#198)", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "work\n");
    // A scratch file nobody committed used to block every merge, forever.
    fs.writeFileSync(path.join(repo, "tweet-0.4.0.txt"), "draft\n");

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.equal(merged.worktreePath, null);
    assert.ok(fs.existsSync(path.join(repo, "feature.txt")));
    assert.ok(fs.existsSync(path.join(repo, "tweet-0.4.0.txt")), "left alone");
  });

  it("mergeWorktree refuses when an untracked project file is in the way", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "work\n");
    fs.writeFileSync(path.join(repo, "feature.txt"), "mine, unstaged\n");

    assert.throws(
      () => mergeWorktree({ store, threadId: thread.id, broadcast: () => {} }),
      (err) => {
        // Our pre-check, not git's mid-merge complaint about phantom conflicts.
        assert.match(
          err.message,
          /^Untracked files in the project checkout would be overwritten[\s\S]*feature\.txt/,
        );
        return true;
      },
    );
    assert.equal(
      fs.readFileSync(path.join(repo, "feature.txt"), "utf8"),
      "mine, unstaged\n",
      "the untracked file must survive the refusal",
    );
  });

  it("mergeWorktree stashes and restores tracked project changes", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "work\n");
    // Someone's uncommitted edit in the shared checkout used to block every
    // thread's merge until it was stashed by hand.
    fs.writeFileSync(path.join(repo, "README.md"), "edited in project\n");

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });

    assert.equal(merged.worktreePath, null);
    assert.ok(fs.existsSync(path.join(repo, "feature.txt")), "merge landed");
    assert.equal(
      fs.readFileSync(path.join(repo, "README.md"), "utf8"),
      "edited in project\n",
      "the project's own changes come back after the merge",
    );
    assert.equal(git(repo, ["stash", "list"]), "", "and are not left stashed");
  });

  it("mergeWorktree restores the stash when the merge fails", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    // Conflicting edits to the same file, plus an unrelated dirty project file.
    fs.writeFileSync(path.join(setup.worktreePath, "conflict.txt"), "theirs\n");
    git(setup.worktreePath, ["add", "conflict.txt"]);
    git(setup.worktreePath, ["commit", "-m", "theirs"]);
    fs.writeFileSync(path.join(repo, "conflict.txt"), "ours\n");
    git(repo, ["add", "conflict.txt"]);
    git(repo, ["commit", "-m", "ours"]);
    fs.writeFileSync(path.join(repo, "README.md"), "edited in project\n");

    assert.throws(() =>
      mergeWorktree({ store, threadId: thread.id, broadcast: () => {} }),
    );
    assert.equal(
      fs.readFileSync(path.join(repo, "README.md"), "utf8"),
      "edited in project\n",
      "a failed merge must not eat the project's uncommitted work",
    );
    assert.equal(git(repo, ["stash", "list"]), "");
  });

  it("mergeWorktree rejects on conflict and restores clean project checkout", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    // Divergent edits to the same file in project and worktree
    fs.writeFileSync(path.join(repo, "README.md"), "project side\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "project edit"]);

    fs.writeFileSync(path.join(setup.worktreePath, "README.md"), "worktree side\n");
    git(setup.worktreePath, ["add", "README.md"]);
    git(setup.worktreePath, ["commit", "-m", "worktree edit"]);

    assert.throws(
      () =>
        mergeWorktree({
          store,
          threadId: thread.id,
          broadcast: () => {},
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /MERGE_CONFLICT:/);
        assert.match(err.message, /README\.md/);
        assert.match(err.message, /resolve/i);
        return true;
      },
    );

    // Project checkout restored clean
    const status = git(repo, ["status", "--porcelain"]);
    assert.equal(status, "", `project should be clean after abort: ${status}`);
    assert.equal(
      fs.readFileSync(path.join(repo, "README.md"), "utf8"),
      "project side\n",
    );

    // Worktree still present (nothing force-removed on failure)
    const still = store.getThread(thread.id);
    assert.ok(still.worktreePath);
    assert.ok(fs.existsSync(still.worktreePath));

    // Conflict was replayed into the worktree, so it is resolvable there
    const wtConflicts = git(setup.worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    assert.equal(wtConflicts, "README.md");
    assert.match(
      fs.readFileSync(path.join(setup.worktreePath, "README.md"), "utf8"),
      /<<<<<<</,
    );

    // Merging again without resolving refuses instead of committing markers
    assert.throws(
      () => mergeWorktree({ store, threadId: thread.id, broadcast: () => {} }),
      (err) => {
        assert.match(err.message, /MERGE_CONFLICT:[\s\S]*README\.md/);
        return true;
      },
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(repo, "README.md"), "utf8"),
      /<<<<<<</,
    );

    // Resolve in the worktree, then merge again: lands on the project branch
    fs.writeFileSync(
      path.join(setup.worktreePath, "README.md"),
      "resolved\n",
    );
    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });
    assert.equal(merged.worktreePath, null);
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "resolved\n");
  });

  it("mergeWorktree auto-combines an itinerary-only conflict", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    fs.mkdirSync(path.join(repo, ".solenta"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".solenta", "review-itinerary.json"),
      `${JSON.stringify({
        version: 1,
        readOrder: ["tests"],
        chunks: [{ area: "main-side", rationale: "from main", risks: [] }],
        risks: ["main risk"],
      })}\n`,
    );
    git(repo, ["add", ".solenta/review-itinerary.json"]);
    git(repo, ["commit", "-m", "main itinerary"]);

    fs.mkdirSync(path.join(setup.worktreePath, ".solenta"), { recursive: true });
    fs.writeFileSync(
      path.join(setup.worktreePath, ".solenta", "review-itinerary.json"),
      `${JSON.stringify({
        version: 1,
        readOrder: ["critical", "impl"],
        chunks: [{ area: "thread-side", rationale: "from thread", risks: [] }],
        risks: ["thread risk"],
      })}\n`,
    );
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "landed\n");
    git(setup.worktreePath, ["add", "-A"]);
    git(setup.worktreePath, ["commit", "-m", "thread itinerary + feature"]);

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });
    assert.equal(merged.worktreePath, null);
    assert.equal(
      fs.readFileSync(path.join(repo, "feature.txt"), "utf8"),
      "landed\n",
    );
    const landed = JSON.parse(
      fs.readFileSync(path.join(repo, ".solenta", "review-itinerary.json"), "utf8"),
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(repo, ".solenta", "review-itinerary.json"), "utf8"),
      /<<<<<<</,
    );
    const areas = landed.chunks.map((c) => c.area);
    assert.ok(areas.includes("thread-side") || areas.includes("main-side"));
    assert.ok(landed.risks.length >= 1);
  });

  it("mergeWorktree lands two per-thread itineraries without a conflict (#621)", async () => {
    const other = services.createThread(store, {
      projectId: project.id,
      title: "Other Feature Work",
    });
    const a = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const b = setupWorktree({
      store,
      threadId: other.id,
      worktreeBase,
      broadcast: () => {},
    });

    const writeItinerary = (dir, threadId, area, feature) => {
      const rel = reviewItineraryPathFor(threadId);
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(
        path.join(dir, rel),
        `${JSON.stringify({
          version: 1,
          readOrder: ["impl"],
          chunks: [{ area, rationale: area, risks: [] }],
          risks: [`${area} risk`],
        })}\n`,
      );
      fs.writeFileSync(path.join(dir, feature), `${area}\n`);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-m", `${area} itinerary`]);
    };

    writeItinerary(a.worktreePath, thread.id, "thread-a", "a.txt");
    writeItinerary(b.worktreePath, other.id, "thread-b", "b.txt");

    const first = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });
    assert.equal(first.worktreePath, null);
    const second = mergeWorktree({
      store,
      threadId: other.id,
      broadcast: () => {},
    });
    assert.equal(second.worktreePath, null);

    const aFile = path.join(repo, reviewItineraryPathFor(thread.id));
    const bFile = path.join(repo, reviewItineraryPathFor(other.id));
    const aLanded = JSON.parse(fs.readFileSync(aFile, "utf8"));
    const bLanded = JSON.parse(fs.readFileSync(bFile, "utf8"));
    assert.doesNotMatch(fs.readFileSync(aFile, "utf8"), /<<<<<<</);
    assert.doesNotMatch(fs.readFileSync(bFile, "utf8"), /<<<<<<</);
    assert.deepEqual(
      aLanded.chunks.map((c) => c.area),
      ["thread-a"],
    );
    assert.deepEqual(
      bLanded.chunks.map((c) => c.area),
      ["thread-b"],
    );
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "thread-a\n");
    assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "thread-b\n");
  });

  it("mergeWorktree auto-resolves a generated AGENTS.md alongside the itinerary", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const marker = require("../configDoctor.js").GENERATED_MARKER;
    const itinerary = (area) =>
      `${JSON.stringify({
        version: 1,
        readOrder: ["impl"],
        chunks: [{ area, rationale: area, risks: [] }],
        risks: [],
      })}\n`;

    const seed = (dir, side) => {
      fs.mkdirSync(path.join(dir, ".solenta"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".solenta", "review-itinerary.json"),
        itinerary(side),
      );
      fs.writeFileSync(
        path.join(dir, "AGENTS.md"),
        `# solenta\n\n${marker}\n\n## ${side} conventions\n`,
      );
    };

    seed(repo, "main-side");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main generated docs"]);

    seed(setup.worktreePath, "thread-side");
    fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "landed\n");
    git(setup.worktreePath, ["add", "-A"]);
    git(setup.worktreePath, ["commit", "-m", "thread generated docs + feature"]);

    const merged = mergeWorktree({
      store,
      threadId: thread.id,
      broadcast: () => {},
    });
    assert.equal(merged.worktreePath, null);
    assert.equal(
      fs.readFileSync(path.join(repo, "feature.txt"), "utf8"),
      "landed\n",
    );
    const agents = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    assert.doesNotMatch(agents, /<<<<<<</);
    assert.ok(agents.includes(marker));
  });

  it("mergeWorktree still refuses a hand-authored AGENTS.md conflict", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    // No generated-by marker: a human wrote this, so it needs a human resolve.
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "# main rules\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "main agents"]);

    fs.writeFileSync(path.join(setup.worktreePath, "AGENTS.md"), "# thread rules\n");
    git(setup.worktreePath, ["add", "-A"]);
    git(setup.worktreePath, ["commit", "-m", "thread agents"]);

    assert.throws(
      () => mergeWorktree({ store, threadId: thread.id, broadcast: () => {} }),
      (err) => {
        assert.match(err.message, /MERGE_CONFLICT:[\s\S]*AGENTS\.md/);
        return true;
      },
    );
  });

  it("conflictContext returns unmerged files with marker snippets (#163)", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    fs.writeFileSync(path.join(repo, "README.md"), "project side\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "project edit"]);

    fs.writeFileSync(path.join(setup.worktreePath, "README.md"), "worktree side\n");
    git(setup.worktreePath, ["add", "README.md"]);
    git(setup.worktreePath, ["commit", "-m", "worktree edit"]);

    assert.throws(() =>
      mergeWorktree({ store, threadId: thread.id, broadcast: () => {} }),
    );

    const ctx = conflictContext({ store, threadId: thread.id });
    assert.equal(ctx.branch, setup.branch);
    assert.equal(ctx.baseBranch, "main");
    assert.equal(ctx.omitted, 0);
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.files[0].path, "README.md");
    assert.equal(ctx.files[0].binary, false);
    assert.equal(ctx.files[0].truncated, false);
    assert.match(ctx.files[0].content, /<<<<<<</);
    assert.match(ctx.files[0].content, /project side|worktree side/);
  });

  it("conflictContext caps a huge conflicted file and notes omitted extras", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    const pad = "x".repeat(20_000);
    fs.writeFileSync(path.join(repo, "README.md"), `project\n${pad}\n`);
    fs.writeFileSync(path.join(repo, "extra.txt"), "project extra\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "project edit"]);

    fs.writeFileSync(path.join(setup.worktreePath, "README.md"), `worktree\n${pad}\n`);
    fs.writeFileSync(path.join(setup.worktreePath, "extra.txt"), "worktree extra\n");
    git(setup.worktreePath, ["add", "-A"]);
    git(setup.worktreePath, ["commit", "-m", "worktree edit"]);

    assert.throws(() =>
      mergeWorktree({ store, threadId: thread.id, broadcast: () => {} }),
    );

    const ctx = conflictContext({
      store,
      threadId: thread.id,
      maxFileBytes: 64,
      maxFiles: 1,
    });
    assert.equal(ctx.files.length, 1);
    assert.ok(ctx.files[0].truncated);
    assert.ok(ctx.files[0].content.length <= 64);
    assert.equal(ctx.omitted, 1);
  });

  it("conflictContext rejects an unknown thread", () => {
    assert.throws(
      () => conflictContext({ store, threadId: "missing" }),
      /Unknown thread/,
    );
  });

  it("removeWorktree without force rejects dirty worktree with WORKTREE_DIRTY", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });

    fs.writeFileSync(path.join(setup.worktreePath, "dirty.txt"), "uncommitted\n");

    assert.throws(
      () =>
        removeWorktree({
          store,
          threadId: thread.id,
          force: false,
          broadcast: () => {},
        }),
      (err) => {
        assert.ok(err instanceof Error);
        // Renderer detects via message.includes("WORKTREE_DIRTY:") after IPC wrap
        assert.ok(
          err.message.includes("WORKTREE_DIRTY:"),
          `message must contain WORKTREE_DIRTY: got ${err.message}`,
        );
        assert.ok(
          err.message.includes("dirty.txt"),
          `message must list the lost file: ${err.message}`,
        );
        return true;
      },
    );

    assert.ok(fs.existsSync(setup.worktreePath));
    const still = store.getThread(thread.id);
    assert.equal(still.worktreePath, setup.worktreePath);
  });

  it("removeWorktree without force rejects when project HEAD is detached", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    // Commit on worktree so there is something to lose
    fs.writeFileSync(path.join(wtPath, "orphan-me.txt"), "would be lost\n");
    git(wtPath, ["add", "orphan-me.txt"]);
    git(wtPath, ["commit", "-m", "unmerged feature"]);

    // Detach project checkout HEAD so default branch cannot be determined
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "--detach", headSha]);
    assert.equal(git(repo, ["branch", "--show-current"]), "");

    assert.throws(
      () =>
        removeWorktree({
          store,
          threadId: thread.id,
          force: false,
          broadcast: () => {},
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("WORKTREE_DIRTY:"),
          `must contain WORKTREE_DIRTY: got ${err.message}`,
        );
        // Lists recent commits on the branch (cannot prove merged)
        assert.ok(
          /unmerged:|unmerged feature|orphan/i.test(err.message),
          `must list branch commits: ${err.message}`,
        );
        return true;
      },
    );

    assert.ok(fs.existsSync(wtPath), "worktree must remain after reject");
    const still = store.getThread(thread.id);
    assert.equal(still.worktreePath, wtPath);
    assert.equal(still.branch, branch);

    // force still works while detached
    const removed = removeWorktree({
      store,
      threadId: thread.id,
      force: true,
      broadcast: () => {},
    });
    assert.equal(removed.worktreePath, null);
    assert.equal(removed.branch, null);
    assert.ok(!fs.existsSync(wtPath));
  });

  it("removeWorktree with force succeeds on dirty worktree", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    fs.writeFileSync(path.join(wtPath, "dirty.txt"), "uncommitted\n");

    const removed = removeWorktree({
      store,
      threadId: thread.id,
      force: true,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(removed.worktreePath, null);
    assert.equal(removed.branch, null);
    assert.ok(!fs.existsSync(wtPath));
    const branches = git(repo, ["branch"]);
    assert.ok(!branches.includes(branch));
    assert.ok(broadcasts.some((b) => b.ch === "threads:changed"));
  });

  it("removeWorktree on clean fully-merged worktree succeeds without force", async () => {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const branch = setup.branch;
    const wtPath = setup.worktreePath;

    // Commit a change in worktree, regular-merge into project so
    // defaultBranch..branch is empty (fully merged), leave worktree in place
    fs.writeFileSync(path.join(wtPath, "merged.txt"), "already merged\n");
    git(wtPath, ["add", "merged.txt"]);
    git(wtPath, ["commit", "-m", "feature"]);

    git(repo, ["merge", "--no-ff", "-m", "merge feature", branch]);

    const removed = removeWorktree({
      store,
      threadId: thread.id,
      force: false,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.equal(removed.worktreePath, null);
    assert.equal(removed.branch, null);
    assert.ok(!fs.existsSync(wtPath));
    const branches = git(repo, ["branch"]);
    assert.ok(!branches.includes(branch));
  });

  it("push happy path: local bare remote receives the branch", async () => {
    const bare = path.join(tmpDir, "remote.git");
    git(tmpDir, ["init", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);

    // Ensure named branch
    let branch;
    try {
      branch = git(repo, ["branch", "--show-current"]);
    } catch {
      branch = "";
    }
    if (!branch) {
      git(repo, ["checkout", "-b", "main"]);
      branch = "main";
    }

    broadcasts = [];
    const result = push({
      store,
      threadId: thread.id,
      broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
    });

    assert.deepEqual(result, { remote: "origin", branch });
    assert.ok(broadcasts.some((b) => b.ch === "threads:changed"));

    // Bare repo should list the branch
    const refs = git(bare, ["branch"]);
    assert.ok(
      refs.includes(branch) || refs.includes(`* ${branch}`),
      `bare branches: ${refs}`,
    );
  });

  it("push rejects when no origin remote is configured", async () => {
    // Fresh repo from beforeEach has no origin
    assert.throws(
      () => push({ store, threadId: thread.id, broadcast: () => {} }),
      /No git remote configured for this project\./,
    );
  });

  it("push failure surfaces stderr tail", async () => {
    // Point origin at a path that cannot accept pushes
    const badRemote = path.join(tmpDir, "does-not-exist-remote");
    git(repo, ["remote", "add", "origin", badRemote]);

    assert.throws(
      () => push({ store, threadId: thread.id, broadcast: () => {} }),
      (err) => {
        assert.ok(err && err.message);
        assert.ok(err.message.length <= 300 || err.message.length > 0);
        // Must carry real git failure text (not a generic wrapper)
        assert.ok(
          /denied|exist|repository|remote|fatal|error|Could not|does not/i.test(
            err.message,
          ),
          `unexpected push error: ${err.message}`,
        );
        return true;
      },
    );
  });

  describe("createPr / prStatus", () => {
    const prevGhBin = process.env.CODER_GH_BIN;
    const prevGhState = process.env.CODER_FAKE_GH_STATE;

    afterEach(() => {
      if (prevGhBin === undefined) delete process.env.CODER_GH_BIN;
      else process.env.CODER_GH_BIN = prevGhBin;
      if (prevGhState === undefined) delete process.env.CODER_FAKE_GH_STATE;
      else process.env.CODER_FAKE_GH_STATE = prevGhState;
    });

    it("isGitHubRemote accepts github hosts and rejects gitlab/local", async () => {
      assert.equal(isGitHubRemote("https://github.com/acme/demo.git"), true);
      assert.equal(isGitHubRemote("git@github.com:acme/demo.git"), true);
      assert.equal(
        isGitHubRemote("ssh://git@github.com/acme/demo.git"),
        true,
      );
      assert.equal(isGitHubRemote("https://gitlab.com/acme/demo.git"), false);
      assert.equal(isGitHubRemote("git@gitlab.com:acme/demo.git"), false);
      assert.equal(isGitHubRemote("/tmp/local-bare.git"), false);
      assert.equal(isGitHubRemote("ssh://git@git.example.com/acme/demo"), false);
    });

    it("happy path: creates PR, persists prNumber/prUrl, broadcasts", async () => {
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      broadcasts = [];

      const info = await createPr({
        store,
        threadId: thread.id,
        title: "Ship feature",
        body: "Adds feature.txt",
        draft: false,
        broadcast: (ch, payload) => broadcasts.push({ ch, payload }),
      });

      assert.equal(info.number, 42);
      assert.equal(info.url, "https://github.com/acme/demo/pull/42");
      assert.equal(info.state, "OPEN");
      assert.equal(info.branch, setup.branch);
      assert.equal(info.created, true);

      const stored = store.getThread(thread.id);
      assert.equal(stored.prNumber, 42);
      assert.equal(stored.prUrl, "https://github.com/acme/demo/pull/42");
      assert.equal(stored.prState, "OPEN");

      assert.ok(
        broadcasts.some((b) => b.ch === "threads:changed"),
        "must broadcast threads:changed after create",
      );
      const listed = broadcasts.find((b) => b.ch === "threads:changed");
      const row = listed.payload.find((t) => t.id === thread.id);
      assert.ok(row, "broadcast payload must include the thread");
      assert.equal(row.prNumber, 42);
      assert.equal(row.prUrl, "https://github.com/acme/demo/pull/42");
      assert.equal(row.prState, "OPEN");

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(state.createCount, 1);
      assert.ok(
        state.calls.some((c) => c[0] === "pr" && c[1] === "create"),
        `expected pr create call: ${JSON.stringify(state.calls)}`,
      );
      const createCall = state.calls.find(
        (c) => c[0] === "pr" && c[1] === "create",
      );
      assert.ok(createCall.includes("--base"));
      assert.ok(createCall.includes("--head"));
      assert.ok(createCall.includes("--title"));
      assert.ok(createCall.includes("Ship feature"));
      assert.ok(createCall.includes(setup.branch));
      const baseIdx = createCall.indexOf("--base");
      assert.equal(
        createCall[baseIdx + 1],
        "main",
        "unset baseBranch still targets the repo default",
      );
    });

    it("createPr with baseBranch=feature uses that --base (#187)", async () => {
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
      const { setup, statePath } = preparePrFixture({
        store,
        thread: stacked,
        worktreeBase,
        repo,
        tmpDir,
      });

      const info = await createPr({
        store,
        threadId: stacked.id,
        title: "API on schema",
        broadcast: () => {},
      });
      assert.equal(info.created, true);

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const createCall = state.calls.find(
        (c) => c[0] === "pr" && c[1] === "create",
      );
      assert.ok(createCall, `expected pr create call: ${JSON.stringify(state.calls)}`);
      const baseIdx = createCall.indexOf("--base");
      assert.equal(createCall[baseIdx + 1], "stacked-base");
      assert.equal(state.prs[setup.branch].base, "stacked-base");
    });

    it("changing baseBranch after create retargets createPr (#187)", async () => {
      git(repo, ["checkout", "-b", "stacked-base"]);
      fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
      git(repo, ["add", "schema.txt"]);
      git(repo, ["commit", "-m", "schema"]);
      git(repo, ["checkout", "main"]);

      services.setBaseBranch(store, {
        threadId: thread.id,
        baseBranch: "stacked-base",
      });
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });

      const info = await createPr({
        store,
        threadId: thread.id,
        title: "API on schema",
        broadcast: () => {},
      });
      assert.equal(info.created, true);

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const createCall = state.calls.find(
        (c) => c[0] === "pr" && c[1] === "create",
      );
      assert.ok(createCall, `expected pr create call: ${JSON.stringify(state.calls)}`);
      const baseIdx = createCall.indexOf("--base");
      assert.equal(createCall[baseIdx + 1], "stacked-base");
      assert.equal(state.prs[setup.branch].base, "stacked-base");
    });

    it("clearing baseBranch returns createPr to the repo default (#187)", async () => {
      git(repo, ["checkout", "-b", "stacked-base"]);
      fs.writeFileSync(path.join(repo, "schema.txt"), "schema\n");
      git(repo, ["add", "schema.txt"]);
      git(repo, ["commit", "-m", "schema"]);
      git(repo, ["checkout", "main"]);

      const stacked = services.createThread(store, {
        projectId: project.id,
        title: "Then clear PR",
        baseBranch: "stacked-base",
      });
      services.setBaseBranch(store, {
        threadId: stacked.id,
        baseBranch: null,
      });
      const { setup, statePath } = preparePrFixture({
        store,
        thread: stacked,
        worktreeBase,
        repo,
        tmpDir,
      });

      await createPr({
        store,
        threadId: stacked.id,
        title: "Back to main",
        broadcast: () => {},
      });

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const createCall = state.calls.find(
        (c) => c[0] === "pr" && c[1] === "create",
      );
      assert.ok(createCall, `expected pr create call: ${JSON.stringify(state.calls)}`);
      const baseIdx = createCall.indexOf("--base");
      assert.equal(createCall[baseIdx + 1], "main");
      assert.equal(state.prs[setup.branch].base, "main");
    });

    it("idempotency: second createPr returns same number with created:false", async () => {
      preparePrFixture({ store, thread, worktreeBase, repo, tmpDir });

      const first = await createPr({
        store,
        threadId: thread.id,
        title: "Ship feature",
        broadcast: () => {},
      });
      assert.equal(first.created, true);
      assert.equal(first.number, 42);

      const second = await createPr({
        store,
        threadId: thread.id,
        title: "Ship feature again",
        broadcast: () => {},
      });
      assert.equal(second.created, false);
      assert.equal(second.number, 42);
      assert.equal(second.url, first.url);

      const stored = store.getThread(thread.id);
      assert.equal(stored.prNumber, 42);
      assert.equal(stored.prUrl, first.url);

      const state = JSON.parse(
        fs.readFileSync(process.env.CODER_FAKE_GH_STATE, "utf8"),
      );
      // Only one successful create; second path uses view only.
      assert.equal(state.createCount, 1);
    });

    it("prStatus returns live PR or null when none", async () => {
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });

      assert.equal(await prStatus({ store, threadId: thread.id }), null);

      await createPr({
        store,
        threadId: thread.id,
        title: "Ship",
        broadcast: () => {},
      });

      const live = await prStatus({ store, threadId: thread.id });
      assert.ok(live);
      assert.equal(live.number, 42);
      assert.equal(live.branch, setup.branch);
      assert.equal(live.created, false);
      assert.equal(live.state, "OPEN");
      // prStatus success persists last-known state on the thread.
      assert.equal(store.getThread(thread.id).prState, "OPEN");
      assert.equal(store.getThread(thread.id).prNumber, 42);
      assert.equal(
        store.getThread(thread.id).prUrl,
        "https://github.com/acme/demo/pull/42",
      );

      // Mutate fake state to MERGED so prStatus is live, not store-cached.
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.prs[setup.branch].state = "MERGED";
      fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
      const merged = await prStatus({ store, threadId: thread.id });
      assert.equal(merged.state, "MERGED");
      assert.equal(
        store.getThread(thread.id).prState,
        "MERGED",
        "prStatus must persist the live state, including MERGED",
      );
    });

    it("prStatus with a pre-existing PR persists prState without createPr", async () => {
      // Seed a PR in the fake gh state, then only call prStatus.
      const { setup } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      // preparePrFixture leaves the branch ahead but no PR; create then clear
      // store fields so prStatus is the only path that can re-stamp them.
      await createPr({
        store,
        threadId: thread.id,
        title: "Ship",
        broadcast: () => {},
      });
      store.updateThread(thread.id, {
        prNumber: null,
        prUrl: null,
        prState: null,
      });
      store.saveNow();
      assert.equal(store.getThread(thread.id).prState, null);

      const live = await prStatus({ store, threadId: thread.id });
      assert.ok(live);
      assert.equal(live.number, 42);
      assert.equal(live.branch, setup.branch);
      assert.equal(store.getThread(thread.id).prState, "OPEN");
      assert.equal(store.getThread(thread.id).prNumber, 42);
      assert.equal(
        store.getThread(thread.id).prUrl,
        "https://github.com/acme/demo/pull/42",
      );
    });

    it("parsePrJson passes through optional title and diff stats", async () => {
      const info = parsePrJson(
        JSON.stringify({
          number: 574,
          url: "https://github.com/acme/demo/pull/574",
          state: "OPEN",
          title: "Cache provider usage",
          additions: 464,
          deletions: 63,
          changedFiles: 17,
        }),
        "feat/cache",
        false,
      );
      assert.equal(info.number, 574);
      assert.equal(info.title, "Cache provider usage");
      assert.equal(info.additions, 464);
      assert.equal(info.deletions, 63);
      assert.equal(info.changedFiles, 17);
      assert.equal(info.branch, "feat/cache");
      assert.equal(info.created, false);
    });

    it("parsePrJson passes through mergeable and baseRefName", async () => {
      const info = parsePrJson(
        JSON.stringify({
          number: 49,
          url: "https://github.com/acme/demo/pull/49",
          state: "OPEN",
          mergeable: "CONFLICTING",
          baseRefName: "main",
        }),
        "feat/demo",
        false,
      );
      assert.equal(info.mergeable, "CONFLICTING");
      assert.equal(info.baseRefName, "main");
    });

    it("parsePrJson omits extra fields when they are absent", async () => {
      const info = parsePrJson(
        JSON.stringify({
          number: 1,
          url: "https://github.com/acme/demo/pull/1",
          state: "OPEN",
        }),
        "feat/x",
        true,
      );
      assert.equal(info.number, 1);
      assert.equal(info.title, undefined);
      assert.equal(info.additions, undefined);
      assert.equal(info.deletions, undefined);
      assert.equal(info.changedFiles, undefined);
      assert.equal(info.mergeable, undefined);
      assert.equal(info.baseRefName, undefined);
      assert.equal(info.created, true);
    });

    it("prStatus returns enriched title and diff stats when gh provides them", async () => {
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      await createPr({
        store,
        threadId: thread.id,
        title: "Ship",
        broadcast: () => {},
      });
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.prs[setup.branch].title = "Cache provider usage";
      state.prs[setup.branch].additions = 464;
      state.prs[setup.branch].deletions = 63;
      state.prs[setup.branch].changedFiles = 17;
      fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

      const live = await prStatus({ store, threadId: thread.id });
      assert.equal(live.title, "Cache provider usage");
      assert.equal(live.additions, 464);
      assert.equal(live.deletions, 63);
      assert.equal(live.changedFiles, 17);

      const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const statusView = [...after.calls]
        .reverse()
        .find((c) => c[0] === "pr" && c[1] === "view");
      assert.ok(statusView, "prStatus must call gh pr view");
      assert.ok(
        statusView.includes(
          "number,url,state,title,additions,deletions,changedFiles,mergeable,baseRefName",
        ),
        `interactive prStatus must request enriched fields, got: ${JSON.stringify(statusView)}`,
      );
    });

    it("prStatus falls back to number,url,state when gh rejects unknown JSON fields", async () => {
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      await createPr({
        store,
        threadId: thread.id,
        title: "Ship",
        broadcast: () => {},
      });
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.scenario = "unknown-json-field";
      state.prs[setup.branch].title = "Should not be returned";
      state.prs[setup.branch].additions = 10;
      fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

      const live = await prStatus({ store, threadId: thread.id });
      assert.ok(live);
      assert.equal(live.number, 42);
      assert.equal(live.branch, setup.branch);
      assert.equal(live.title, undefined);
      assert.equal(live.additions, undefined);

      const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const views = after.calls.filter((c) => c[0] === "pr" && c[1] === "view");
      const statusViews = views.filter((c) =>
        String(c[2]) === setup.branch,
      );
      // Interactive path: enriched first, then minimal retry.
      const lastTwo = statusViews.slice(-2);
      assert.ok(
        lastTwo.some((c) =>
          c.includes(
            "number,url,state,title,additions,deletions,changedFiles,mergeable,baseRefName",
          ),
        ),
        "first retry attempt must request enriched fields",
      );
      assert.ok(
        lastTwo.some((c) => {
          const json = c[c.indexOf("--json") + 1];
          return json === "number,url,state";
        }),
        "fallback must retry with the minimal field set",
      );
    });

    it("a merged PR does not block opening a follow-up PR", async () => {
      // gh pr view returns CLOSED and MERGED PRs too. Short-circuiting on any
      // of them leaves a branch permanently unable to open another PR.
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      const first = await createPr({
        store,
        threadId: thread.id,
        title: "First",
        broadcast: () => {},
      });
      assert.equal(first.created, true);

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.prs[setup.branch].state = "MERGED";
      fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

      const second = await createPr({
        store,
        threadId: thread.id,
        title: "Follow-up",
        broadcast: () => {},
      });
      assert.equal(
        second.created,
        true,
        "a merged predecessor must not be returned as the current PR",
      );
    });

    it("a create failure is not masked by a stale merged PR on the branch", async () => {
      // The race path re-views after a failed create. If it returns any PR
      // state, a MERGED predecessor turns a real failure into a silent success:
      // createPr resolves, gh's error is swallowed, and the store is stamped
      // with a PR that is not the one the user asked for.
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      await createPr({
        store,
        threadId: thread.id,
        title: "First",
        broadcast: () => {},
      });

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.prs[setup.branch].state = "MERGED";
      state.scenario = "create-fail";
      fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

      await assert.rejects(
        async () =>
          await createPr({
            store,
            threadId: thread.id,
            title: "Follow-up",
            broadcast: () => {},
          }),
        /not permitted|gh pr create failed/i,
        "a failed create must surface, not return the old merged PR",
      );
    });

    it("an HTTP 404 from gh is a failure, not 'no PR exists'", async () => {
      // A bare /not found/ match also catches "HTTP 404: Not Found", which is a
      // deleted or renamed repo or a token without scope. Reading that as "no
      // PR yet" hides the real error behind a spurious create attempt.
      const { statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.scenario = "http-404";
      fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

      await assert.rejects(
        () => prStatus({ store, threadId: thread.id }),
        /404|not found/i,
        "prStatus must surface the 404 rather than returning null",
      );
    });

    it("gh missing (ENOENT) -> GitHub CLI (gh) is not installed", async () => {
      preparePrFixture({ store, thread, worktreeBase, repo, tmpDir });
      process.env.CODER_GH_BIN = path.join(tmpDir, "definitely-missing-gh");

      await assert.rejects(
        async () =>
          await createPr({
            store,
            threadId: thread.id,
            title: "X",
            broadcast: () => {},
          }),
        (err) => {
          assert.equal(err.message, "GitHub CLI (gh) is not installed");
          return true;
        },
      );
    });

    it("gh not authenticated surfaces gh's own message (tail-trimmed)", async () => {
      const { statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ scenario: "auth-fail", prs: {}, calls: [] }),
        "utf8",
      );

      await assert.rejects(
        async () =>
          await createPr({
            store,
            threadId: thread.id,
            title: "X",
            broadcast: () => {},
          }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            /gh auth login|GH_TOKEN|authentication/i.test(err.message),
            `expected auth message, got: ${err.message}`,
          );
          assert.ok(
            err.message.length <= 300,
            `must be tail-trimmed <=300, got ${err.message.length}`,
          );
          return true;
        },
      );
    });

    it("no origin remote message survives (via push)", async () => {
      // Worktree + commit but no origin at all.
      const setup = setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase,
        broadcast: () => {},
      });
      fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feat\n");
      git(setup.worktreePath, ["add", "feature.txt"]);
      git(setup.worktreePath, ["commit", "-m", "feature"]);

      // Fake gh present so we fail on remote, not on ENOENT.
      const fakeDir = path.join(tmpDir, "fake-bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      process.env.CODER_GH_BIN = writeFakeGh(fakeDir);
      process.env.CODER_FAKE_GH_STATE = path.join(tmpDir, "gh-state.json");
      fs.writeFileSync(
        process.env.CODER_FAKE_GH_STATE,
        JSON.stringify({ scenario: "success", prs: {} }),
        "utf8",
      );

      await assert.rejects(
        async () =>
          await createPr({
            store,
            threadId: thread.id,
            title: "X",
            broadcast: () => {},
          }),
        /No git remote configured for this project\./,
      );
    });

    it("remote is not GitHub refuses before shelling to gh", async () => {
      const setup = setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase,
        broadcast: () => {},
      });
      fs.writeFileSync(path.join(setup.worktreePath, "feature.txt"), "feat\n");
      git(setup.worktreePath, ["add", "feature.txt"]);
      git(setup.worktreePath, ["commit", "-m", "feature"]);

      const bare = path.join(tmpDir, "remote.git");
      git(tmpDir, ["init", "--bare", bare]);
      git(repo, ["remote", "add", "origin", bare]);

      const fakeDir = path.join(tmpDir, "fake-bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      const fakeGh = writeFakeGh(fakeDir);
      const statePath = path.join(tmpDir, "gh-state.json");
      fs.writeFileSync(
        statePath,
        JSON.stringify({ scenario: "success", prs: {}, calls: [] }),
        "utf8",
      );
      process.env.CODER_GH_BIN = fakeGh;
      process.env.CODER_FAKE_GH_STATE = statePath;

      await assert.rejects(
        async () =>
          await createPr({
            store,
            threadId: thread.id,
            title: "X",
            broadcast: () => {},
          }),
        /not a GitHub repository/i,
      );

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(
        (state.calls || []).length,
        0,
        "must not invoke gh for non-GitHub remotes",
      );
    });

    it("branch with no commits ahead of base refuses without PR attempt", async () => {
      // setupWorktree alone: branch tip == main, zero commits ahead.
      setupWorktree({
        store,
        threadId: thread.id,
        worktreeBase,
        broadcast: () => {},
      });
      git(repo, [
        "remote",
        "add",
        "origin",
        "https://github.com/acme/demo.git",
      ]);

      const fakeDir = path.join(tmpDir, "fake-bin");
      fs.mkdirSync(fakeDir, { recursive: true });
      const fakeGh = writeFakeGh(fakeDir);
      const statePath = path.join(tmpDir, "gh-state.json");
      fs.writeFileSync(
        statePath,
        JSON.stringify({ scenario: "success", prs: {}, calls: [] }),
        "utf8",
      );
      process.env.CODER_GH_BIN = fakeGh;
      process.env.CODER_FAKE_GH_STATE = statePath;

      await assert.rejects(
        async () =>
          await createPr({
            store,
            threadId: thread.id,
            title: "X",
            broadcast: () => {},
          }),
        /no commits ahead/i,
      );

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(
        (state.calls || []).length,
        0,
        "must not invoke gh when there is nothing to propose",
      );
    });

    it("gh timeout is bounded with a clear error", async () => {
      const { statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ scenario: "timeout", prs: {}, calls: [] }),
        "utf8",
      );

      await assert.rejects(
        async () =>
          await createPr({
            store,
            threadId: thread.id,
            title: "X",
            broadcast: () => {},
          }),
        (err) => {
          assert.match(err.message, /timed out after 30s/i);
          return true;
        },
      );
    });

    it("draft flag is forwarded to gh pr create", async () => {
      const { setup, statePath } = preparePrFixture({
        store,
        thread,
        worktreeBase,
        repo,
        tmpDir,
      });

      await createPr({
        store,
        threadId: thread.id,
        title: "Draft PR",
        body: "wip",
        draft: true,
        broadcast: () => {},
      });

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const createCall = state.calls.find(
        (c) => c[0] === "pr" && c[1] === "create",
      );
      assert.ok(createCall, "expected create call");
      assert.ok(createCall.includes("--draft"), `args=${createCall}`);
      assert.equal(state.prs[setup.branch].draft, true);
    });
  });
});
