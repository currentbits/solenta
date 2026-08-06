const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("coder", {
  platform: process.platform,
});
