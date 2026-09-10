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

describe("threads search", () => {
  let tmpDir;
  let filePath;
  /** @type {Store} */
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-search-"));
    filePath = path.join(tmpDir, "coder-store.json");
    store = new Store(filePath);
  });

  afterEach(() => {
    if (store) store._cancelSearchWorker();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("matches thread titles (case-insensitive substring)", async () => {
    store.setThreads([
      makeThread({ id: "a", title: "Fix Auth Bug", updatedAt: 10 }),
      makeThread({ id: "b", title: "Unrelated work", updatedAt: 20 }),
    ]);
    const hits = await store.searchThreads("auth");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("matches notes (case-insensitive substring) when title and messages do not", async () => {
    store.setThreads([
      makeThread({
        id: "a",
        title: "Unrelated work",
        notes: "Merge after #42 lands",
        updatedAt: 10,
      }),
      makeThread({
        id: "b",
        title: "Also unrelated",
        notes: "",
        updatedAt: 20,
      }),
    ]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "please refactor the parser", createdAt: 1 },
    ]);
    const hits = await store.searchThreads("merge after #42");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("matches message content (case-insensitive substring)", async () => {
    store.setThreads([
      makeThread({ id: "a", title: "Thread A", updatedAt: 10 }),
      makeThread({ id: "b", title: "Thread B", updatedAt: 20 }),
    ]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "please refactor the parser", createdAt: 1 },
    ]);
    store.setMessages("b", [
      { id: "m2", role: "assistant", text: "done with styles", createdAt: 2 },
    ]);
    const hits = await store.searchThreads("PARSER");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("dedupes when both title and message match the same thread", async () => {
    store.setThreads([
      makeThread({ id: "a", title: "Parser rewrite", updatedAt: 50 }),
    ]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "parser details", createdAt: 1 },
      { id: "m2", role: "assistant", text: "more parser notes", createdAt: 2 },
    ]);
    const hits = await store.searchThreads("parser");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("includes archived threads", async () => {
    store.setThreads([
      makeThread({
        id: "arch",
        title: "Old Auth notes",
        archived: true,
        updatedAt: 5,
      }),
      makeThread({
        id: "live",
        title: "Live thread",
        archived: false,
        updatedAt: 10,
      }),
    ]);
    const hits = await store.searchThreads("auth");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "arch");
    assert.equal(hits[0].archived, true);
  });

  it("orders by updatedAt DESC and caps at 50", async () => {
    const threads = [];
    for (let i = 0; i < 60; i++) {
      threads.push(
        makeThread({
          id: `t${i}`,
          title: `Hit ${i} unique-marker`,
          updatedAt: i,
        }),
      );
    }
    store.setThreads(threads);
    const hits = await store.searchThreads("unique-marker");
    assert.equal(hits.length, 50);
    assert.equal(hits[0].id, "t59");
    assert.equal(hits[49].id, "t10");
    for (let i = 0; i < hits.length - 1; i++) {
      assert.ok(hits[i].updatedAt >= hits[i + 1].updatedAt);
    }
  });

  it("returns [] for empty or 1-char queries", async () => {
    store.setThreads([makeThread({ id: "a", title: "Anything" })]);
    assert.deepEqual(await store.searchThreads(""), []);
    assert.deepEqual(await store.searchThreads(" "), []);
    assert.deepEqual(await store.searchThreads("a"), []);
    assert.deepEqual(await store.searchThreads(null), []);
    assert.deepEqual(await store.searchThreads(undefined), []);
  });

  it("services.searchThreads wires store and input shape", async () => {
    store.setThreads([
      makeThread({ id: "a", title: "Budget cap notes", updatedAt: 3 }),
    ]);
    const hits = await services.searchThreads(store, { query: "budget" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
    assert.deepEqual(await services.searchThreads(store, { query: "x" }), []);
    assert.deepEqual(await services.searchThreads(store, {}), []);
  });

  it("does not hydrate persisted shards on a no-match search (#1122)", async () => {
    const threads = [];
    for (let i = 0; i < 8; i++) {
      const id = `arch-${i}`;
      threads.push(
        makeThread({
          id,
          title: `Archived ${i}`,
          archived: true,
          updatedAt: i,
        }),
      );
      store.setMessages(id, [
        {
          id: `m-${i}`,
          role: "assistant",
          text: `padding-${i} ${"x".repeat(2000)}`,
          createdAt: i,
        },
      ]);
    }
    store.setThreads(threads);
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(Object.keys(reloaded._messagesHydrated).length, 0);

    const hits = await reloaded.searchThreads("no-such-token-zz");
    assert.deepEqual(hits, []);
    assert.equal(
      Object.keys(reloaded._messagesHydrated).length,
      0,
      "search must not populate the transcript cache",
    );
    assert.equal(
      reloaded._messagesRaw.size,
      0,
      "search must not retain raw shard strings on the store",
    );
  });

  it("matches archived message content without hydrating the shard", async () => {
    store.setThreads([
      makeThread({
        id: "arch",
        title: "Old notes",
        archived: true,
        updatedAt: 5,
      }),
    ]);
    store.setMessages("arch", [
      { id: "m1", role: "user", text: "unique-archive-needle", createdAt: 1 },
    ]);
    store.saveNow();
    const reloaded = new Store(filePath);
    const hits = await reloaded.searchThreads("UNIQUE-archive-needle");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "arch");
    assert.equal(hits[0].archived, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(reloaded._messagesHydrated, "arch"),
      false,
    );
  });

  it("includes current unsaved messages that are not on disk yet", async () => {
    store.setThreads([
      makeThread({ id: "live", title: "Untitled", updatedAt: 9 }),
    ]);
    store.setMessages("live", [
      { id: "m1", role: "user", text: "unsaved-needle-xyz", createdAt: 1 },
    ]);
    const hits = await store.searchThreads("unsaved-needle-xyz");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "live");
  });

  it("omits threads deleted after they were persisted", async () => {
    store.setThreads([
      makeThread({ id: "gone", title: "delete-me-later", updatedAt: 1 }),
      makeThread({ id: "kept", title: "still here", updatedAt: 2 }),
    ]);
    store.setMessages("gone", [
      { id: "m1", role: "user", text: "delete-me-later body", createdAt: 1 },
    ]);
    store.saveNow();
    store.removeThread("gone");
    store.saveNow();
    const hits = await store.searchThreads("delete-me-later");
    assert.equal(hits.some((t) => t.id === "gone"), false);
    const reloaded = new Store(filePath);
    const afterRestart = await reloaded.searchThreads("delete-me-later");
    assert.equal(afterRestart.some((t) => t.id === "gone"), false);
  });

  it("finds persisted message content after a store restart", async () => {
    store.setThreads([
      makeThread({ id: "t1", title: "Restart me", updatedAt: 4 }),
    ]);
    store.setMessages("t1", [
      { id: "m1", role: "user", text: "restart-persist-needle", createdAt: 1 },
    ]);
    store.saveNow();
    const reloaded = new Store(filePath);
    const hits = await reloaded.searchThreads("restart-persist-needle");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "t1");
  });

  it("does not rewrite a corrupt shard during read-only search", async () => {
    store.setThreads([
      makeThread({ id: "bad", title: "Corrupt shard", updatedAt: 1 }),
      makeThread({ id: "ok", title: "Healthy", updatedAt: 2 }),
    ]);
    store.setMessages("ok", [
      { id: "m1", role: "user", text: "healthy-needle", createdAt: 1 },
    ]);
    store.saveNow();
    const shardPath = path.join(tmpDir, "messages", "bad.json");
    fs.mkdirSync(path.dirname(shardPath), { recursive: true });
    const corrupt = "{not-json";
    fs.writeFileSync(shardPath, corrupt, "utf8");
    const beforeMtime = fs.statSync(shardPath).mtimeMs;

    const reloaded = new Store(filePath);
    const hits = await reloaded.searchThreads("healthy-needle");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "ok");
    assert.equal(fs.readFileSync(shardPath, "utf8"), corrupt);
    assert.equal(fs.statSync(shardPath).mtimeMs, beforeMtime);
    assert.equal(
      Object.prototype.hasOwnProperty.call(reloaded._messagesHydrated, "bad"),
      false,
    );
  });

  it("returns a thenable so a newer query can cancel the in-flight scan", async () => {
    store.setThreads([
      makeThread({ id: "a", title: "alpha-unique-title", updatedAt: 1 }),
      makeThread({ id: "b", title: "beta-unique-title", updatedAt: 2 }),
    ]);
    const first = store.searchThreads("alpha-unique-title");
    assert.equal(
      typeof first.then,
      "function",
      "search must be async so renderer guards are not the only cancel path",
    );
    const second = store.searchThreads("beta-unique-title");
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(
      a.map((t) => t.id),
      [],
      "superseded backend scan must not return stale hits",
    );
    assert.deepEqual(
      b.map((t) => t.id),
      ["b"],
    );
  });

  it("keeps the main loop responsive while scanning persisted shards", async () => {
    const threads = [];
    for (let i = 0; i < 16; i++) {
      const id = `loop-${i}`;
      threads.push(
        makeThread({
          id,
          title: `Loop ${i}`,
          archived: true,
          updatedAt: i,
        }),
      );
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
    const hits = await reloaded.searchThreads("no-such-loop-token");
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    histogram.disable();
    const p95Ms = histogram.percentile(95) / 1e6;
    const p99Ms = histogram.percentile(99) / 1e6;
    assert.deepEqual(hits, []);
    assert.equal(Object.keys(reloaded._messagesHydrated).length, 0);
    assert.ok(
      p99Ms < 50,
      `main-loop p99 ${p99Ms.toFixed(1)}ms (p95 ${p95Ms.toFixed(1)}ms, search ${elapsedMs.toFixed(1)}ms)`,
    );
  });
});
