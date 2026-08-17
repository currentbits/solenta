"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installShutdown } = require("../shutdown.js");

// Handlers land on the real `process` (that is the fix), so every test has to
// put the default signal disposition back or the runner keeps them for good.
afterEach(() => {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

function harness(cleanup) {
  const app = new EventEmitter();
  const calls = [];
  const shutdown = installShutdown({
    app,
    exit: (code) => calls.push(["exit", code]),
    cleanup: cleanup || (() => calls.push(["cleanup"])),
  });
  return { app, calls, shutdown };
}

describe("installShutdown", () => {
  it("registers on the real process for both signals", () => {
    const before = {
      int: process.listenerCount("SIGINT"),
      term: process.listenerCount("SIGTERM"),
    };
    harness();
    assert.equal(process.listenerCount("SIGINT"), before.int + 1);
    assert.equal(process.listenerCount("SIGTERM"), before.term + 1);
  });

  it("runs cleanup then exits on a real SIGINT", () => {
    const { calls } = harness();
    process.emit("SIGINT");
    assert.deepEqual(calls, [["cleanup"], ["exit", 0]]);
  });

  it("before-quit and the signal path share one re-entrant cleanup", () => {
    const { app, calls } = harness();
    app.emit("before-quit");
    process.emit("SIGTERM");
    process.emit("SIGINT");
    app.emit("before-quit");
    assert.deepEqual(calls, [["cleanup"], ["exit", 0], ["exit", 0]]);
  });

  it("calling shutdown twice is a no-op after the first", () => {
    const { shutdown, calls } = harness();
    shutdown();
    shutdown();
    assert.deepEqual(calls, [["cleanup"]]);
  });

  it("still exits if cleanup throws", () => {
    const exits = [];
    installShutdown({
      app: new EventEmitter(),
      exit: (code) => exits.push(code),
      cleanup: () => {
        throw new Error("boom");
      },
    });
    process.emit("SIGINT");
    assert.deepEqual(exits, [0]);
  });
});
