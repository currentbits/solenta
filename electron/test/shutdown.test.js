"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { installShutdown, runAppCleanup } = require("../shutdown.js");

const posix = process.platform !== "win32";
const parentScript = path.join(__dirname, "fixtures", "shutdown-reap-parent.js");

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

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killLeftover(pid) {
  if (!pid || !alive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

function runReapParent(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-shutdown-reap-"));
  const heartbeat = path.join(dir, "hb");
  const pidfile = path.join(dir, "pid");
  const child = spawn(process.execPath, [parentScript], {
    env: {
      ...process.env,
      HEARTBEAT: heartbeat,
      PIDFILE: pidfile,
      GRACE_MS: env.GRACE_MS || "300",
      ENTRY: env.ENTRY || "before-quit",
      MODE: env.MODE || "stubborn",
      THROW_STOP: env.THROW_STOP || "",
      REPEAT: env.REPEAT || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { dir, heartbeat, pidfile, child };
}

function waitExit(proc) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("parent did not exit")), 8000);
    proc.on("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
    proc.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function readPid(pidfile) {
  try {
    const n = Number(fs.readFileSync(pidfile, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function readHeartbeat(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

describe("shutdown reaps owned children before exit (#1232)", { skip: !posix }, () => {
  async function runCase(env, { afterMs = 400 } = {}) {
    const fx = runReapParent(env);
    let childPid = 0;
    try {
      const exited = await waitExit(fx.child);
      childPid = readPid(fx.pidfile);
      assert.equal(exited.code, 0, "parent must exit 0 after cleanup");
      const first = readHeartbeat(fx.heartbeat);
      await new Promise((r) => setTimeout(r, afterMs));
      const second = readHeartbeat(fx.heartbeat);
      assert.equal(
        second,
        first,
        "heartbeat must not advance after parent exit (child still executing)",
      );
      if (childPid) {
        assert.equal(alive(childPid), false, "owned child must be dead");
      }
      return { fx, childPid, elapsed: null };
    } finally {
      killLeftover(childPid);
      try {
        fs.rmSync(fx.dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  it("SIGTERM-ignoring child is dead after before-quit, including past the grace deadline", async () => {
    await runCase({ ENTRY: "before-quit", MODE: "stubborn", GRACE_MS: "300" }, { afterMs: 400 });
  });

  it("covers the SIGINT entry point", async () => {
    await runCase({ ENTRY: "SIGINT", MODE: "stubborn", GRACE_MS: "300" }, { afterMs: 400 });
  });

  it("covers the SIGTERM entry point", async () => {
    await runCase({ ENTRY: "SIGTERM", MODE: "stubborn", GRACE_MS: "300" }, { afterMs: 400 });
  });

  it("cooperative children allow prompt exit without the full grace period", async () => {
    const fx = runReapParent({
      ENTRY: "before-quit",
      MODE: "cooperative",
      GRACE_MS: "2000",
    });
    let childPid = 0;
    const started = Date.now();
    try {
      const exited = await waitExit(fx.child);
      const elapsed = Date.now() - started;
      childPid = readPid(fx.pidfile);
      assert.equal(exited.code, 0);
      assert.ok(
        elapsed < 1000,
        `cooperative shutdown took ${elapsed}ms, expected well under 2000ms grace`,
      );
      if (childPid) assert.equal(alive(childPid), false);
    } finally {
      killLeftover(childPid);
      try {
        fs.rmSync(fx.dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("repeated quit/signal events still tear down once and exit once", async () => {
    await runCase(
      { ENTRY: "before-quit", MODE: "stubborn", GRACE_MS: "300", REPEAT: "1" },
      { afterMs: 400 },
    );
  });

  it("a stopRuns error still reaps remaining owned children then exits", async () => {
    await runCase(
      {
        ENTRY: "SIGINT",
        MODE: "stubborn",
        GRACE_MS: "300",
        THROW_STOP: "1",
      },
      { afterMs: 400 },
    );
  });
});
