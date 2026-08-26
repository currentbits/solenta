"use strict";

/**
 * One-line message for a failed teardown step. No stack, no cause chain: this
 * goes to the user's console while the app is already on its way out.
 * @param {unknown} err
 */
function reason(err) {
  const message = err && err.message ? String(err.message) : String(err);
  return message.split("\n", 1)[0];
}

/**
 * App teardown, in the only order that is safe:
 *
 * 1. live runs, so nothing keeps writing while the rest goes away;
 * 2. the iOS simulator, whose recording finalization has to commit its
 *    artifacts and whose device ownership has to be released before exit;
 * 3. servers, schedulers, and child processes.
 *
 * Every phase is best-effort and isolated: a failing phase is logged and the
 * later ones still run, because a cleanup error must never leave a device
 * owned or an agent process group alive.
 *
 * @param {{
 *   stopRuns?: () => void | Promise<void>,
 *   shutdownSimulator?: () => void | Promise<void>,
 *   teardownServices?: () => void | Promise<void>,
 *   log?: (message: string) => void,
 * }} phases
 */
async function runAppCleanup(phases) {
  const { log } = phases || {};
  for (const name of ["stopRuns", "shutdownSimulator", "teardownServices"]) {
    const step = phases && phases[name];
    if (typeof step !== "function") continue;
    try {
      await step();
    } catch (err) {
      if (log) log(`shutdown: ${name} failed: ${reason(err)}`);
    }
  }
}

/**
 * One-shot app teardown shared by before-quit and SIGINT/SIGTERM.
 *
 * After agent CLIs spawn detached (their own process group), a default
 * SIGTERM kills Electron without before-quit and leaves those groups alive.
 * The signal handler must run the same cleanup, then die.
 *
 * Cleanup is awaitable (simulator recordings finalize on disk), so before-quit
 * is prevented and this owns the exit. Every entry point shares one cleanup
 * promise and exits exactly once, including when cleanup rejects.
 *
 * @param {{
 *   app: {
 *     on: (event: string, listener: (event?: { preventDefault?: () => void }) => void) => void,
 *     exit?: (code: number) => void,
 *   },
 *   exit?: (code: number) => void,
 *   cleanup: () => void | Promise<void>,
 *   log?: (message: string) => void,
 * }} opts
 * @returns {() => Promise<void>} shutdown, for tests
 */
function installShutdown({ app, exit, cleanup, log = (m) => console.warn(m) }) {
  // app.exit is immediate and skips before-quit/will-quit, unlike app.quit():
  // by the time we call it the cleanup this module owns has already run.
  const exitProcess =
    exit ||
    (typeof app.exit === "function"
      ? (code) => app.exit(code)
      : (code) => process.exit(code));
  /** @type {Promise<void> | null} */
  let cleanupPromise = null;
  let exited = false;

  function exitOnce(code) {
    if (exited) return;
    exited = true;
    exitProcess(code);
  }

  function shutdown() {
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve()
        .then(cleanup)
        .then(
          () => {},
          (err) => {
            // per-step try/catch lives in cleanup; this is so both the quit
            // and the signal path still reach exit if a step forgets one
            if (log) log(`shutdown: cleanup failed: ${reason(err)}`);
          },
        );
    }
    return cleanupPromise;
  }

  function shutdownThenExit() {
    void shutdown().then(() => exitOnce(0));
  }

  app.on("before-quit", (event) => {
    // Electron would tear the process down while the cleanup is still on its
    // first await; hold the quit and own the exit instead.
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    shutdownThenExit();
  });
  // process.exit/app.exit, not app.quit(): stopAll already SIGTERM'd agent
  // groups, and app.quit() is async and may not finish before the terminal is
  // gone (scripts/dev.js kills Electron then process.exit(0)s immediately).
  process.on("SIGINT", shutdownThenExit);
  process.on("SIGTERM", shutdownThenExit);
  return shutdown;
}

module.exports = { installShutdown, runAppCleanup };
