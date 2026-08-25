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

describe("threads summaries", () => {
  let tmpDir;
  let filePath;
  /** @type {Store} */
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-summaries-"));
    filePath = path.join(tmpDir, "coder-store.json");
    store = new Store(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns one row per thread with role fields and null lastActivity", () => {
    store.setThreads([
      makeThread({ id: "orch", title: "Plan", provider: "claude" }),
      makeThread({
        id: "work",
        title: "Fork: Plan",
        provider: "grok",
        status: "working",
        handoffFrom: "orch",
        runStartedAt: 90,
        awaitingInput: true,
      }),
    ]);
    const rows = services.threadSummaries(store);
    assert.equal(rows.length, 2);
    const work = rows.find((r) => r.id === "work");
    // runStartedAt + awaitingInput ride along so the Agents panel can render
    // "waiting on N · elapsed" and flag a blocked worker (issue #42).
    assert.deepEqual(work, {
      id: "work",
      title: "Fork: Plan",
      provider: "grok",
      status: "working",
      handoffFrom: "orch",
      runStartedAt: 90,
      stoppedAt: null,
      awaitingInput: true,
      stalledAt: null,
      lastActivity: null,
    });
    const orch = rows.find((r) => r.id === "orch");
    assert.equal(orch.runStartedAt, null);
    assert.equal(orch.awaitingInput, false);
    assert.equal(orch.stalledAt, null);
  });

  it("mirrors stalledAt onto the summary row", () => {
    store.setThreads([
      makeThread({ id: "hung", status: "working", stalledAt: 1234 }),
    ]);
    const [row] = services.threadSummaries(store);
    assert.equal(row.stalledAt, 1234);
  });

  it("mirrors stoppedAt onto the summary row (issue #183)", () => {
    store.setThreads([
      makeThread({ id: "stopped", status: "idle", stoppedAt: 5678 }),
    ]);
    const [row] = services.threadSummaries(store);
    assert.equal(row.stoppedAt, 5678);
  });

  it("lastActivity is the first line of the LAST assistant message", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "question", createdAt: 10 },
      {
        id: "m2",
        role: "assistant",
        text: "first answer\nwith detail",
        createdAt: 20,
      },
      { id: "m3", role: "assistant", text: "LAST\nsecond line", createdAt: 30 },
      { id: "m4", role: "user", text: "later user msg", createdAt: 40 },
    ]);
    const [row] = services.threadSummaries(store);
    assert.deepEqual(row.lastActivity, { text: "LAST", at: 30 });
  });

  it("skips blank assistant messages and falls back to updatedAt without createdAt", () => {
    store.setThreads([makeThread({ id: "a", updatedAt: 555 })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "real answer", createdAt: 10 },
      { id: "m2", role: "assistant", text: "   ", createdAt: 20 },
      { id: "m3", role: "assistant", text: "no timestamp" },
    ]);
    const [row] = services.threadSummaries(store);
    assert.deepEqual(row.lastActivity, { text: "no timestamp", at: 555 });
  });

  it("summaries reflect an assistant message appended after a previous summaries call", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "first", createdAt: 10 },
    ]);
    const [before] = services.threadSummaries(store);
    assert.deepEqual(before.lastActivity, { text: "first", at: 10 });

    store.appendMessage("a", {
      id: "m2",
      role: "assistant",
      text: "second\nmore",
      createdAt: 20,
    });
    const [after] = services.threadSummaries(store);
    assert.deepEqual(after.lastActivity, { text: "second", at: 20 });
  });

  it("summaries reflect a streamed assistant message edited via updateMessage", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "partial", createdAt: 10 },
    ]);
    const [before] = services.threadSummaries(store);
    assert.deepEqual(before.lastActivity, { text: "partial", at: 10 });

    store.updateMessage("a", "m1", { text: "partial, then more" });
    const [after] = services.threadSummaries(store);
    assert.deepEqual(after.lastActivity, { text: "partial, then more", at: 10 });
  });

  it("summaries skip a last assistant message that is later blanked", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "kept", createdAt: 10 },
      { id: "m2", role: "assistant", text: "will blank", createdAt: 20 },
    ]);
    const [before] = services.threadSummaries(store);
    assert.deepEqual(before.lastActivity, { text: "will blank", at: 20 });

    store.updateMessage("a", "m2", { text: "   " });
    const [after] = services.threadSummaries(store);
    assert.deepEqual(after.lastActivity, { text: "kept", at: 10 });
  });
});
