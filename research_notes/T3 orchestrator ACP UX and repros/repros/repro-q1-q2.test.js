"use strict";

/**
 * Q1 / Q2 characterization (commit 615b38a0). Unlike the repro files these
 * assert CURRENT behaviour and are expected to PASS; they pin what the code
 * does today so a design can be checked against it.
 *
 * Q1: what does Stop do with queued work? (follow-ups vs crew notices)
 * Q2: what clock does effectiveSettled (src/threadSettle.ts) read, and can a
 *     machine notice turn keep a thread from settling?
 *
 * Needs --experimental-strip-types (the repo's test runner passes it).
 * Run: node --experimental-strip-types --test electron/test/repro-q1-q2.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { rmTree } = require("./support/rmTree.js");

function waitFor(predicate, { timeoutMs = 8000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
const users = (store, id) => (store.getMessages(id) || []).filter((m) => m.role === "user");

describe("Q1/Q2 with the simulate runner", () => {
  let tmpDir, store, runner, thread, prevSim;
  beforeEach(async () => {
    prevSim = process.env.CODER_SIMULATE;
    process.env.CODER_SIMULATE = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-q1q2-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    thread = services.createThread(store, { projectId: project.id, title: "Lead" });
    const core = await import(pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href);
    runner = createRunner({ store, core, pushFn() {}, tickMs: 15, userDataPath: tmpDir });
  });
  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    if (prevSim === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSim;
  });

  it("Q1: Stop holds a queued user follow-up and demotes queued crew notices to an event (no new turn)", async () => {
    await runner.startRun({ threadId: thread.id, prompt: "long task" });
    assert.equal(runner.isRunning(thread.id), true);
    services.setQueued(store, { threadId: thread.id, prompt: "user type-ahead" });
    runner.deliverNotice({ threadId: thread.id, line: `[peer from w1 ("backend")] contract.md is ready` });
    await runner.stopRun({ threadId: thread.id });
    await new Promise((r) => setTimeout(r, 500));
    const events = (store.getMessages(thread.id) || []).filter((m) => m.role === "event").map((m) => m.text);
    const facts = {
      noticeTurnStartedAfterStop: users(store, thread.id).some((m) => m.fromNotice === true),
      noticeDemotedToEvent: events.some((e) => /contract\.md is ready/.test(e)),
      followUpStillQueued: Boolean(store.getThread(thread.id).queued),
      followUpRan: users(store, thread.id).some((m) => /user type-ahead/.test(String(m.text))),
      running: runner.isRunning(thread.id),
      status: store.getThread(thread.id).status,
    };
    console.log("Q1 facts:", JSON.stringify(facts));
    assert.equal(facts.noticeTurnStartedAfterStop, false);
    assert.equal(facts.noticeDemotedToEvent, true);
    assert.equal(facts.followUpRan, false);
    assert.equal(facts.followUpStillQueued, true);
    assert.equal(facts.running, false);
  });

  it("Q2: a notice turn bumps updatedAt, which restarts the inactivity settle clock", async () => {
    const { effectiveSettled } = await import(pathToFileURL(path.join(__dirname, "../../src/threadSettle.ts")).href);
    const fourDaysAgo = Date.now() - 4 * 24 * 3600 * 1000;
    store.updateThread(thread.id, { status: "done", updatedAt: fourDaysAgo });
    const opts = () => ({ now: Date.now(), autoSettleAfterDays: 3, autoSettleOnMerge: true });
    const before = effectiveSettled(store.getThread(thread.id), opts());
    runner.deliverNotice({ threadId: thread.id, line: `[peer from w1 ("backend")] fyi` });
    await waitFor(() => users(store, thread.id).length > 0 && store.getThread(thread.id).status === "done");
    const after = effectiveSettled(store.getThread(thread.id), opts());
    // Same notice turn on a thread whose PR merged:
    store.updateThread(thread.id, { prNumber: 9, prState: "MERGED" });
    const mergedDone = effectiveSettled(store.getThread(thread.id), opts());
    const mergedWorking = effectiveSettled({ ...store.getThread(thread.id), status: "working" }, opts());
    const mergedFailed = effectiveSettled({ ...store.getThread(thread.id), status: "failed" }, opts());
    const facts = {
      settledBeforeNotice: before,
      updatedAtBumped: store.getThread(thread.id).updatedAt > fourDaysAgo,
      settledAfterNotice: after,
      mergedDone,
      mergedWorking,
      mergedFailed,
    };
    console.log("Q2 facts:", JSON.stringify(facts));
    assert.equal(facts.settledBeforeNotice, true);
    assert.equal(facts.updatedAtBumped, true);
    assert.equal(facts.settledAfterNotice, false);
    assert.equal(facts.mergedDone, true);
    assert.equal(facts.mergedWorking, false);
    assert.equal(facts.mergedFailed, true);
  });
});
