"use strict";

/**
 * git:turnDiff — checkpoint-to-checkpoint patch (#148).
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
  turnDiff,
  PATCH_TRUNCATE,
} = require("../worktrees.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function makeWorktreeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-turndiff-"));
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
    title: "Turn diff thread",
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

describe("turnDiff", () => {
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

  it("returns the checkpoint-to-checkpoint patch; first diffs against parent", async () => {
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

    const expected1 = git(wt, ["diff", `${c1.sha}^`, c1.sha, "--"]);
    const expected2 = git(wt, ["diff", c1.sha, c2.sha, "--"]);

    const first = await turnDiff({
      store: fx.store,
      threadId: fx.thread.id,
      sha: c1.sha,
    });
    assert.equal(first.truncated, false);
    assert.ok(first.files.length >= 2, "turn 1 added a.txt and b.txt");
    assert.ok(
      first.files.some((f) => f.path === "a.txt"),
      "a.txt in turn 1",
    );
    assert.ok(
      first.files.some((f) => f.path === "b.txt"),
      "b.txt in turn 1",
    );
    assert.equal(first.patch.trim(), expected1.trim());
    assert.ok(first.patch.includes("+one"), "turn 1 patch has added lines");

    const second = await turnDiff({
      store: fx.store,
      threadId: fx.thread.id,
      sha: c2.sha,
    });
    assert.equal(second.truncated, false);
    assert.ok(second.files.some((f) => f.path === "a.txt"));
    assert.ok(second.files.some((f) => f.path === "c.txt"));
    assert.ok(
      !second.files.some((f) => f.path === "b.txt"),
      "b.txt is not part of turn 2",
    );
    assert.equal(second.patch.trim(), expected2.trim());
    assert.ok(second.patch.includes("+four"));
    assert.ok(!second.patch.includes("+beta"));
  });

  it("returns empty without worktree, unknown sha, or unknown thread", async () => {
    fx = await makeWorktreeFixture();
    const empty = { files: [], patch: "", truncated: false };
    const bare = services.createThread(fx.store, {
      projectId: fx.project.id,
      title: "No wt",
    });
    assert.deepEqual(
      await turnDiff({
        store: fx.store,
        threadId: bare.id,
        sha: "deadbeef",
      }),
      empty,
    );
    assert.deepEqual(
      await turnDiff({
        store: fx.store,
        threadId: fx.thread.id,
        sha: "not-a-checkpoint",
      }),
      empty,
    );
    assert.deepEqual(
      await turnDiff({
        store: fx.store,
        threadId: "missing-thread",
        sha: "deadbeef",
      }),
      empty,
    );
    assert.deepEqual(
      await turnDiff({ store: fx.store, threadId: fx.thread.id, sha: "" }),
      empty,
    );
  });

  it("rejects an arbitrary revision that is not a checkpoint", async () => {
    fx = await makeWorktreeFixture();
    const wt = fx.worktreePath;
    fs.writeFileSync(path.join(wt, "a.txt"), "one\n");
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.ok(c1 && c1.sha);
    const parent = git(wt, ["rev-parse", `${c1.sha}^`]).trim();
    const result = await turnDiff({
      store: fx.store,
      threadId: fx.thread.id,
      sha: parent,
    });
    assert.deepEqual(result, { files: [], patch: "", truncated: false });
  });

  it("truncates a patch that exceeds PATCH_TRUNCATE", async () => {
    fx = await makeWorktreeFixture();
    const wt = fx.worktreePath;
    const line = `${"x".repeat(80)}\n`;
    const body = line.repeat(Math.ceil((PATCH_TRUNCATE + 2000) / line.length));
    fs.writeFileSync(path.join(wt, "huge.txt"), body);
    const c1 = await maybeCreateCheckpoint(fx.store, fx.thread.id);
    assert.ok(c1 && c1.sha);
    const result = await turnDiff({
      store: fx.store,
      threadId: fx.thread.id,
      sha: c1.sha,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.patch.length, PATCH_TRUNCATE);
    assert.ok(result.files.some((f) => f.path === "huge.txt"));
  });
});

describe("IPC seam git:turnDiff", () => {
  it("preload exposes turnDiff and main registers the channel", () => {
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
        path.join(os.tmpdir(), `coder-turndiff-ipc-${Date.now()}.json`),
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
      assert.equal(typeof bridge.coder.git.turnDiff, "function");
      assert.ok(handlers.has("git:turnDiff"));
    } finally {
      Module.prototype.require = orig;
      delete require.cache[require.resolve("../ipc.js")];
      delete require.cache[require.resolve("../preload.js")];
    }
  });
});
