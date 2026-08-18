/**
 * Issue #392: Ask-mode IPC seam.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { IPC_HANDLERS } = require("../ipc.js");

describe("ask-mode IPC", () => {
  let tmpDir;
  let store;
  let threadId;
  let broadcasts;
  let ctx;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-ask-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Q&A",
    }).id;
    broadcasts = [];
    ctx = {
      store,
      runner: { startRun: async () => ({ id: "run-stub" }) },
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads:startAsk puts the thread in ask mode and broadcasts", async () => {
    const thread = await IPC_HANDLERS["threads:startAsk"](ctx, { threadId });
    assert.equal(thread.ask, true);
    assert.equal(store.getThread(threadId).ask, true);
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("threads:create with ask:true starts ask and ignores worktree", async () => {
    const projectId = store.getThreads()[0].projectId;
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId,
      title: "About the parser",
      ask: true,
      worktree: true,
      orchestrate: true,
    });
    assert.equal(thread.ask, true);
    assert.notEqual(thread.pendingWorktree, true);
    assert.notEqual(thread.pendingFork, true);
  });

  it("threads:stopAsk clears ask and can arm a worktree", async () => {
    await IPC_HANDLERS["threads:startAsk"](ctx, { threadId });
    const thread = await IPC_HANDLERS["threads:stopAsk"](ctx, {
      threadId,
      worktree: true,
    });
    assert.equal(thread.ask, false);
    assert.equal(thread.pendingWorktree, true);
  });
});
