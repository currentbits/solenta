/**
 * Issue #471: `/btw` IPC seam.
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

describe("btw IPC", () => {
  let tmpDir;
  let store;
  let threadId;
  let broadcasts;
  let ctx;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-btw-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Work",
    }).id;
    broadcasts = [];
    ctx = {
      store,
      runner: {
        startRun: async () => ({ id: "run-stub" }),
        startBtw: async (input) => services.addBtw(store, input).thread,
        cancelBtw: (input) => services.dismissBtw(store, input),
        promoteBtw: (input) => services.promoteBtw(store, input),
      },
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads:btw opens a running card and broadcasts", async () => {
    const thread = await IPC_HANDLERS["threads:btw"](ctx, {
      threadId,
      question: "where is createThread",
    });
    assert.equal(thread.btw.length, 1);
    assert.equal(thread.btw[0].status, "running");
    assert.equal(thread.btw[0].question, "where is createThread");
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });

  it("threads:dismissBtw drops the card", async () => {
    const opened = await IPC_HANDLERS["threads:btw"](ctx, {
      threadId,
      question: "where",
    });
    const thread = await IPC_HANDLERS["threads:dismissBtw"](ctx, {
      threadId,
      id: opened.btw[0].id,
    });
    assert.equal(thread.btw, undefined);
  });

  it("threads:promoteBtw queues a follow-up", async () => {
    const opened = await IPC_HANDLERS["threads:btw"](ctx, {
      threadId,
      question: "where",
    });
    const thread = await IPC_HANDLERS["threads:promoteBtw"](ctx, {
      threadId,
      id: opened.btw[0].id,
    });
    assert.equal(thread.btw, undefined);
    assert.match(thread.queued.prompt, /where/);
  });
});
