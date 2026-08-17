"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installShutdown } = require("../shutdown.js");

function harness() {
  const app = new EventEmitter();
  const proc = new EventEmitter();
  const calls = [];
  const shutdown = installShutdown({
    app,
    proc,
    exit: (code) => calls.push(["exit", code]),
    cleanup: () => calls.push(["cleanup"]),
  });
  return { app, proc, calls, shutdown };
}

describe("installShutdown", () => {
  it("before-quit and SIGINT share one re-entrant cleanup", () => {
    const { app, proc, calls } = harness();
    app.emit("before-quit");
    proc.emit("SIGINT");
    proc.emit("SIGTERM");
    app.emit("before-quit");
    assert.deepEqual(calls, [
      ["cleanup"],
      ["exit", 0],
      ["exit", 0],
    ]);
  });

  it("signal path runs cleanup then exits, and before-quit does not run it again", () => {
    const { app, proc, calls } = harness();
    proc.emit("SIGTERM");
    app.emit("before-quit");
    assert.deepEqual(calls, [
      ["cleanup"],
      ["exit", 0],
    ]);
  });

  it("calling shutdown twice is a no-op after the first", () => {
    const { shutdown, calls } = harness();
    shutdown();
    shutdown();
    assert.deepEqual(calls, [["cleanup"]]);
  });

  it("still exits if cleanup throws", () => {
    const app = new EventEmitter();
    const proc = new EventEmitter();
    const exits = [];
    installShutdown({
      app,
      proc,
      exit: (code) => exits.push(code),
      cleanup: () => {
        throw new Error("boom");
      },
    });
    proc.emit("SIGINT");
    assert.deepEqual(exits, [0]);
  });
});
