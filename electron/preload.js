"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const PUSH_CHANNELS = new Set(["threads:changed", "thread:updated"]);

/**
 * @param {string} channel
 * @param  {...unknown} args
 */
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * @param {string} channel
 * @param {(payload: unknown) => void} cb
 * @returns {() => void}
 */
function on(channel, cb) {
  if (!PUSH_CHANNELS.has(channel)) {
    throw new Error(`Push channel not allowed: ${channel}`);
  }
  const listener = (_event, payload) => {
    cb(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** @type {import('../src/shared/ipc').CoderApi} */
const coder = {
  projects: {
    list: () => invoke("projects:list"),
    add: (projectPath) => invoke("projects:add", projectPath),
    addViaDialog: () => invoke("projects:addViaDialog"),
  },
  threads: {
    list: () => invoke("threads:list"),
    create: (input) => invoke("threads:create", input),
    get: (id) => invoke("threads:get", id),
    setPermissionMode: (input) =>
      invoke("threads:setPermissionMode", input),
    setArchived: (input) => invoke("threads:setArchived", input),
    delete: (input) => invoke("threads:delete", input),
  },
  runs: {
    start: (input) => invoke("runs:start", input),
    stop: (input) => invoke("runs:stop", input),
  },
  git: {
    status: (projectId) => invoke("git:status", projectId),
    setupWorktree: (input) => invoke("git:setupWorktree", input),
    diff: (input) => invoke("git:diff", input),
    mergeWorktree: (input) => invoke("git:mergeWorktree", input),
    removeWorktree: (input) => invoke("git:removeWorktree", input),
  },
  on,
};

contextBridge.exposeInMainWorld("coder", coder);
