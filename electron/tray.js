"use strict";

/**
 * Windows/Linux close-to-tray (issue #1807). Off by default; opting in
 * keeps the app running after the window closes, same spirit as macOS
 * staying in the dock. The tray's own Quit (and the Quit menu, and an
 * updater restart) always call app.quit(), which still runs through the
 * normal before-quit confirm-active-work flow (electron/quitGuard.js,
 * electron/shutdown.js) — this module only ever decides whether a window
 * CLOSE event hides instead of quitting; it never touches the quit path.
 */

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether a window close event should hide the window instead of quitting.
 * False whenever a real quit is already underway (Quit menu, tray Quit,
 * updater restart, SIGINT/SIGTERM): that path calls app.quit()/app.exit()
 * directly and never goes through a window's close handler on its own, but
 * callers that also use this during teardown must not get hidden instead.
 *
 * @param {{ platform?: NodeJS.Platform, closeToTray?: boolean, shuttingDown?: boolean }} opts
 */
function shouldHideOnClose(opts = {}) {
  if (opts.shuttingDown) return false;
  if (!opts.closeToTray) return false;
  return opts.platform === "win32" || opts.platform === "linux";
}

/**
 * Pure menu template (testable without a real Electron Menu). Click
 * handlers are passed through as-is.
 *
 * @param {{ runningCount: number, onShow: () => void, onQuit: () => void }} opts
 */
function trayMenuTemplate({ runningCount, onShow, onQuit }) {
  return [
    { label: "Show Solenta", click: onShow },
    { label: plural(runningCount, "running thread", "running threads"), enabled: false },
    { type: "separator" },
    { label: "Quit", click: onQuit },
  ];
}

/**
 * Create and own the tray icon. `refresh()` rebuilds the context menu (the
 * running-thread count can change at any time); callers decide when to call
 * it — main.js calls it on "right-click" so the count is never stale.
 *
 * @param {{
 *   Tray: new (iconPath: string) => { setToolTip: (s: string) => void, setContextMenu: (m: unknown) => void, on: (ev: string, fn: () => void) => void, destroy: () => void },
 *   Menu: { buildFromTemplate: (t: unknown[]) => unknown },
 *   iconPath: string,
 *   getRunningCount: () => number,
 *   onShow: () => void,
 *   onQuit: () => void,
 * }} opts
 */
function createTray({ Tray, Menu, iconPath, getRunningCount, onShow, onQuit }) {
  const tray = new Tray(iconPath);
  tray.setToolTip("Solenta");
  function refresh() {
    const template = trayMenuTemplate({
      runningCount: Number(getRunningCount()) || 0,
      onShow,
      onQuit,
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }
  refresh();
  tray.on("click", onShow);
  tray.on("right-click", refresh);
  return {
    tray,
    refresh,
    destroy: () => tray.destroy(),
  };
}

module.exports = {
  shouldHideOnClose,
  trayMenuTemplate,
  createTray,
};
