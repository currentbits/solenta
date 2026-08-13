"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const PUSH_CHANNELS = new Set([
  "threads:changed",
  "thread:updated",
  "thread:select",
]);

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
  automations: {
    list: () => invoke("automations:list"),
    add: (input) => invoke("automations:add", input),
    update: (input) => invoke("automations:update", input),
    remove: (input) => invoke("automations:remove", input),
    runNow: (input) => invoke("automations:runNow", input),
  },
  projects: {
    list: () => invoke("projects:list"),
    add: (projectPath) => invoke("projects:add", projectPath),
    addViaDialog: () => invoke("projects:addViaDialog"),
    remove: (input) => invoke("projects:remove", input),
  },
  threads: {
    list: () => invoke("threads:list"),
    search: (input) => invoke("threads:search", input),
    create: (input) => invoke("threads:create", input),
    fork: (input) => invoke("threads:fork", input),
    get: (id) => invoke("threads:get", id),
    setPermissionMode: (input) =>
      invoke("threads:setPermissionMode", input),
    setArchived: (input) => invoke("threads:setArchived", input),
    setSettled: (input) => invoke("threads:setSettled", input),
    setPinned: (input) => invoke("threads:setPinned", input),
    setSnoozed: (input) => invoke("threads:setSnoozed", input),
    setProvider: (input) => invoke("threads:setProvider", input),
    setReasoningEffort: (input) =>
      invoke("threads:setReasoningEffort", input),
    delete: (input) => invoke("threads:delete", input),
  },
  activity: {
    list: () => invoke("activity:list"),
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
    commit: (input) => invoke("git:commit", input),
    revertFile: (input) => invoke("git:revertFile", input),
    suggestCommitMessage: (input) => invoke("git:suggestCommitMessage", input),
    mergeWorktree: (input) => invoke("git:mergeWorktree", input),
    removeWorktree: (input) => invoke("git:removeWorktree", input),
    push: (input) => invoke("git:push", input),
    createPr: (input) => invoke("git:createPr", input),
    prStatus: (input) => invoke("git:prStatus", input),
    prChecks: (input) => invoke("git:prChecks", input),
    prMerge: (input) => invoke("git:prMerge", input),
    listPrs: (projectPath) => invoke("git:listPrs", projectPath),
    listCheckpoints: (input) => invoke("git:listCheckpoints", input),
    restoreCheckpoint: (input) => invoke("git:restoreCheckpoint", input),
    syncInfo: (input) => invoke("git:syncInfo", input),
    fetch: (input) => invoke("git:fetch", input),
    runStats: (input) => invoke("git:runStats", input),
  },
  issues: {
    fetch: (input) => invoke("issues:fetch", input),
  },
  files: {
    list: (input) => invoke("files:list", input),
  },
  servers: {
    list: (input) => invoke("servers:list", input),
  },
  shell: {
    reveal: (input) => invoke("shell:reveal", input),
    openPath: (input) => invoke("shell:openPath", input),
  },
  devserver: {
    scripts: (input) => invoke("devserver:scripts", input),
    start: (input) => invoke("devserver:start", input),
    stop: (input) => invoke("devserver:stop", input),
    status: (input) => invoke("devserver:status", input),
  },
  },
  on,
};

contextBridge.exposeInMainWorld("coder", coder);
