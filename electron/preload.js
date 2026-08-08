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
  app: {
    status: () => invoke("app:status"),
  },
  memory: {
    search: (input) => invoke("memory:search", input),
    recent: (input) => invoke("memory:recent", input),
    get: (input) => invoke("memory:get", input),
    store: (input) => invoke("memory:store", input),
    update: (input) => invoke("memory:update", input),
    remove: (input) => invoke("memory:remove", input),
  },
  settings: {
    get: () => invoke("settings:get"),
    set: (patch) => invoke("settings:set", patch),
  },
  providers: {
    list: () => invoke("providers:list"),
  },
  workflows: {
    list: () => invoke("workflows:list"),
    save: (template) => invoke("workflows:save", template),
    remove: (input) => invoke("workflows:remove", input),
  },
  projects: {
    list: () => invoke("projects:list"),
    add: (projectPath) => invoke("projects:add", projectPath),
    addViaDialog: () => invoke("projects:addViaDialog"),
  },
  threads: {
    list: () => invoke("threads:list"),
    search: (input) => invoke("threads:search", input),
    create: (input) => invoke("threads:create", input),
    get: (id) => invoke("threads:get", id),
    setPermissionMode: (input) =>
      invoke("threads:setPermissionMode", input),
    setArchived: (input) => invoke("threads:setArchived", input),
    setProvider: (input) => invoke("threads:setProvider", input),
    delete: (input) => invoke("threads:delete", input),
  },
  runs: {
    start: (input) => invoke("runs:start", input),
    startWorkflow: (input) => invoke("runs:startWorkflow", input),
    stop: (input) => invoke("runs:stop", input),
  },
  git: {
    status: (projectId) => invoke("git:status", projectId),
    setupWorktree: (input) => invoke("git:setupWorktree", input),
    diff: (input) => invoke("git:diff", input),
    mergeWorktree: (input) => invoke("git:mergeWorktree", input),
    removeWorktree: (input) => invoke("git:removeWorktree", input),
    push: (input) => invoke("git:push", input),
    createPr: (input) => invoke("git:createPr", input),
    prStatus: (input) => invoke("git:prStatus", input),
  },
  on,
};

contextBridge.exposeInMainWorld("coder", coder);
