const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("matches thread titles (case-insensitive substring)", () => {
    store.setThreads([
      makeThread({ id: "a", title: "Fix Auth Bug", updatedAt: 10 }),
      makeThread({ id: "b", title: "Unrelated work", updatedAt: 20 }),
    ]);
    const hits = store.searchThreads("auth");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("matches notes (case-insensitive substring) when title and messages do not", () => {
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
    const hits = store.searchThreads("merge after #42");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("matches message content (case-insensitive substring)", () => {
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
    const hits = store.searchThreads("PARSER");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("dedupes when both title and message match the same thread", () => {
    store.setThreads([
      makeThread({ id: "a", title: "Parser rewrite", updatedAt: 50 }),
    ]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "parser details", createdAt: 1 },
      { id: "m2", role: "assistant", text: "more parser notes", createdAt: 2 },
    ]);
    const hits = store.searchThreads("parser");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
  });

  it("includes archived threads", () => {
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
    const hits = store.searchThreads("auth");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "arch");
    assert.equal(hits[0].archived, true);
  });

  it("orders by updatedAt DESC and caps at 50", () => {
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
    const hits = store.searchThreads("unique-marker");
    assert.equal(hits.length, 50);
    assert.equal(hits[0].id, "t59");
    assert.equal(hits[49].id, "t10");
    for (let i = 0; i < hits.length - 1; i++) {
      assert.ok(hits[i].updatedAt >= hits[i + 1].updatedAt);
    }
  });

  it("returns [] for empty or 1-char queries", () => {
    store.setThreads([makeThread({ id: "a", title: "Anything" })]);
    assert.deepEqual(store.searchThreads(""), []);
    assert.deepEqual(store.searchThreads(" "), []);
    assert.deepEqual(store.searchThreads("a"), []);
    assert.deepEqual(store.searchThreads(null), []);
    assert.deepEqual(store.searchThreads(undefined), []);
  });

  it("services.searchThreads wires store and input shape", () => {
    store.setThreads([
      makeThread({ id: "a", title: "Budget cap notes", updatedAt: 3 }),
    ]);
    const hits = services.searchThreads(store, { query: "budget" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "a");
    assert.deepEqual(services.searchThreads(store, { query: "x" }), []);
    assert.deepEqual(services.searchThreads(store, {}), []);
  });
});
