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

/**
 * Unmigrated store: N threads, each with a fat tool payload and no
 * lastAssistantPreview, so a constructor peek-migrate would skip-scan.
 * @param {string} dest
 * @param {number} n
 */
function writeUpgradeFixture(dest, n) {
  const blob = "x".repeat(4000);
  const threads = [];
  const messagesByThread = {};
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    threads.push(makeThread({ id, updatedAt: 1000 + i }));
    messagesByThread[id] = [
      { id: `u${i}`, role: "user", text: "q", createdAt: 1 },
      {
        id: `tool${i}`,
        role: "tool",
        tool: { name: "bash", input: blob },
        createdAt: 2,
      },
      {
        id: `a${i}`,
        role: "assistant",
        text: `answer ${i}\nmore`,
        createdAt: 10 + i,
      },
    ];
  }
  fs.writeFileSync(
    dest,
    JSON.stringify({
      threads,
      messagesByThread,
      workLogByThread: {},
      usageByThread: {},
    }),
    "utf8",
  );
}

/**
 * Count Store._ensureMessagesIndexed calls (the messagesByThread skip-scan).
 * @param {(calls: () => number) => void} run
 */
function withEnsureIndexedCount(run) {
  const orig = Store.prototype._ensureMessagesIndexed;
  let calls = 0;
  Store.prototype._ensureMessagesIndexed = function (...args) {
    calls += 1;
    return orig.apply(this, args);
  };
  try {
    run(() => calls);
  } finally {
    Store.prototype._ensureMessagesIndexed = orig;
  }
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

  it("appendMessage stamps lastAssistantPreview on the thread row", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "assistant", text: "first", createdAt: 10 },
    ]);
    assert.deepEqual(store.getThread("a").lastAssistantPreview, {
      text: "first",
      at: 10,
    });
    store.appendMessage("a", {
      id: "m2",
      role: "assistant",
      text: "second\nmore",
      createdAt: 20,
    });
    assert.deepEqual(store.getThread("a").lastAssistantPreview, {
      text: "second",
      at: 20,
    });
  });

  it("summaries after reload do not call getMessages", () => {
    store.setThreads([makeThread({ id: "a" })]);
    store.setMessages("a", [
      { id: "m1", role: "user", text: "question", createdAt: 10 },
      {
        id: "m2",
        role: "assistant",
        text: "LAST\nsecond line",
        createdAt: 30,
      },
    ]);
    store.saveNow();
    const reloaded = new Store(filePath);
    let calls = 0;
    const orig = reloaded.getMessages.bind(reloaded);
    reloaded.getMessages = (...args) => {
      calls += 1;
      return orig(...args);
    };
    const [row] = services.threadSummaries(reloaded);
    assert.deepEqual(row.lastActivity, { text: "LAST", at: 30 });
    assert.equal(calls, 0);
    assert.equal(
      Object.prototype.hasOwnProperty.call(reloaded._messagesHydrated, "a"),
      false,
    );
  });

  it("construct leaves lastAssistantPreview unset; first summaries peeks without hydrating", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        threads: [makeThread({ id: "a", updatedAt: 555 })],
        messagesByThread: {
          a: [
            { id: "m1", role: "assistant", text: "real answer", createdAt: 10 },
            { id: "m2", role: "assistant", text: "   ", createdAt: 20 },
            { id: "m3", role: "assistant", text: "no timestamp" },
          ],
        },
      }),
      "utf8",
    );
    const reloaded = new Store(filePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(reloaded._messagesHydrated, "a"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        reloaded.getThread("a"),
        "lastAssistantPreview",
      ),
      false,
    );
    let calls = 0;
    const orig = reloaded.getMessages.bind(reloaded);
    reloaded.getMessages = (...args) => {
      calls += 1;
      return orig(...args);
    };
    const [row] = services.threadSummaries(reloaded);
    assert.deepEqual(reloaded.getThread("a").lastAssistantPreview, {
      text: "no timestamp",
      at: 555,
    });
    assert.deepEqual(row.lastActivity, { text: "no timestamp", at: 555 });
    assert.equal(calls, 0);
    assert.equal(
      Object.prototype.hasOwnProperty.call(reloaded._messagesHydrated, "a"),
      false,
    );
  });

  it("construct against a large unmigrated store returns before any skip-scan", () => {
    writeUpgradeFixture(filePath, 32);
    withEnsureIndexedCount((calls) => {
      const loaded = new Store(filePath);
      assert.equal(calls(), 0, "construct must not skip-scan messagesByThread");
      assert.equal(loaded._messagesLazy && loaded._messagesLazy.indexed, false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          loaded.getThread("t0"),
          "lastAssistantPreview",
        ),
        false,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(loaded._messagesHydrated, "t0"),
        false,
      );
    });
  });

  it("deferred migrate fills lastAssistantPreview; second boot is a no-op", () => {
    writeUpgradeFixture(filePath, 32);
    const first = new Store(filePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        first.getThread("t0"),
        "lastAssistantPreview",
      ),
      false,
    );
    first.ensureLastAssistantPreviews();
    assert.deepEqual(first.getThread("t0").lastAssistantPreview, {
      text: "answer 0",
      at: 10,
    });
    assert.deepEqual(first.getThread("t31").lastAssistantPreview, {
      text: "answer 31",
      at: 41,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(first._messagesHydrated, "t0"),
      false,
    );
    first.saveNow();

    withEnsureIndexedCount((calls) => {
      const second = new Store(filePath);
      assert.equal(calls(), 0);
      assert.equal(second._messagesLazy && second._messagesLazy.indexed, false);
      assert.deepEqual(second.getThread("t0").lastAssistantPreview, {
        text: "answer 0",
        at: 10,
      });
      const rows = services.threadSummaries(second);
      assert.equal(calls(), 0, "second boot summaries must not skip-scan");
      assert.deepEqual(rows.find((r) => r.id === "t0").lastActivity, {
        text: "answer 0",
        at: 10,
      });
      assert.equal(second._messagesLazy && second._messagesLazy.indexed, false);
    });
  });
});
