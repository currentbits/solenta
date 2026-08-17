"use strict";

// The native application menu (spec §2; issue #353). Without an installed
// menu a packaged macOS build has no Edit menu, and Cmd+C/X/V/A silently die
// in text inputs — Electron only supplies a default menu in dev, which is
// why this never showed up while developing. Keep the template minimal and
// role-based so the OS supplies the standard items (including Services and
// emoji picker) for free.

/**
 * @param {{ platform?: NodeJS.Platform, appName?: string }} [opts]
 */
function appMenuTemplate(opts = {}) {
  const platform = opts.platform || process.platform;
  const appName = opts.appName || "Solenta";
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
function installAppMenu() {
  const { Menu } = require("electron");
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
}

module.exports = { appMenuTemplate, installAppMenu };
