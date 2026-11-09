"use strict";

const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("solentaCloudSession", {
  getCredentials: () => ipcRenderer.invoke("cloud-window:session"),
  subscribeCredentials: listener => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("cloud-window:changed", handler);
    return () => ipcRenderer.removeListener("cloud-window:changed", handler);
  },
});
