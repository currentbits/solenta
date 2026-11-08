"use strict";

// Run in a fresh process so every target and transitive dependency is loaded
// after the guard is installed. HTTP/HTTPS servers use net.Server.listen too.
const net = require("node:net");
const Module = require("node:module");
let listenAttempts = 0;
net.Server.prototype.listen = function () {
  listenAttempts++;
  throw new Error("Unexpected listener creation during module import");
};
// Even an import that catches the listen error must fail the probe. Waiting for
// beforeExit also covers nextTick, promises, immediates and scheduled timers.
process.once("beforeExit", () => {
  if (listenAttempts) {
    console.error(`Unexpected listener creation: ${listenAttempts} listen attempt(s)`);
    process.exitCode = 1;
  }
});

// ipc.js needs Electron at load; this child must never start the desktop app.
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    return {
      ipcMain: { handle() {} },
      BrowserWindow: { getAllWindows: () => [] },
      dialog: {},
      shell: {},
      app: { getPath: () => process.env.HOME },
    };
  }
  return originalLoad.apply(this, arguments);
};

for (const target of process.argv.slice(2)) require(target);
