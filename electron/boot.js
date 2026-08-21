"use strict";

/**
 * First-paint-first boot prefix (#618).
 *
 * Electron will not paint `backgroundColor` until the main process yields,
 * so the window is created, then we return to the event loop, then the
 * store loads. Memory supervision is kicked without awaiting: every
 * consumer already tolerates it being absent.
 *
 * @param {object} opts
 * @param {() => void} opts.createWindow
 * @param {() => unknown} opts.loadStore
 * @param {() => (void | Promise<unknown>)} opts.startMemory
 * @param {(err: unknown) => void} [opts.onMemoryError]
 * @param {() => (void | Promise<unknown>)} [opts.beforeStore]
 * @param {() => Promise<void>} [opts.yieldPaint]
 * @returns {Promise<unknown>}
 */
async function bootFirstPaint(opts) {
  const onMemoryError =
    typeof opts.onMemoryError === "function"
      ? opts.onMemoryError
      : (err) => {
          console.warn(
            "memory-server: supervisor start error; continuing without memory:",
            err && err.message ? err.message : err,
          );
        };

  opts.createWindow();
  await (typeof opts.yieldPaint === "function"
    ? opts.yieldPaint()
    : new Promise((r) => setImmediate(r)));

  if (typeof opts.beforeStore === "function") {
    await opts.beforeStore();
  }

  try {
    const started = opts.startMemory();
    if (started && typeof started.then === "function") {
      void started.catch(onMemoryError);
    }
  } catch (err) {
    onMemoryError(err);
  }

  return opts.loadStore();
}

module.exports = { bootFirstPaint };
