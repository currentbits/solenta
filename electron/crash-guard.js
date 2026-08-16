"use strict";

const fs = require("node:fs");
const path = require("node:path");

// A crash loop (a rejecting interval, say) must not fill the disk: after this
// many reports in one boot we keep logging to the console and leave the file
// alone.
// ponytail: per-boot cap, swap for real rotation only if crash.log matters
// enough to survive restarts.
const MAX_LOGGED = 50;

/**
 * Keep the main process alive through unhandled rejections and uncaught
 * exceptions. Node makes both fatal, so one stray `void promise` anywhere in
 * electron/ takes the app down mid-run and every in-flight thread with it
 * (recoverInterruptedRuns only gets to mark them failed on the next boot).
 * Log it, tell the user once, carry on: the process is no worse off than it
 * was one statement earlier, and nothing here is worth losing a run over.
 *
 * @param {{
 *   userDataPath?: string,
 *   notify?: (message: string, logPath: string | null) => void,
 * }} opts
 * @returns {(kind: string, err: unknown) => void} the same reporter the
 *   process handlers use, exposed for tests.
 */
function installCrashGuard({ userDataPath, notify } = {}) {
  const logPath = userDataPath ? path.join(userDataPath, "crash.log") : null;
  let logged = 0;
  let notified = false;

  function report(kind, err) {
    const detail = err && err.stack ? err.stack : String(err);
    console.error(`solenta: ${kind}: ${detail}`);

    if (logPath && logged < MAX_LOGGED) {
      logged += 1;
      try {
        fs.appendFileSync(
          logPath,
          `[${new Date().toISOString()}] ${kind}: ${detail}\n`,
        );
      } catch {
        // A log we cannot write is not worth crashing over.
      }
    }

    // One notification per boot: the second error is usually the first one
    // repeating, and a notification storm is worse than the bug.
    if (notify && !notified) {
      notified = true;
      try {
        notify(err && err.message ? String(err.message) : String(err), logPath);
      } catch {
        // ditto
      }
    }
  }

  process.on("unhandledRejection", (err) => report("unhandledRejection", err));
  process.on("uncaughtException", (err) => report("uncaughtException", err));

  return report;
}

module.exports = { installCrashGuard, MAX_LOGGED };
