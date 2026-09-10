"use strict";

/**
 * Disposable Node parent for #1232: real installShutdown + runAppCleanup
 * with a stub Electron app (app.exit = process.exit). Spawns a detached
 * child, waits for READY, then tears down through the production shutdown
 * helpers and exits. The outer test watches the child's heartbeat file.
 *
 * Env:
 *   HEARTBEAT  path written every 50ms by the child
 *   PIDFILE    child pid
 *   GRACE_MS   SIGKILL deadline (default 300)
 *   ENTRY      before-quit | SIGINT | SIGTERM
 *   MODE       stubborn (ignore SIGTERM) | cooperative
 *   THROW_STOP if "1", stopRuns throws after starting teardown
 *   REPEAT     if "1", fire every entry point once teardown starts
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { installShutdown, runAppCleanup } = require("../../shutdown.js");
const { reapTree } = require("../../proc.js");

const heartbeat = process.env.HEARTBEAT;
const pidfile = process.env.PIDFILE;
const graceMs = Number(process.env.GRACE_MS || 300);
const entry = process.env.ENTRY || "before-quit";
const mode = process.env.MODE || "stubborn";
const throwStop = process.env.THROW_STOP === "1";
const repeat = process.env.REPEAT === "1";

if (!heartbeat || !pidfile) {
  process.stderr.write("HEARTBEAT and PIDFILE are required\n");
  process.exit(2);
}

const childSrc =
  mode === "cooperative"
    ? `
      const fs = require("node:fs");
      process.stdout.write("READY\\n");
      setInterval(() => {
        try { fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())); } catch {}
      }, 50);
    `
    : `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      process.stdout.write("READY\\n");
      setInterval(() => {
        try { fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())); } catch {}
      }, 50);
    `;

const child = spawn(process.execPath, ["-e", childSrc], {
  detached: true,
  stdio: ["ignore", "pipe", "ignore"],
});

if (!child.pid) {
  process.stderr.write("failed to spawn child\n");
  process.exit(2);
}
fs.writeFileSync(pidfile, String(child.pid));

function ready() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no READY")), 5000);
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("READY")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      reject(new Error(`child exited before READY (${code}/${signal})`));
    });
  });
}

function fire(app) {
  if (entry === "SIGINT" || entry === "SIGTERM") {
    process.emit(entry);
  } else {
    app.emit("before-quit", {
      preventDefault() {},
    });
  }
  if (repeat) {
    process.emit("SIGINT");
    process.emit("SIGTERM");
    app.emit("before-quit", { preventDefault() {} });
  }
}

ready()
  .then(() => {
    const app = new EventEmitter();
    installShutdown({
      app,
      exit: (code) => process.exit(code),
      cleanup: () =>
        runAppCleanup({
          stopRuns: async () => {
            if (throwStop) throw new Error("stopRuns blew up");
            await reapTree(child, graceMs);
          },
          // A failed stopRuns must not skip later owned-child teardown.
          teardownServices: throwStop
            ? () => reapTree(child, graceMs)
            : undefined,
        }),
    });
    fire(app);
  })
  .catch((err) => {
    process.stderr.write(String(err && err.message ? err.message : err) + "\n");
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    process.exit(2);
  });
