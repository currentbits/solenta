"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { installShutdown, runAppCleanup } = require("../shutdown.js");
const { awaitKillTree } = require("../proc.js");

const posix = process.platform !== "win32";

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

  it("still reaps owned children when an earlier phase throws", async (t) => {
    if (!posix) return t.skip("POSIX signals");
    const ready = path.join(
      os.tmpdir(),
      `coder-shutdown-ready-${process.pid}-${Date.now()}`,
    );
    const child = spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(ready)},"READY");setInterval(()=>{},50);`,
      ],
      { detached: true, stdio: "ignore" },
    );
    const t0 = Date.now();
    while (!fs.existsSync(ready) && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(fs.existsSync(ready), true, "child READY handshake");
    try {
      fs.unlinkSync(ready);
    } catch {
      // ignore
    }
    try {
      await runAppCleanup({
        stopRuns: () => {
          throw new Error("runs blew up");
        },
        shutdownSimulator: () => {},
        teardownServices: () => awaitKillTree(child, 200),
      });
      try {
        process.kill(child.pid, 0);
        assert.fail("child still running after teardownServices");
      } catch {
        // ESRCH: reaped
      }
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
  });
});

/**
 * Disposable Node parent that loads the real shutdown helpers, owns a
 * detached child, then app.exit()s. Mirrors the #1232 reproduction.
 */
function writeQuitFixture(dir, { mode, entry, graceMs }) {
  const shutdownPath = require.resolve("../shutdown.js");
  const procPath = require.resolve("../proc.js");
  const src = `"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { installShutdown, runAppCleanup } = require(${JSON.stringify(shutdownPath)});
const { awaitKillTree } = require(${JSON.stringify(procPath)});

const readyPath = process.env.READY_PATH;
const beatPath = process.env.BEAT_PATH;
const elapsedPath = process.env.ELAPSED_PATH;
const graceMs = ${Number(graceMs) || 250};
const mode = ${JSON.stringify(mode)};
const entry = ${JSON.stringify(entry)};

const childSrc =
  mode === "stubborn"
    ? 'process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.env.READY_PATH,"READY");setInterval(()=>require("fs").appendFileSync(process.env.BEAT_PATH,String(Date.now())+"\\\\n"),50);'
    : 'require("fs").writeFileSync(process.env.READY_PATH,"READY");setInterval(()=>{},100);';

const child = spawn(process.execPath, ["-e", childSrc], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, READY_PATH: readyPath, BEAT_PATH: beatPath },
});

function waitReady() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fs.existsSync(readyPath)) return resolve();
      if (Date.now() - t0 > 5000) return reject(new Error("no READY"));
      setTimeout(tick, 15);
    };
    tick();
  });
}

const app = new EventEmitter();
installShutdown({
  app,
  exit: (code) => process.exit(code ?? 0),
  cleanup: () =>
    runAppCleanup({
      async stopRuns() {
        const t0 = Date.now();
        await awaitKillTree(child, graceMs);
        try {
          fs.writeFileSync(elapsedPath, String(Date.now() - t0));
        } catch {
          // ignore
        }
      },
    }),
});

waitReady()
  .then(() => {
    if (entry === "sigint") process.emit("SIGINT");
    else if (entry === "sigterm") process.emit("SIGTERM");
    else app.emit("before-quit", { preventDefault() {} });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
`;
  const file = path.join(dir, "quit-parent.js");
  fs.writeFileSync(file, src);
  return file;
}

function readBeats(beatPath) {
  try {
    return fs
      .readFileSync(beatPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

describe("quit kill escalation (#1232)", { skip: !posix }, () => {
  const temps = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  async function runParent({ mode, entry, graceMs = 250 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-quit-kill-"));
    temps.push(dir);
    const readyPath = path.join(dir, "ready");
    const beatPath = path.join(dir, "beat");
    const elapsedPath = path.join(dir, "elapsed");
    const parentJs = writeQuitFixture(dir, { mode, entry, graceMs });
    const parent = spawn(process.execPath, [parentJs], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        READY_PATH: readyPath,
        BEAT_PATH: beatPath,
        ELAPSED_PATH: elapsedPath,
      },
    });
    const errChunks = [];
    parent.stderr.setEncoding("utf8");
    parent.stderr.on("data", (c) => errChunks.push(c));
    const status = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          parent.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error(`parent hung: ${errChunks.join("")}`));
      }, 8000);
      parent.on("exit", (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
      parent.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    let elapsed = Number.NaN;
    try {
      elapsed = Number(fs.readFileSync(elapsedPath, "utf8").trim());
    } catch {
      // missing
    }
    return { dir, beatPath, elapsed, status, stderr: errChunks.join("") };
  }

  it("handshake/heartbeat: SIGTERM-ignoring child stops executing after shutdown", async () => {
    const { beatPath, elapsed, status } = await runParent({
      mode: "stubborn",
      entry: "before-quit",
      graceMs: 250,
    });
    assert.equal(status.code, 0, `parent exit ${status.code} ${status.signal}`);
    assert.ok(elapsed >= 100, `grace skipped (${elapsed}ms)`);
    assert.ok(elapsed < 2000, `quit hung (${elapsed}ms)`);
    const atExit = readBeats(beatPath);
    assert.ok(atExit.length > 0, "child must have heartbeated before kill");
    await new Promise((r) => setTimeout(r, 400));
    const later = readBeats(beatPath);
    assert.deepEqual(
      later,
      atExit,
      "heartbeat advanced after parent exit — SIGKILL never landed",
    );
    const last = atExit[atExit.length - 1];
    assert.ok(
      Number.isFinite(last),
      "last heartbeat must be a timestamp",
    );
  });

  it("cooperative children exit without waiting the full grace", async () => {
    const { elapsed, status } = await runParent({
      mode: "cooperative",
      entry: "before-quit",
      graceMs: 3000,
    });
    assert.equal(status.code, 0);
    assert.ok(elapsed < 1000, `waited the full grace (${elapsed}ms)`);
  });

  it("SIGINT entry point also completes escalation before exit", async () => {
    const { beatPath, status } = await runParent({
      mode: "stubborn",
      entry: "sigint",
      graceMs: 250,
    });
    assert.equal(status.code, 0);
    const atExit = readBeats(beatPath);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(readBeats(beatPath), atExit);
  });

  it("SIGTERM entry point also completes escalation before exit", async () => {
    const { beatPath, status } = await runParent({
      mode: "stubborn",
      entry: "sigterm",
      graceMs: 250,
    });
    assert.equal(status.code, 0);
    const atExit = readBeats(beatPath);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(readBeats(beatPath), atExit);
  });
});
