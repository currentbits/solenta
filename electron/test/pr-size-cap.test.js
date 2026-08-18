/**
 * Issue #402: review-bottleneck guardrail — PR-size cap.
 *
 * createPr refuses diffs larger than settings.prDiffCapLines (default 400,
 * DORA small batches as a product default) BEFORE anything is pushed, with a
 * stable "PR too large:" message the renderer turns into a split/override
 * choice. allowOversize is the explicit human override; null disables.
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
  createPr,
  parseNumstat,
  PR_TOO_LARGE_PREFIX,
} = require("../worktrees.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Minimal fake gh: pr view (from state) + pr create (records into state). */
function writeFakeGh(dir) {
  const bin = path.join(dir, "fake-gh");
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const statePath = process.env.CODER_FAKE_GH_STATE;
function load() { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
function save(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2), "utf8"); }
const args = process.argv.slice(2);
const state = load();
state.calls = state.calls || [];
state.calls.push(args.slice());
state.prs = state.prs || {};
save(state);
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
  process.stdout.write(JSON.stringify({
    number: pr.number,
    url: pr.url,
    state: pr.state || "OPEN",
  }) + "\\n");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = flagValue("--head");
  const number = state.nextNumber || 42;
  state.nextNumber = number + 1;
  const url = "https://github.com/acme/demo/pull/" + number;
  state.prs[head] = { number, url, state: "OPEN" };
  save(state);
  process.stdout.write(url + "\\n");
  process.exit(0);
}
process.stderr.write("fake-gh: unhandled argv " + JSON.stringify(args) + "\\n");
process.exit(2);
`;
  return writeFakeBin(bin, body);
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

describe("pr-size-cap (#402)", () => {
  let tmpDir;
  let store;
  let repo;
  let thread;
  let worktreeBase;
  let statePath;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cap-"));
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
      // already on main/master
    }

    const project = await services.addProject(store, repo);
    thread = services.createThread(store, {
      projectId: project.id,
      title: "Big Feature",
    });

    // Fake GitHub origin: fetch URL is github.com, push URL a local bare repo.
    const bare = path.join(tmpDir, "remote.git");
    git(tmpDir, ["init", "--bare", bare]);
    git(repo, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
    git(repo, ["remote", "set-url", "--push", "origin", bare]);

    const fakeDir = path.join(tmpDir, "fake-bin");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeGh = writeFakeGh(fakeDir);
    statePath = path.join(tmpDir, "gh-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ prs: {}, calls: [], nextNumber: 42 }),
      "utf8",
    );
    process.env.CODER_GH_BIN = fakeGh;
    process.env.CODER_FAKE_GH_STATE = statePath;
  });

  afterEach(() => {
    delete process.env.CODER_GH_BIN;
    delete process.env.CODER_FAKE_GH_STATE;
    try {
      const t = store.getThread(thread.id);
      if (t && t.worktreePath && fs.existsSync(t.worktreePath)) {
        try {
          git(repo, ["worktree", "remove", "--force", t.worktreePath]);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Worktree with one commit adding `lines` lines on the thread branch. */
  function commitLines(lines) {
    const setup = setupWorktree({
      store,
      threadId: thread.id,
      worktreeBase,
      broadcast: () => {},
    });
    const body = Array.from({ length: lines }, (_, i) => `line ${i}`).join(
      "\n",
    );
    fs.writeFileSync(path.join(setup.worktreePath, "big.txt"), body + "\n");
    git(setup.worktreePath, ["add", "big.txt"]);
    git(setup.worktreePath, ["commit", "-m", "big change"]);
    return setup;
  }

  it("defaults to a 400-line cap", () => {
    assert.equal(store.getSettings().prDiffCapLines, 400);
  });

  it("heals junk caps to the default and keeps an explicit null", () => {
    store.setSettings({ prDiffCapLines: 250 });
    assert.equal(store.getSettings().prDiffCapLines, 250);
    store.setSettings({ prDiffCapLines: null });
    assert.equal(store.getSettings().prDiffCapLines, null);
    assert.throws(
      () => store.setSettings({ prDiffCapLines: 0 }),
      /positive integer or null/,
    );
    assert.throws(
      () => store.setSettings({ prDiffCapLines: 12.5 }),
      /positive integer or null/,
    );
  });

  it("blocks an over-cap PR before pushing or calling gh pr create", async () => {
    commitLines(450);
    await assert.rejects(
      createPr({ store, threadId: thread.id, title: "Big", broadcast: () => {} }),
      (err) => {
        assert.ok(err.message.startsWith(`${PR_TOO_LARGE_PREFIX}:`));
        assert.match(err.message, /450 lines changed vs main/);
        assert.match(err.message, /\(cap 400\)/);
        return true;
      },
    );
    const state = readState(statePath);
    assert.equal(
      state.calls.filter((c) => c[0] === "pr" && c[1] === "create").length,
      0,
      "gh pr create must not run for a refused PR",
    );
    // Nothing persisted on the thread either.
    assert.equal(store.getThread(thread.id).prNumber ?? null, null);
  });

  it("allowOversize creates the same PR", async () => {
    commitLines(450);
    const info = await createPr({
      store,
      threadId: thread.id,
      title: "Big",
      allowOversize: true,
      broadcast: () => {},
    });
    assert.equal(info.number, 42);
    assert.equal(info.state, "OPEN");
    assert.equal(store.getThread(thread.id).prNumber, 42);
  });

  it("a null cap disables the guardrail", async () => {
    store.setSettings({ prDiffCapLines: null });
    commitLines(450);
    const info = await createPr({
      store,
      threadId: thread.id,
      title: "Big",
      broadcast: () => {},
    });
    assert.equal(info.number, 42);
  });

  it("honors a custom cap", async () => {
    store.setSettings({ prDiffCapLines: 10 });
    commitLines(20);
    await assert.rejects(
      createPr({ store, threadId: thread.id, title: "Big", broadcast: () => {} }),
      (err) => {
        assert.match(err.message, /^PR too large: 20 lines changed/);
        assert.match(err.message, /\(cap 10\)/);
        return true;
      },
    );
  });

  it("an under-cap PR is created normally", async () => {
    commitLines(50);
    const info = await createPr({
      store,
      threadId: thread.id,
      title: "Small",
      broadcast: () => {},
    });
    assert.equal(info.number, 42);
    assert.equal(info.created, true);
  });
});

describe("parseNumstat", () => {
  it("sums additions and deletions, counting binary files as files only", () => {
    const stats = parseNumstat(
      "10\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n3\t0\tsrc/b.ts\n",
    );
    assert.deepEqual(stats, {
      additions: 13,
      deletions: 2,
      files: 3,
      lines: 15,
    });
  });

  it("returns zeros for empty output", () => {
    assert.deepEqual(parseNumstat(""), {
      additions: 0,
      deletions: 0,
      files: 0,
      lines: 0,
    });
  });
});
