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
    sync: () => invoke("skills:sync"),
    commands: (input) => invoke("skills:commands", input),
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
    lintAgentConfig: (input) => invoke("projects:lintAgentConfig", input),
    previewAgentConfig: (input) => invoke("projects:previewAgentConfig", input),
    writeAgentConfig: (input) => invoke("projects:writeAgentConfig", input),
  },
  spaces: {
    list: () => invoke("spaces:list"),
    add: (input) => invoke("spaces:add", input),
    update: (input) => invoke("spaces:update", input),
    remove: (input) => invoke("spaces:remove", input),
  },
  threads: {
    list: () => invoke("threads:list"),
    summaries: () => invoke("threads:summaries"),
    crewTasks: (input) => invoke("threads:crewTasks", input),
    search: (input) => invoke("threads:search", input),
    create: (input) => invoke("threads:create", input),
    fork: (input) => invoke("threads:fork", input),
    rewind: (input) => invoke("threads:rewind", input),
    get: (id) => invoke("threads:get", id),
    peek: (id) => invoke("threads:peek", id),
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
    setQuotaWaitAutoResume: (input) =>
      invoke("threads:setQuotaWaitAutoResume", input),
    setNotes: (input) => invoke("threads:setNotes", input),
    resolveSuggestion: (input) =>
      invoke("threads:resolveSuggestion", input),
    setFeltEstimate: (input) => invoke("threads:setFeltEstimate", input),
    startSpec: (input) => invoke("threads:startSpec", input),
    stopSpec: (input) => invoke("threads:stopSpec", input),
    reviewSpec: (input) => invoke("threads:reviewSpec", input),
    specArtifact: (input) => invoke("threads:specArtifact", input),
    dispatchSpec: (input) => invoke("threads:dispatchSpec", input),
    convergeSpec: (input) => invoke("threads:convergeSpec", input),
    startTeach: (input) => invoke("threads:startTeach", input),
    stopTeach: (input) => invoke("threads:stopTeach", input),
    startAsk: (input) => invoke("threads:startAsk", input),
    stopAsk: (input) => invoke("threads:stopAsk", input),
    btw: (input) => invoke("threads:btw", input),
    dismissBtw: (input) => invoke("threads:dismissBtw", input),
    promoteBtw: (input) => invoke("threads:promoteBtw", input),
    requestTeachReview: (input) =>
      invoke("threads:requestTeachReview", input),
    rename: (input) => invoke("threads:rename", input),
    setProvider: (input) => invoke("threads:setProvider", input),
    setReasoningEffort: (input) =>
      invoke("threads:setReasoningEffort", input),
    delete: (input) => invoke("threads:delete", input),
  },
  activity: {
    list: () => invoke("activity:list"),
  },
  usage: {
    byDay: () => invoke("usage:byDay"),
  },
  insights: {
    failureModes: () => invoke("insights:failureModes"),
  },
  fleet: {
    evidence: (input) => invoke("fleet:evidence", input),
  },
  digest: {
    list: (input) => invoke("digest:list", input),
    markSeen: (input) => invoke("digest:markSeen", input),
  },
  runs: {
    start: (input) => invoke("runs:start", input),
    startWorkflow: (input) => invoke("runs:startWorkflow", input),
    distill: (input) => invoke("runs:distill", input),
    stop: (input) => invoke("runs:stop", input),
    resumeQuotaWait: (input) => invoke("runs:resumeQuotaWait", input),
  },
  git: {
    status: (projectId) => invoke("git:status", projectId),
    setupWorktree: (input) => invoke("git:setupWorktree", input),
    diff: (input) => invoke("git:diff", input),
    reviewContext: (input) => invoke("git:reviewContext", input),
    setReviewAccepted: (input) => invoke("git:setReviewAccepted", input),
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
    conflictForecast: (input) => invoke("git:conflictForecast", input),
    gcScan: () => invoke("git:gcScan"),
    gcClean: (input) => invoke("git:gcClean", input),
  },
  vibeKanban: {
    preview: (input) => invoke("vibeKanban:preview", input),
    import: (input) => invoke("vibeKanban:import", input),
    pickDataDir: () => invoke("vibeKanban:pickDataDir"),
    export: () => invoke("vibeKanban:export"),
  },
  issues: {
    fetch: (input) => invoke("issues:fetch", input),
    list: (projectPath) => invoke("issues:list", projectPath),
    setPlanStatus: (input) => invoke("issues:setPlanStatus", input),
    create: (input) => invoke("issues:create", input),
  },
  files: {
    list: (input) => invoke("files:list", input),
    image: (input) => invoke("files:image", input),
    resolve: (input) => invoke("files:resolve", input),
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
  contextMenu: {
    show: (items, position) => invoke("contextMenu:show", items, position),
  },
  on,
};

contextBridge.exposeInMainWorld("coder", coder);
