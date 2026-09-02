/**
 * Issue #824 / #182: a workflow that dies mid-retry must fail closed
 * on the next process start without a stuck in-progress work-log item.
 * Persist/resume flags stay #815. Kimi flags unchanged.
 *
 * Run: node --test electron/test/workflow-crash-resume.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../store.js");

const FIXED = 1_700_000_000_000;
const RUN_ID = "run-mid-retry";

function threadRow(id, status) {
  return {
    id,
    projectId: "p1",
    title: "Workflow mid-retry",
    branch: null,
    prNumber: null,
    status,
    createdAt: FIXED,
    updatedAt: FIXED,
    runStartedAt: status === "working" ? FIXED + 100 : null,
    provider: "claude",
    sessionId: null,
    permissionMode: "default",
    worktreePath: null,
  };
}

function workLogItems() {
  return [
    {
      id: "wl-seed",
      runId: RUN_ID,
      label: "Seed",
      done: true,
      timestamp: FIXED + 10,
    },
    {
      id: "wl-plan",
      runId: RUN_ID,
      label: "Plan",
      done: false,
      timestamp: FIXED + 20,
    },
    {
      id: "wl-retry",
      runId: RUN_ID,
      label: "Plan agent 1 retrying",
      done: false,
      timestamp: FIXED + 30,
    },
  ];
}

function writeStore(filePath, { threads, workLogByThread, messagesByThread }) {
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      projects: [],
      threads,
      messagesByThread: messagesByThread || {},
      workLogByThread,
      usageByThread: {},
    }),
    "utf8",
  );
}

describe("workflow crash-resume mid-retry (#824)", () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-wf-crash-"));
    filePath = path.join(tmpDir, "coder-store.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
  });

  it("closes the in-progress retry line when a working workflow thread is recovered", () => {
    writeStore(filePath, {
      threads: [threadRow("t-wf", "working")],
      workLogByThread: { "t-wf": workLogItems() },
    });

    const store = new Store(filePath);
    const t = store.getThread("t-wf");
    assert.equal(t.status, "failed");
    assert.equal(t.runStartedAt, null);

    const log = store.getWorkLog("t-wf");
    const retry = log.find((w) => w.id === "wl-retry");
    assert.ok(retry, "retry work-log item must still exist");
    assert.equal(retry.label, "Plan agent 1 retrying");
    assert.equal(
      retry.done,
      true,
      "mid-retry line must not stay done:false after crash recovery",
    );
    assert.equal(retry.runId, RUN_ID);

    const plan = log.find((w) => w.id === "wl-plan");
    assert.ok(plan);
    assert.equal(
      plan.done,
      true,
      "the open phase line must also close; a crash leaves no in-progress item",
    );

    const seed = log.find((w) => w.id === "wl-seed");
    assert.ok(seed);
    assert.equal(seed.done, true);
    assert.equal(seed.timestamp, FIXED + 10);

    const msgs = store.getMessages("t-wf");
    assert.ok(
      msgs.some(
        (m) =>
          m.role === "event" &&
          m.text ===
            "Run interrupted: the app crashed or was force-quit mid-run",
      ),
      "existing crash event must still be appended",
    );
  });

  it("does not rewrite work-log items on idle threads", () => {
    writeStore(filePath, {
      threads: [threadRow("t-idle", "idle")],
      workLogByThread: { "t-idle": workLogItems() },
    });

    const store = new Store(filePath);
    assert.equal(store.getThread("t-idle").status, "idle");
    const log = store.getWorkLog("t-idle");
    assert.equal(log.find((w) => w.id === "wl-retry").done, false);
    assert.equal(log.find((w) => w.id === "wl-plan").done, false);
    assert.equal(log.find((w) => w.id === "wl-seed").done, true);
    const msgs = store.getMessages("t-idle");
    assert.ok(
      !msgs.some((m) => /crashed|force-quit/i.test(m.text || "")),
      "recoverInterruptedRuns must not append a crash event on idle",
    );
  });

  it("leaves already-done work-log items unchanged on a recovered thread", () => {
    writeStore(filePath, {
      threads: [threadRow("t-wf", "working")],
      workLogByThread: {
        "t-wf": [
          {
            id: "wl-done",
            runId: RUN_ID,
            label: "Plan agent 1 retrying",
            done: true,
            timestamp: FIXED + 5,
          },
        ],
      },
    });

    const store = new Store(filePath);
    assert.equal(store.getThread("t-wf").status, "failed");
    const item = store.getWorkLog("t-wf")[0];
    assert.equal(item.id, "wl-done");
    assert.equal(item.done, true);
    assert.equal(item.timestamp, FIXED + 5);
    assert.equal(item.label, "Plan agent 1 retrying");
  });

  it("persists the healed retry line so a second load stays done", () => {
    writeStore(filePath, {
      threads: [threadRow("t-wf", "working")],
      workLogByThread: { "t-wf": workLogItems() },
    });

    const store = new Store(filePath);
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getThread("t-wf").status, "failed");
    const retry = reloaded.getWorkLog("t-wf").find((w) => w.id === "wl-retry");
    assert.ok(retry);
    assert.equal(
      retry.done,
      true,
      "healed retry line must be on disk, not only in the first process",
    );
    const plan = reloaded.getWorkLog("t-wf").find((w) => w.id === "wl-plan");
    assert.equal(plan.done, true);
  });
});
