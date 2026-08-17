"use strict";

/**
 * One-shot app teardown shared by before-quit and SIGINT/SIGTERM.
 *
 * After agent CLIs spawn detached (their own process group), a default
 * SIGTERM kills Electron without before-quit and leaves those groups alive.
 * The signal handler must run the same cleanup, then die.
 *
 * @param {{
 *   app: { on: (event: string, listener: () => void) => void },
 *   exit?: (code: number) => void,
 *   cleanup: () => void,
 * }} opts
 * @returns {() => void} shutdown, for tests
 */
function installShutdown({ app, exit = (code) => process.exit(code), cleanup }) {
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      cleanup();
    } catch {
      // per-step try/catch lives in cleanup; this is so the signal path
      // still reaches exit if a future step forgets one
    }
  }
  app.on("before-quit", shutdown);
  function onSignal() {
    shutdown();
    // process.exit, not app.quit(): stopAll already SIGTERM'd agent groups.
    // app.quit() is async and may not finish before the terminal is gone
    // (scripts/dev.js kills Electron then process.exit(0)s immediately).
    exit(0);
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return shutdown;
}

module.exports = { installShutdown };
