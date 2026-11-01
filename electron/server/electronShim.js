"use strict";

/**
 * Stand-in for the `electron` module when Solenta runs as a plain-Node
 * server (#1829). main.js then boots exactly as `--headless --serve-web`:
 * real paths and app lifecycle, inert windows, menus and tray, no keychain.
 * Anything that needs a real desktop (dialogs, window capture, opening
 * apps) throws a plain error instead of half-working.
 */

const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const DESKTOP_ONLY = "This needs the Solenta desktop app; this computer runs the headless Solenta server.";

/** A value every property, call and `new` of which is itself. */
const inert = new Proxy(function inert() {}, {
  get: (_t, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : inert),
  apply: () => inert,
  construct: () => inert,
});

function desktopOnly() {
  return new Proxy({}, {
    get: (_t, key) => (key === "then" ? undefined : () => { throw new Error(DESKTOP_ONLY); }),
  });
}

/** Known names first; anything else main.js reaches for is inert. */
function withInertRest(obj) {
  return new Proxy(obj, { get: (t, key) => (key in t ? t[key] : inert) });
}

/**
 * @param {{ userData: string, appPath: string, version: string }} opts
 */
function createElectronShim({ userData, appPath, version }) {
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath(name) {
      if (name === "userData") return userData;
      if (name === "appData") return path.dirname(userData);
      if (name === "home") return os.homedir();
      if (name === "temp") return os.tmpdir();
      if (name === "logs") return path.join(userData, "logs");
      if (name === "downloads") return path.join(os.homedir(), "Downloads");
      if (name === "exe") return process.execPath;
      return path.join(userData, name);
    },
    getVersion: () => version,
    getName: () => "Solenta",
    getAppPath: () => appPath,
    getLocale: () => "en-US",
    isReady: () => true,
    whenReady: () => new Promise((resolve) => setImmediate(() => { app.emit("ready"); resolve(); })),
    requestSingleInstanceLock: () => true,
    quit: () => {
      app.emit("before-quit", { preventDefault() {} });
      app.emit("will-quit", { preventDefault() {} });
      process.exit(0);
    },
    exit: (code = 0) => process.exit(code),
    commandLine: { appendSwitch() {}, hasSwitch: () => false, getSwitchValue: () => "" },
  });
  const appProxy = withInertRest(app);

  class BrowserWindow {
    constructor() { throw new Error(DESKTOP_ONLY); }
    static getAllWindows() { return []; }
    static getFocusedWindow() { return null; }
    static fromWebContents() { return null; }
    static fromId() { return null; }
  }

  class Notification extends EventEmitter {
    static isSupported() { return false; }
    show() {}
    close() {}
  }

  const powerMonitor = Object.assign(new EventEmitter(), {
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => "active",
    isOnBatteryPower: () => false,
  });
  const nativeTheme = Object.assign(new EventEmitter(), {
    shouldUseDarkColors: true,
    themeSource: "system",
  });

  return withInertRest({
    app: appProxy,
    BrowserWindow,
    Notification,
    powerMonitor,
    nativeTheme,
    ipcMain: { handle() {}, handleOnce() {}, on() {}, once() {}, removeHandler() {}, removeAllListeners() {} },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error("No keychain on the headless server."); },
      decryptString: () => { throw new Error("No keychain on the headless server."); },
    },
    powerSaveBlocker: { start: () => 0, stop() {}, isStarted: () => false },
    clipboard: { readText: () => "", writeText() {}, readImage: () => inert, writeImage() {} },
    webContents: { getAllWebContents: () => [], fromId: () => null, getFocusedWebContents: () => null },
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 }, bounds: { x: 0, y: 0, width: 0, height: 0 }, scaleFactor: 1 }) },
    dialog: desktopOnly(),
    shell: desktopOnly(),
    desktopCapturer: desktopOnly(),
  });
}

module.exports = { createElectronShim, DESKTOP_ONLY };
