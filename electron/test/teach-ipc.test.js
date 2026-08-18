/**
 * Issue #373: teach-mode IPC seam.
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

describe("teach-mode IPC", () => {
  let tmpDir;
  let store;
  let threadId;
  let broadcasts;
  let startRunCalls;
  let ctx;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-teach-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Learn the parser",
    }).id;
    broadcasts = [];
    startRunCalls = [];
    ctx = {
      store,
      runner: {
        startRun: async (input) => {
          startRunCalls.push(input);
          return { id: "run-stub" };
        },
      },
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads:startTeach puts the thread in teach mode and broadcasts", async () => {
    const thread = await IPC_HANDLERS["threads:startTeach"](ctx, { threadId });
    assert.ok(thread.teach);
    assert.equal(thread.teach.autonomy, "hint");
    assert.equal(thread.teach.reviewsPassed, 0);
    assert.equal(store.getThread(threadId).teach.autonomy, "hint");
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
    assert.equal(startRunCalls.length, 0);
  });

  it("threads:create with teach:true starts teach mode", async () => {
    const projectId = store.getThreads()[0].projectId;
    const thread = await IPC_HANDLERS["threads:create"](ctx, {
      projectId,
      title: "Teach me diffs",
      teach: true,
    });
    assert.ok(thread.teach);
    assert.equal(thread.teach.autonomy, "hint");
  });

  it("threads:stopTeach clears teach", async () => {
    await IPC_HANDLERS["threads:startTeach"](ctx, { threadId });
    const thread = await IPC_HANDLERS["threads:stopTeach"](ctx, { threadId });
    assert.equal(thread.teach, null);
    assert.equal(store.getThread(threadId).teach, null);
  });

  it("threads:requestTeachReview starts one run with the review prompt", async () => {
    await IPC_HANDLERS["threads:startTeach"](ctx, { threadId });
    const thread = await IPC_HANDLERS["threads:requestTeachReview"](ctx, {
      threadId,
    });
    assert.ok(thread.teach);
    assert.equal(startRunCalls.length, 1);
    assert.equal(startRunCalls[0].threadId, threadId);
    assert.match(startRunCalls[0].prompt, /TODO\(human\)/);
    assert.match(startRunCalls[0].prompt, /teach_review/);
  });

  it("threads:requestTeachReview throws when teach is off", async () => {
    await assert.rejects(
      () => IPC_HANDLERS["threads:requestTeachReview"](ctx, { threadId }),
      /not in teach mode/,
    );
    assert.equal(startRunCalls.length, 0);
  });
});
