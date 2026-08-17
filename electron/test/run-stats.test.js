"use strict";

/**
 * git:runStats + parseShortstat.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const {
  setupWorktree,
  maybeCreateCheckpoint,
  runStats,
  parseShortstat,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeWorktreeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-runstats-"));
  const store = new Store(path.join(tmpDir, "store.json"));
  const worktreeBase = path.join(tmpDir, "worktrees");
  const repo = path.join(tmpDir, "repo");
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
    // already on main
  }
  const project = await services.addProject(store, repo);
  const thread = services.createThread(store, {
    projectId: project.id,
    title: "Run stats thread",
  });
  const setup = setupWorktree({
    store,
    threadId: thread.id,
    worktreeBase,
    broadcast: () => {},
  });
  return {
    tmpDir,
    store,
    project,
    thread: store.getThread(thread.id),
    worktreePath: setup.worktreePath,
  };
}

describe("parseShortstat", () => {
  it("parses files + insertions + deletions", () => {
    assert.deepEqual(
      parseShortstat(" 3 files changed, 24 insertions(+), 9 deletions(-)"),
      { files: 3, additions: 24, deletions: 9 },
    );
  });

  it("parses singular file / insertion / deletion", () => {
    assert.deepEqual(parseShortstat(" 1 file changed, 1 insertion(+)"), {
      files: 1,
      additions: 1,
      deletions: 0,
    });
    assert.deepEqual(parseShortstat(" 1 file changed, 1 deletion(-)"), {
      files: 1,
      additions: 0,
      deletions: 1,
    });
  });

  it("returns null for empty or unparseable input", () => {
    assert.equal(parseShortstat(""), null);
    assert.equal(parseShortstat("   \n"), null);
    assert.equal(parseShortstat("diff --git a/x b/x"), null);
    assert.equal(parseShortstat(null), null);
  });
});

describe("runStats", () => {
  let fx;

  afterEach(() => {
    if (fx) {
      try {
        fs.rmSync(fx.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      fx = null;
    }
  });

  it("returns per-checkpoint-pair shortstat; first diffs against parent", async () => {
    fx = await makeWorktreeFixture();
    const wt = fx.worktreePath;

    fs.writeFileSync(path.join(wt, "a.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(wt, "b.txt"), "beta\n");
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.ok(c1 && c1.sha);

    fs.writeFileSync(path.join(wt, "a.txt"), "one\ntwo\nthree\nfour\n");
    fs.writeFileSync(path.join(wt, "c.txt"), "gamma\n");
    const c2 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.ok(c2 && c2.sha);

    const expected1 = parseShortstat(
      git(wt, ["diff", "--shortstat", `${c1.sha}^`, c1.sha]),
    );
    const expected2 = parseShortstat(
      git(wt, ["diff", "--shortstat", c1.sha, c2.sha]),
    );
    assert.ok(expected1 && expected1.files >= 1);
    assert.ok(expected2 && expected2.files >= 1);

    const stats = await runStats({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.equal(stats.length, 2);
    assert.deepEqual(stats[0], {
      sha: c1.sha,
      turn: 1,
      files: expected1.files,
      additions: expected1.additions,
      deletions: expected1.deletions,
    });
    assert.deepEqual(stats[1], {
      sha: c2.sha,
      turn: 2,
      files: expected2.files,
      additions: expected2.additions,
      deletions: expected2.deletions,
    });
  });

  it("returns [] without worktree, checkpoints, or a known thread", async () => {
    fx = await makeWorktreeFixture();
    const bare = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "No wt",
    });
    assert.deepEqual(
      await runStats({ store: fx.store, threadId: bare.id }),
      [],
    );
    assert.deepEqual(
      await runStats({ store: fx.store, threadId: fx.thread.id }),
      [],
    );
    assert.deepEqual(
      await runStats({ store: fx.store, threadId: "missing-thread" }),
      [],
    );
  });

  it("skips the first checkpoint when parent diff fails", async () => {
    fx = await makeWorktreeFixture();
    const orphan = path.join(fx.tmpDir, "orphan");
    fs.mkdirSync(orphan);
    git(orphan, ["init"]);
    git(orphan, ["config", "user.email", "test@example.com"]);
    git(orphan, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(orphan, "only.txt"), "root\n");
    git(orphan, ["add", "only.txt"]);
    git(orphan, [
      "-c",
      "user.email=coder@local",
      "-c",
      "user.name=Coder",
      "commit",
      "-m",
      "coder-checkpoint: turn 1",
    ]);
    fx.store.updateThread(fx.thread.id, { worktreePath: orphan });
    fx.store.saveNow();

    const stats = await runStats({
      store: fx.store,
      threadId: fx.thread.id,
    });
    assert.deepEqual(stats, []);
  });
});

describe("IPC seam git:runStats", () => {
  it("preload exposes runStats and main registers the channel", () => {
    const Module = require("module");
    const handlers = new Map();
    const bridge = {};
    const electronStub = {
      ipcMain: {
        handle(channel, fn) {
          handlers.set(channel, fn);
        },
      },
      contextBridge: {
        exposeInMainWorld(name, api) {
          bridge[name] = api;
        },
      },
      ipcRenderer: {
        invoke: async () => null,
        on: () => {},
      },
    };
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === "electron") return electronStub;
      return orig.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
      const { registerIpc } = require("../ipc.js");
      const s = new Store(
        path.join(os.tmpdir(), `coder-runstats-ipc-${Date.now()}.json`),
      );
      registerIpc({
        ipcMain: electronStub.ipcMain,
        dialog: {},
        store: s,
        runner: {
          start() {},
          stop() {},
          stopAll() {},
          isRunning: () => false,
        },
        broadcast() {},
        worktreeBase: os.tmpdir(),
        userDataPath: os.tmpdir(),
      });
      require("../preload.js");
      assert.equal(typeof bridge.coder.git.runStats, "function");
      assert.ok(handlers.has("git:runStats"));
    } finally {
      Module.prototype.require = orig;
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
    }
  });
});
