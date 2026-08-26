"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installShutdown, runAppCleanup } = require("../shutdown.js");

// Handlers land on the real `process` (that is the fix), so every test has to
// put the default signal disposition back or the runner keeps them for good.
afterEach(() => {
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

function harness(cleanup, opts = {}) {
  const app = new EventEmitter();
  const calls = [];
  const shutdown = installShutdown({
    app,
    exit: (code) => calls.push(["exit", code]),
    cleanup: cleanup || (() => calls.push(["cleanup"])),
    log: opts.log,
  });
  return { app, calls, shutdown };
}

/** before-quit carries an Electron event; the harness needs the same shape. */
function quitEvent() {
  const prevented = { count: 0 };
  return {
    prevented,
    event: {
      preventDefault() {
        prevented.count += 1;
      },
    },
  };
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

  it("runs cleanup then exits on a real SIGINT", async () => {
    const { calls, shutdown } = harness();
    process.emit("SIGINT");
    await shutdown();
    await Promise.resolve();
    assert.deepEqual(calls, [["cleanup"], ["exit", 0]]);
  });

  it("before-quit and the signal path share one cleanup and exit once", async () => {
    const { app, calls, shutdown } = harness();
    const first = quitEvent();
    app.emit("before-quit", first.event);
    process.emit("SIGTERM");
    process.emit("SIGINT");
    const second = quitEvent();
    app.emit("before-quit", second.event);
    await shutdown();
    await Promise.resolve();
    assert.deepEqual(calls, [["cleanup"], ["exit", 0]]);
    assert.equal(first.prevented.count, 1);
    assert.equal(second.prevented.count, 1);
  });

  it("calling shutdown twice is a no-op after the first", async () => {
    const { shutdown, calls } = harness();
    const a = shutdown();
    const b = shutdown();
    assert.equal(a, b);
    await a;
    assert.deepEqual(calls, [["cleanup"]]);
  });

  it("holds the quit open until an async cleanup settles", async () => {
    const order = [];
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const app = new EventEmitter();
    const shutdown = installShutdown({
      app,
      exit: () => order.push("exit"),
      cleanup: async () => {
        order.push("cleanup:start");
        await gate;
        order.push("cleanup:end");
      },
    });
    const { event } = quitEvent();
    app.emit("before-quit", event);
    await Promise.resolve();
    assert.deepEqual(order, ["cleanup:start"]);
    release();
    await shutdown();
    await Promise.resolve();
    assert.deepEqual(order, ["cleanup:start", "cleanup:end", "exit"]);
  });

  it("still exits exactly once if an async cleanup rejects", async () => {
    const exits = [];
    const logs = [];
    const app = new EventEmitter();
    const shutdown = installShutdown({
      app,
      exit: (code) => exits.push(code),
      cleanup: async () => {
        throw new Error("boom");
      },
      log: (msg) => logs.push(msg),
    });
    process.emit("SIGINT");
    app.emit("before-quit", quitEvent().event);
    await shutdown();
    await Promise.resolve();
    assert.deepEqual(exits, [0]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /shutdown: cleanup failed/);
  });

  it("still exits if a synchronous cleanup throws", async () => {
    const exits = [];
    const app = new EventEmitter();
    const shutdown = installShutdown({
      app,
      exit: (code) => exits.push(code),
      cleanup: () => {
        throw new Error("boom");
      },
    });
    process.emit("SIGINT");
    await shutdown();
    await Promise.resolve();
    assert.deepEqual(exits, [0]);
  });
});

describe("runAppCleanup", () => {
  it("stops runs, then the simulator, then the remaining services", async () => {
    const order = [];
    await runAppCleanup({
      stopRuns: () => order.push("runs"),
      shutdownSimulator: async () => {
        order.push("simulator:start");
        await Promise.resolve();
        order.push("simulator:end");
      },
      teardownServices: () => order.push("services"),
    });
    assert.deepEqual(order, [
      "runs",
      "simulator:start",
      "simulator:end",
      "services",
    ]);
  });

  it("runs the later phases when an earlier one fails, logging one line each", async () => {
    const order = [];
    const logs = [];
    await runAppCleanup({
      stopRuns: () => {
        order.push("runs");
        throw new Error("runs blew up");
      },
      shutdownSimulator: async () => {
        order.push("simulator");
        throw new Error("simulator blew up");
      },
      teardownServices: () => order.push("services"),
      log: (msg) => logs.push(msg),
    });
    assert.deepEqual(order, ["runs", "simulator", "services"]);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^shutdown: stopRuns failed/);
    assert.match(logs[1], /^shutdown: shutdownSimulator failed/);
    // One line, no stack: the log goes to the user's console.
    for (const message of logs) assert.equal(message.includes("\n"), false);
  });

  it("tolerates missing phases", async () => {
    await runAppCleanup({});
  });
});
