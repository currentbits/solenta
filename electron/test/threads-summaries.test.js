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
      }),
    ]);
    const rows = services.threadSummaries(store);
    assert.equal(rows.length, 2);
    const work = rows.find((r) => r.id === "work");
    assert.deepEqual(work, {
      id: "work",
      title: "Fork: Plan",
      provider: "grok",
      status: "working",
      handoffFrom: "orch",
      lastActivity: null,
    });
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
});
