/**
 * Message-level search for the command palette (#1761). Mirrors
 * search.test.js's shard/worker coverage, but at message granularity:
 * threadMatches picks a thread, this picks a message within it.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { Store } = require("../store.js");
const services = require("../services.js");

/**
 * @param {Partial<object>} overrides
 */
function makeThread(overrides = {}) {
  return {
    id: "t1",
    projectId: "p1",
    title: "Hello",
    branch: null,
    prNumber: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 100,
    runStartedAt: null,
    archived: false,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    worktreePath: null,
    ...overrides,
  };
}

describe("threads searchMessages", () => {
  let tmpDir;
  let filePath;
  /** @type {Store} */
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-search-msg-"));
    filePath = path.join(tmpDir, "coder-store.json");
    store = new Store(filePath);
  });

  afterEach(() => {
    if (store) {
      store._cancelSearchWorker();
      store._cancelMessageSearchWorker();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("matches message text, case-insensitive", async () => {
    store.setThreads([makeThread({ id: "a", updatedAt: 10 })]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "please refactor the PARSER", createdAt: 5 },
    ]);
    const { hits } = await store.searchMessages("parser");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].threadId, "a");
    assert.equal(hits[0].messageId, "m1");
    assert.equal(hits[0].createdAt, 5);
  });

  it("ANDs multiple words, any order, across the same message", async () => {
    store.setThreads([makeThread({ id: "a", updatedAt: 10 })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "the lexer bug is in the parser", createdAt: 1 },
      { id: "m2", role: "user", text: "the parser works fine", createdAt: 2 },
    ]);
    const { hits } = await store.searchMessages("parser bug");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].messageId, "m1");
  });

  it("skips tool and event roles", async () => {
    store.setThreads([makeThread({ id: "a", updatedAt: 10 })]);
    store.setMessages("a", [
      { id: "m1", role: "tool", text: "needle in a tool summary", createdAt: 1 },
      { id: "m2", role: "event", text: "needle in an event", createdAt: 2 },
      { id: "m3", role: "user", text: "needle in a user message", createdAt: 3 },
    ]);
    const { hits } = await store.searchMessages("needle");
    assert.deepEqual(hits.map((h) => h.messageId), ["m3"]);
  });

  it("caps at 3 hits per thread, newest first within the thread", async () => {
    store.setThreads([makeThread({ id: "a", updatedAt: 10 })]);
    const messages = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ id: `m${i}`, role: "user", text: `needle ${i}`, createdAt: i });
    }
    store.setMessages("a", messages);
    const { hits } = await store.searchMessages("needle");
    assert.equal(hits.length, 3);
    assert.deepEqual(hits.map((h) => h.messageId), ["m5", "m4", "m3"]);
  });

  it("caps at 30 hits overall, newest first, and reports truncated", async () => {
    const threads = [];
    for (let i = 0; i < 20; i++) {
      threads.push(makeThread({ id: `t${i}`, updatedAt: i }));
    }
    store.setThreads(threads);
    for (let i = 0; i < 20; i++) {
      store.setMessages(`t${i}`, [
        { id: `m${i}a`, role: "user", text: "needle one", createdAt: i * 10 },
        { id: `m${i}b`, role: "user", text: "needle two", createdAt: i * 10 + 1 },
      ]);
    }
    const { hits, truncated } = await store.searchMessages("needle");
    assert.equal(hits.length, 30);
    assert.equal(truncated, true);
    for (let i = 0; i < hits.length - 1; i++) {
      assert.ok(hits[i].createdAt >= hits[i + 1].createdAt);
    }
  });

  it("builds a snippet of ~120 chars around the first match", async () => {
    store.setThreads([makeThread({ id: "a", updatedAt: 1 })]);
    const pad = "x".repeat(200);
    store.setMessages("a", [
      { id: "m1", role: "user", text: `${pad} needle ${pad}`, createdAt: 1 },
    ]);
    const { hits } = await store.searchMessages("needle");
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /needle/);
    assert.ok(hits[0].snippet.length < 140, hits[0].snippet.length);
    assert.ok(hits[0].snippet.startsWith("…"));
    assert.ok(hits[0].snippet.endsWith("…"));
  });

  it("returns no hits for queries under 3 chars", async () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [{ id: "m1", role: "user", text: "ab", createdAt: 1 }]);
    assert.deepEqual(await store.searchMessages(""), { hits: [], truncated: false });
    assert.deepEqual(await store.searchMessages("a"), { hits: [], truncated: false });
    assert.deepEqual(await store.searchMessages("ab"), { hits: [], truncated: false });
    assert.deepEqual(await store.searchMessages(null), { hits: [], truncated: false });
  });

  it("matches archived message content without hydrating the shard", async () => {
    store.setThreads([makeThread({ id: "a", archived: true, updatedAt: 1 })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "archived-needle-xyz", createdAt: 7 },
    ]);
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(Object.keys(reloaded._messagesHydrated).length, 0);
    const { hits } = await reloaded.searchMessages("archived-needle-xyz");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].threadId, "a");
    assert.equal(Object.keys(reloaded._messagesHydrated).length, 0);
  });

  it("services.searchMessages drops trashed and memoryConsolidate threads before the cap", async () => {
    store.setThreads([
      makeThread({ id: "live", updatedAt: 1 }),
      makeThread({ id: "trashed", updatedAt: 2, trashedAt: Date.now() }),
      makeThread({ id: "mem", updatedAt: 3, memoryConsolidate: true }),
    ]);
    for (const id of ["live", "trashed", "mem"]) {
      store.setMessages(id, [
        { id: `${id}-m`, role: "user", text: "shared-needle", createdAt: 1 },
      ]);
    }
    const { hits } = await services.searchMessages(store, { query: "shared-needle" });
    assert.deepEqual(hits.map((h) => h.threadId), ["live"]);
  });

  it("services.searchMessages scopes by threadIds", async () => {
    store.setThreads([
      makeThread({ id: "a", updatedAt: 1 }),
      makeThread({ id: "b", updatedAt: 2 }),
    ]);
    store.setMessages("a", [{ id: "am", role: "user", text: "scoped-needle", createdAt: 1 }]);
    store.setMessages("b", [{ id: "bm", role: "user", text: "scoped-needle", createdAt: 2 }]);
    const { hits } = await services.searchMessages(store, {
      query: "scoped-needle",
      threadIds: ["a"],
    });
    assert.deepEqual(hits.map((h) => h.threadId), ["a"]);
  });

  it("does not share a generation with searchThreads: concurrent calls do not cancel each other (#1761)", async () => {
    store.setThreads([
      makeThread({ id: "a", title: "alpha-unique-title", updatedAt: 1 }),
    ]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "message-unique-needle", createdAt: 1 },
    ]);
    const threadSearch = store.searchThreads("alpha-unique-title");
    const messageSearch = store.searchMessages("message-unique-needle");
    const [{ threads }, { hits }] = await Promise.all([threadSearch, messageSearch]);
    assert.deepEqual(
      threads.map((t) => t.id),
      ["a"],
      "the palette's thread-kind search must survive a concurrent message search",
    );
    assert.deepEqual(hits.map((h) => h.messageId), ["m1"]);
  });

  it("keeps the main loop responsive while scanning persisted shards", async () => {
    const threads = [];
    for (let i = 0; i < 16; i++) {
      const id = `loop-${i}`;
      threads.push(makeThread({ id, archived: true, updatedAt: i }));
      store.setMessages(id, [
        {
          id: `m-${i}`,
          role: "assistant",
          text: `loop-pad-${i} ${"y".repeat(8000)}`,
          createdAt: i,
        },
      ]);
    }
    store.setThreads(threads);
    store.saveNow();
    const reloaded = new Store(filePath);
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const t0 = process.hrtime.bigint();
    const { hits } = await reloaded.searchMessages("no-such-loop-token");
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    histogram.disable();
    const p99Ms = histogram.percentile(99) / 1e6;
    assert.deepEqual(hits, []);
    assert.equal(Object.keys(reloaded._messagesHydrated).length, 0);
    assert.ok(p99Ms < 50, `main-loop p99 ${p99Ms.toFixed(1)}ms (search ${elapsedMs.toFixed(1)}ms)`);
  });
});
