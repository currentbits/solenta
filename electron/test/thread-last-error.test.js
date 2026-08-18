/**
 * Issue #140: lastError is stored on the thread, cleared on a new run,
 * and preferred by thread_status over a transcript scan.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");
const { createToolHandlers } = require("../orchServer.js");

describe("thread lastError", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-lasterror-"));
    store = new Store(path.join(tmpDir, "store.json"));
    store.setThreads([
      {
        id: "t1",
        title: "Worker",
        provider: "claude",
        status: "idle",
      },
    ]);
    store.setMessages("t1", [
      { role: "event", text: "Run error: scanned from transcript" },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps lastError on fail, clears it on working, and thread_status prefers the store", async () => {
    store.updateThread("t1", {
      status: "failed",
      lastError: "Run error: budget cap hit",
    });
    assert.equal(store.getThread("t1").lastError, "Run error: budget cap hit");

    store.updateThread("t1", { status: "working" });
    assert.equal(store.getThread("t1").lastError, null);

    store.updateThread("t1", {
      status: "failed",
      lastError: "Run error: stored reason",
    });

    const h = createToolHandlers({
      store,
      runner: { startRun: async () => ({ runId: "r1" }) },
    });
    const status = await h.thread_status({ threadId: "t1" });
    assert.equal(status.lastError, "Run error: stored reason");
  });

  it("keeps lastError when parking as quota-wait", () => {
    store.updateThread("t1", {
      status: "quota-wait",
      lastError: "You've hit your limit · resets 3pm",
      quotaWaitUntil: Date.now() + 3600_000,
    });
    assert.equal(
      store.getThread("t1").lastError,
      "You've hit your limit · resets 3pm",
    );
  });
});
