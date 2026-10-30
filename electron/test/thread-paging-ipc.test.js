/**
 * Issue #1786: threads:get pages the transcript instead of shipping the
 * whole history, and threads:getOlderMessages fetches the previous page.
 * Run: npm run test:electron
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Store, DEFAULT_MESSAGE_PAGE_SIZE } = require("../store.js");
const services = require("../services.js");
const { IPC_HANDLERS } = require("../ipc.js");

describe("thread message paging IPC (#1786)", () => {
  let tmpDir;
  let store;
  let threadId;
  let msgs;
  let ctx;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-paging-ipc-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Work",
    }).id;
    msgs = [];
    for (let i = 0; i < 500; i += 1) {
      msgs.push({ id: `m${i}`, role: "assistant", text: `msg ${i}`, createdAt: i });
    }
    store.setMessages(threadId, msgs);
    ctx = { store, runner: {} };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads:get with no opts returns the newest default page", async () => {
    const detail = await IPC_HANDLERS["threads:get"](ctx, threadId);
    assert.equal(detail.messages.length, DEFAULT_MESSAGE_PAGE_SIZE);
    assert.deepEqual(detail.messages, msgs.slice(500 - DEFAULT_MESSAGE_PAGE_SIZE));
    assert.equal(detail.hasOlderMessages, true);
    assert.equal(detail.totalMessageCount, 500);
    // Still stamps lastVisitedAt (issue #393 behavior unchanged by paging).
    assert.ok(detail.thread.lastVisitedAt > 0);
  });

  it("threads:get honours an explicit limit/before and limit: Infinity", async () => {
    const windowed = await IPC_HANDLERS["threads:get"](ctx, threadId, { limit: 10 });
    assert.deepEqual(windowed.messages, msgs.slice(490));
    assert.equal(windowed.hasOlderMessages, true);

    const anchored = await IPC_HANDLERS["threads:get"](ctx, threadId, {
      limit: 10,
      before: "m100",
    });
    assert.deepEqual(anchored.messages, msgs.slice(90, 100));

    const everything = await IPC_HANDLERS["threads:get"](ctx, threadId, {
      limit: Infinity,
    });
    assert.deepEqual(everything.messages, msgs);
    assert.equal(everything.hasOlderMessages, false);
  });

  it("threads:peek pages the same way but never stamps lastVisitedAt", async () => {
    const before = store.getThread(threadId).lastVisitedAt;
    const detail = await IPC_HANDLERS["threads:peek"](ctx, threadId);
    assert.equal(detail.messages.length, DEFAULT_MESSAGE_PAGE_SIZE);
    assert.equal(detail.hasOlderMessages, true);
    assert.equal(store.getThread(threadId).lastVisitedAt, before);
  });

  it("threads:getOlderMessages returns the page before a loaded cursor", async () => {
    const first = await IPC_HANDLERS["threads:get"](ctx, threadId);
    const oldestLoaded = first.messages[0];
    assert.equal(oldestLoaded.id, "m200");

    const older = await IPC_HANDLERS["threads:getOlderMessages"](ctx, {
      threadId,
      before: oldestLoaded.id,
    });
    assert.deepEqual(older.messages, msgs.slice(0, 200));
    assert.equal(older.hasOlderMessages, false);
    assert.equal(older.totalMessageCount, 500);
  });

  it("threads:getOlderMessages respects a smaller limit and reports hasOlderMessages at the next boundary", async () => {
    const page = await IPC_HANDLERS["threads:getOlderMessages"](ctx, {
      threadId,
      before: "m200",
      limit: 50,
    });
    assert.deepEqual(page.messages, msgs.slice(150, 200));
    assert.equal(page.hasOlderMessages, true);

    const nextPage = await IPC_HANDLERS["threads:getOlderMessages"](ctx, {
      threadId,
      before: "m150",
      limit: 50,
    });
    assert.deepEqual(nextPage.messages, msgs.slice(100, 150));
    assert.equal(nextPage.hasOlderMessages, true);
  });

  it("threads:getOlderMessages on a thread with nothing older reports hasOlderMessages false", async () => {
    const page = await IPC_HANDLERS["threads:getOlderMessages"](ctx, {
      threadId,
      before: "m0",
    });
    assert.deepEqual(page.messages, []);
    assert.equal(page.hasOlderMessages, false);
  });

  it("threads:getOlderMessages rejects an unknown thread", async () => {
    await assert.rejects(
      IPC_HANDLERS["threads:getOlderMessages"](ctx, {
        threadId: "does-not-exist",
        before: "m1",
      }),
      /Unknown thread/,
    );
  });

  it("a small thread (fits one page) reports hasOlderMessages false from threads:get", async () => {
    const small = services.createThread(store, {
      projectId: store.getThreads()[0].projectId,
      title: "Small",
    }).id;
    store.setMessages(small, msgs.slice(0, 5));
    const detail = await IPC_HANDLERS["threads:get"](ctx, small);
    assert.equal(detail.messages.length, 5);
    assert.equal(detail.hasOlderMessages, false);
    assert.equal(detail.totalMessageCount, 5);
  });
});
