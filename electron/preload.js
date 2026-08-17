"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const PUSH_CHANNELS = new Set([
  "threads:changed",
  "thread:updated",
  "thread:select",
]);

/**
 * Electron wraps every invoke rejection as
 * "Error invoking remote method 'chan': Error: <message>", which the UI then
 * shows verbatim — a main-process sentence reads like an internal crash
 * (issue #198). Markers (WORKTREE_DIRTY:, MERGE_CONFLICT:) sit after the
 * prefix, so stripping it leaves them intact.
 *
 * ponytail: inline and untested on purpose — this preload runs with
 * sandbox: true (main.js), which cannot require a local module to share or
 * unit-test the regex.
 */
const INVOKE_WRAP = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/;

/**
 * @param {string} channel
 * @param  {...unknown} args
 */
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(INVOKE_WRAP, "") || message);
  });
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
    checkUpdate: () => invoke("app:checkUpdate"),
    downloadUpdate: () => invoke("app:downloadUpdate"),
    applyUpdate: () => invoke("app:applyUpdate"),
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
  skills: {
    list: (input) => invoke("skills:list", input),
    add: (input) => invoke("skills:add", input),
    remove: (input) => invoke("skills:remove", input),
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
    add: (projectPath, opts) => invoke("projects:add", projectPath, opts),
    create: (input) => invoke("projects:create", input),
    pickDirectory: () => invoke("projects:pickDirectory"),
    update: (input) => invoke("projects:update", input),
    addViaDialog: () => invoke("projects:addViaDialog"),
    remove: (input) => invoke("projects:remove", input),
  },
  threads: {
    list: () => invoke("threads:list"),
    summaries: () => invoke("threads:summaries"),
    search: (input) => invoke("threads:search", input),
    create: (input) => invoke("threads:create", input),
    fork: (input) => invoke("threads:fork", input),
    get: (id) => invoke("threads:get", id),
    setPermissionMode: (input) =>
      invoke("threads:setPermissionMode", input),
    respondPermission: (input) =>
      invoke("threads:respondPermission", input),
    setArchived: (input) => invoke("threads:setArchived", input),
    setSettled: (input) => invoke("threads:setSettled", input),
    setPinned: (input) => invoke("threads:setPinned", input),
    setQueued: (input) => invoke("threads:setQueued", input),
    setSnoozed: (input) => invoke("threads:setSnoozed", input),
    setMuted: (input) => invoke("threads:setMuted", input),
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
    repoInfo: (input) => invoke("git:repoInfo", input),
    pull: (input) => invoke("git:pull", input),
    runStats: (input) => invoke("git:runStats", input),
  },
  issues: {
    fetch: (input) => invoke("issues:fetch", input),
    list: (projectPath) => invoke("issues:list", projectPath),
    setPlanStatus: (input) => invoke("issues:setPlanStatus", input),
  },
  files: {
    list: (input) => invoke("files:list", input),
    image: (input) => invoke("files:image", input),
  },
  attachments: {
    pick: () => invoke("attachments:pick"),
    fromPaths: (input) => invoke("attachments:fromPaths", input),
    saveImage: (input) => invoke("attachments:saveImage", input),
    readImage: (input) => invoke("attachments:readImage", input),
    // Drag-drop helper: File objects cannot cross IPC, so the path is
    // resolved in the preload (Electron >= 29) instead of via a channel.
    droppedFilePath: (file) => webUtils.getPathForFile(file),
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
  on,
};

contextBridge.exposeInMainWorld("coder", coder);
