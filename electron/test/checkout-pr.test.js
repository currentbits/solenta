"use strict";

/**
 * Issue #611: check out someone else's PR into a worktree thread.
 * Fake gh via CODER_GH_BIN; origin is a local bare repo rewritten to look
 * like github.com so isGitHubRemote passes and `git fetch origin pull/N/head`
 * still hits disk.
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
  checkoutPr,
  buildPrCheckoutPrompt,
  parsePrCheckoutView,
  FORK_READONLY_NOTE,
  DETACHED_READONLY_NOTE,
} = require("../worktrees.js");
const { writeFakeBin } = require("./support/fakeBin.js");
const { IPC_HANDLERS } = require("../ipc.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const VIEW_SAME = {
  number: 12,
  title: "Add list view",
  body: "Please review the list view.",
  url: "https://github.com/acme/demo/pull/12",
  headRefName: "feat/list",
  isCrossRepository: false,
  state: "OPEN",
};

const VIEW_FORK = {
  ...VIEW_SAME,
  isCrossRepository: true,
  headRefName: "feat/from-fork",
};

const DIFF_TEXT = "diff --git a/pr.txt b/pr.txt\n+hello from the PR\n";

describe("parsePrCheckoutView", () => {
  it("reads title, body, head ref, and fork flag", () => {
    const pr = parsePrCheckoutView(JSON.stringify(VIEW_SAME));
    assert.equal(pr.number, 12);
    assert.equal(pr.title, "Add list view");
    assert.equal(pr.body, "Please review the list view.");
    assert.equal(pr.url, VIEW_SAME.url);
    assert.equal(pr.headRefName, "feat/list");
    assert.equal(pr.isCrossRepository, false);
  });

  it("treats a missing isCrossRepository as same-repo", () => {
    const { isCrossRepository: _drop, ...rest } = VIEW_SAME;
    const pr = parsePrCheckoutView(JSON.stringify(rest));
    assert.equal(pr.isCrossRepository, false);
  });

  it("throws on unparseable or incomplete JSON", () => {
    assert.throws(() => parsePrCheckoutView("nope"), /unparseable PR view JSON/);
    assert.throws(
      () => parsePrCheckoutView(JSON.stringify({ title: "x" })),
      /incomplete PR view JSON/,
    );
  });
});

describe("buildPrCheckoutPrompt", () => {
  it("lays out title, url, body, and diff", () => {
    const text = buildPrCheckoutPrompt(VIEW_SAME, { diff: DIFF_TEXT });
    assert.match(text, /^GitHub pull request #12: Add list view\n/);
    assert.match(text, /https:\/\/github.com\/acme\/demo\/pull\/12/);
    assert.match(text, /Please review the list view/);
    assert.match(text, /## Diff/);
    assert.match(text, /\+hello from the PR/);
    assert.equal(text.includes(FORK_READONLY_NOTE), false);
  });

  it("inserts the fork read-only note when asked", () => {
    const text = buildPrCheckoutPrompt(VIEW_FORK, {
      diff: "",
      readOnlyNote: FORK_READONLY_NOTE,
    });
    assert.ok(text.includes(FORK_READONLY_NOTE));
    assert.equal(text.includes("## Diff"), false);
  });

  it("truncates a huge diff", () => {
    const huge = "x".repeat(200_000);
    const text = buildPrCheckoutPrompt(VIEW_SAME, { diff: huge });
    assert.ok(text.length < 120_000);
    assert.match(text, /truncated/);
  });
});

describe("checkoutPr", () => {
  let tmp;
  let store;
  let worktreeBase;
  let repo;
  let origin;
  let project;
  let prevGh;
  let ghArgsPath;
  let broadcasts;

  function writeFakeGh(opts) {
    const view = opts.view || VIEW_SAME;
    const diff = opts.diff != null ? opts.diff : DIFF_TEXT;
    const checkoutBranch = opts.checkoutBranch || view.headRefName;
    const failCheckout = opts.failCheckout === true;
    const rejectView = opts.rejectView;
    ghArgsPath = path.join(tmp, "gh-args.json");
    const bin = writeFakeBin(
      path.join(tmp, "fake-gh"),
      `
"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
const log = ${JSON.stringify(ghArgsPath)};
let prev = [];
try { prev = JSON.parse(fs.readFileSync(log, "utf8")); } catch {}
prev.push(args);
fs.writeFileSync(log, JSON.stringify(prev));
if (args[0] === "pr" && args[1] === "view") {
  ${
    rejectView
      ? `process.stderr.write(${JSON.stringify(rejectView)} + "\\n"); process.exit(1);`
      : `process.stdout.write(${JSON.stringify(JSON.stringify(view))} + "\\n"); process.exit(0);`
  }
}
if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write(${JSON.stringify(diff)});
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "checkout") {
  ${
    failCheckout
      ? `process.stderr.write("fatal: 'feat/list' is already checked out\\n"); process.exit(1);`
      : `
  const r = spawnSync("git", ["checkout", "-B", ${JSON.stringify(checkoutBranch)}, "origin/" + ${JSON.stringify(checkoutBranch)}], {
    encoding: "utf8",
  });
  if (r.status) {
    process.stderr.write(r.stderr || r.stdout || "checkout failed");
    process.exit(r.status == null ? 1 : r.status);
  }
  process.exit(0);
`
  }
}
process.stderr.write("unhandled " + JSON.stringify(args) + "\\n");
process.exit(2);
`,
    );
    process.env.CODER_GH_BIN = bin;
    return bin;
  }

  function ghCalls() {
    try {
      return JSON.parse(fs.readFileSync(ghArgsPath, "utf8"));
    } catch {
      return [];
    }
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coder-checkout-pr-"));
    store = new Store(path.join(tmp, "store.json"));
    worktreeBase = path.join(tmp, "worktrees");
    broadcasts = [];
    repo = path.join(tmp, "repo");
    origin = path.join(tmp, "origin.git");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);

    git(tmp, ["init", "-q", "--bare", origin]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    git(repo, [
      "config",
      `url.${origin}.insteadOf`,
      "https://github.com/acme/demo.git",
    ]);
    git(repo, ["push", "-q", "origin", "main"]);

    git(repo, ["checkout", "-qb", "feat/list"]);
    fs.writeFileSync(path.join(repo, "pr.txt"), "hello from the PR\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "pr change"]);
    git(repo, ["push", "-q", "origin", "feat/list"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    git(origin, ["update-ref", "refs/pull/12/head", sha]);
    git(repo, ["checkout", "-q", "main"]);

    project = await services.addProject(store, repo);
    prevGh = process.env.CODER_GH_BIN;
    writeFakeGh({ view: VIEW_SAME });
  });

  afterEach(() => {
    if (prevGh == null) delete process.env.CODER_GH_BIN;
    else process.env.CODER_GH_BIN = prevGh;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runCheckout(over) {
    return checkoutPr({
      store,
      projectId: project.id,
      prNumber: 12,
      worktreeBase,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      ...over,
    });
  }

  it("checks out a same-repo PR into a new worktree thread", async () => {
    const result = await runCheckout();
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.readOnly, false);
    assert.equal(result.thread.prNumber, 12);
    assert.equal(result.thread.prUrl, VIEW_SAME.url);
    assert.equal(result.thread.branch, "feat/list");
    assert.ok(result.thread.worktreePath);
    assert.equal(fs.existsSync(result.thread.worktreePath), true);
    assert.equal(
      fs.readFileSync(path.join(result.thread.worktreePath, "pr.txt"), "utf8"),
      "hello from the PR\n",
    );
    assert.match(result.prompt, /GitHub pull request #12/);
    assert.match(result.prompt, /Please review the list view/);
    const calls = ghCalls();
    assert.ok(calls.some((a) => a[0] === "pr" && a[1] === "checkout"));
    assert.equal(store.getThreads().length, 1);
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("reuses an existing thread bound to the same PR", async () => {
    const first = await runCheckout();
    assert.equal(first.ok, true);
    const second = await runCheckout();
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.thread.id, first.thread.id);
    assert.equal(store.getThreads().length, 1);
  });

  it("fork PRs fetch pull/N/head and stay detached, never gh pr checkout", async () => {
    writeFakeGh({ view: VIEW_FORK });
    const result = await runCheckout();
    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.thread.branch, null);
    assert.ok(result.prompt.includes(FORK_READONLY_NOTE));
    const calls = ghCalls();
    assert.equal(
      calls.some((a) => a[0] === "pr" && a[1] === "checkout"),
      false,
      "fork must not gh pr checkout",
    );
    const head = git(result.thread.worktreePath, ["rev-parse", "HEAD"]);
    const expected = git(origin, ["rev-parse", "refs/pull/12/head"]);
    assert.equal(head, expected);
    const branch = git(result.thread.worktreePath, ["branch", "--show-current"]);
    assert.equal(branch, "");
  });

  it("falls back to detached checkout when the PR branch is already in use", async () => {
    const other = path.join(tmp, "other-wt");
    git(repo, ["worktree", "add", other, "feat/list"]);
    writeFakeGh({ view: VIEW_SAME, failCheckout: true });
    const result = await runCheckout();
    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.thread.branch, null);
    assert.ok(result.prompt.includes(DETACHED_READONLY_NOTE));
  });

  it("rolls the thread back when worktree add fails", async () => {
    const result = await runCheckout({ worktreeBase: "" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /worktreeBase/);
    assert.equal(store.getThreads().length, 0);
  });

  it("returns in-band failure for a non-GitHub remote", async () => {
    git(repo, ["remote", "set-url", "origin", "https://gitlab.com/acme/demo.git"]);
    const result = await runCheckout();
    assert.deepEqual(result, { ok: false, reason: "not a GitHub repo" });
    assert.equal(store.getThreads().length, 0);
  });

  it("returns in-band failure when gh is missing", async () => {
    process.env.CODER_GH_BIN = path.join(tmp, "no-such-gh");
    const result = await runCheckout();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "gh missing");
    assert.equal(store.getThreads().length, 0);
  });

  it("returns in-band failure on auth errors", async () => {
    writeFakeGh({
      view: VIEW_SAME,
      rejectView: "error: gh auth login required\n",
    });
    const result = await runCheckout();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "auth");
    assert.equal(store.getThreads().length, 0);
  });

  it("refuses remote projects", async () => {
    services.updateProject(store, project.id, {
      remoteHost: "host.example",
      remotePath: "/src",
    });
    const result = await runCheckout();
    assert.equal(result.ok, false);
    assert.match(result.reason, /remote projects/);
    assert.equal(store.getThreads().length, 0);
  });

  it("IPC git:checkoutPr materializes the worktree", async () => {
    const ctx = {
      store,
      worktreeBase,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    };
    const result = await IPC_HANDLERS["git:checkoutPr"](ctx, {
      projectId: project.id,
      prNumber: 12,
    });
    assert.equal(result.ok, true);
    assert.ok(result.thread.worktreePath);
  });
});
