"use strict";

// The native application menu (spec §2; issue #353). Without an installed
// menu a packaged macOS build has no Edit menu, and Cmd+C/X/V/A silently die
// in text inputs — Electron only supplies a default menu in dev, which is
// why this never showed up while developing. Keep the template minimal and
// role-based so the OS supplies the standard items (including Services and
// emoji picker) for free.

const { nudgeUiScale } = require("./zoom.js");

/**
 * @param {{
 *   platform?: NodeJS.Platform,
 *   appName?: string,
 *   applyZoom?: (win: unknown, factor: number) => void,
 *   getUiScale?: () => number,
 * }} [opts]
 */
function appMenuTemplate(opts = {}) {
  const platform = opts.platform || process.platform;
  const appName = opts.appName || "Solenta";
  const applyZoom = opts.applyZoom;
  const getUiScale = opts.getUiScale || (() => 1);
  const zoomIn = (_item, win) => {
    if (applyZoom) applyZoom(win, nudgeUiScale(getUiScale(), 1));
  };
  const zoomOut = (_item, win) => {
    if (applyZoom) applyZoom(win, nudgeUiScale(getUiScale(), -1));
  };
  const zoomReset = (_item, win) => {
    if (applyZoom) applyZoom(win, 1);
  };
  const template = [];
  if (platform === "darwin") {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    // Explicit View items so zoom can persist via applyZoom (issue #652).
    // role: "viewMenu" would keep reload/devtools/fullscreen but its zoom
    // roles never write settings.uiScale, so Settings and the menu would
    // disagree after a relaunch. List those roles ourselves.
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CommandOrControl+0",
          click: zoomReset,
        },
        {
          label: "Zoom In",
          accelerator: "CommandOrControl+Plus",
          click: zoomIn,
        },
        // Electron's built-in zoomIn also binds "=" (no Shift). Keep that
        // so ⌘= matches ⌘+ the way the old viewMenu role did.
        {
          label: "Zoom In",
          accelerator: "CommandOrControl+=",
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: zoomIn,
        },
        {
          label: "Zoom Out",
          accelerator: "CommandOrControl+-",
          click: zoomOut,
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "close" },
      ],
    },
  );
  return template;
}

/** Install the application menu. Call once, before the first window. */
function installAppMenu(opts = {}) {
  const { Menu } = require("electron");
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(opts)));
}

module.exports = { appMenuTemplate, installAppMenu };
