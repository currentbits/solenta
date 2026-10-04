"use strict";

// Thread create, fork, provider, rename, rewind, trash and listing.

const { randomUUID } = require("node:crypto");
const {
  getProvider,
  listProviders,
  honouredEfforts,
  probeCatalogCli,
  catalogCliProbeStarted,
  honouredPermissionModes,
} = require("./providers.js");
const { resolveSandbox } = require("./sandbox.js");
const { scheduleImagePruneFromStore } = require("./image-store.js");
const {
  PERMISSION_MODES,
  scheduleArtifactCleanup,
  scheduleSimulatorRelease,
  canHostWorktree,
  purgeThread,
} = require("./services-shared.js");
const {
  truncateThreadTitle,
  resolveOrdinaryForkTitle,
  resolveWorkerTitle,
  normalizeModelForProvider,
  isKnownProviderId,
} = require("./services-notes.js");
const {
  teachAutonomyFor,
  teachPermissionAllowed,
  snapPermissionModeForThread,
} = require("./services-teach.js");

/**
 * Provider for a newly created thread (issue #711). Explicit input wins,
 * then settings.defaultProvider, then the historical "claude" default.
 * Unknown ids fall through so a stale setting cannot mint an unrunnable thread.
 * @param {{ provider?: unknown } | null | undefined} input
 * @param {{ defaultProvider?: unknown } | null | undefined} settings
 * @returns {string}
 */
function resolveNewThreadProvider(input, settings) {
  const fromInput =
    input && typeof input.provider === "string" ? input.provider.trim() : "";
  if (fromInput && isKnownProviderId(fromInput)) return fromInput;
  const fromSettings =
    settings && typeof settings.defaultProvider === "string"
      ? settings.defaultProvider.trim()
      : "";
  if (fromSettings && isKnownProviderId(fromSettings)) return fromSettings;
  return "claude";
}

/**
 * Model for a newly created thread. Explicit input.model wins (including
 * null). Otherwise settings.defaultModel applies only when the provider
 * also came from settings — an explicit provider should not inherit a
 * model saved for a different CLI.
 * @param {{ provider?: unknown, model?: unknown } | null | undefined} input
 * @param {{ defaultProvider?: unknown, defaultModel?: unknown } | null | undefined} settings
 * @param {string} provider
 * @returns {string | null}
 */
function resolveNewThreadModel(input, settings, provider) {
  const entry = getProvider(provider);
  if (input && Object.prototype.hasOwnProperty.call(input, "model")) {
    try {
      return normalizeModelForProvider(entry, input.model);
    } catch {
      return null;
    }
  }
  const explicitProvider =
    input && typeof input.provider === "string" && input.provider.trim();
  if (explicitProvider) return null;
  const fromSettings =
    settings && typeof settings.defaultModel === "string"
      ? settings.defaultModel
      : null;
  try {
    return normalizeModelForProvider(entry, fromSettings);
  } catch {
    return null;
  }
}

/** Sanitize ThreadInfo.baseBranch (#187). Empty/null clears to the repo default. */
function normalizeBaseBranch(value) {
  if (value == null) return null;
  const name = String(value).trim();
  if (!name) return null;
  if (name === "HEAD" || name.includes("..") || /[\s~^:?*\[\\]/.test(name)) {
    throw new Error(`Invalid base branch: ${name}`);
  }
  return name;
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, title: string, worktree?: boolean, automationId?: string | null, issueNumber?: number | null, provider?: string, model?: string | null, memoryConsolidate?: boolean, baseBranch?: string | null }} input
 * `worktree` is only consumed by the IPC layer (threads:create), which calls
 * setupWorktree after this returns; the service itself stays fs-free.
 * `automationId` tags threads minted by an automation so runAutomation can
 * retain only the last N (issue #134). Absent / falsy on hand-made threads.
 * `issueNumber` is the planboard issue this thread was started from (#420).
 * `provider`/`model` override settings.defaultProvider/defaultModel (#711).
 * `memoryConsolidate` tags the sleep-time memory pass (issue #722).
 * `baseBranch` is the optional stacked merge/PR base (#187).
 */
function normalizeBaseBranch(value) {
  if (value == null) return null;
  const name = String(value).trim();
  if (!name) return null;
  if (name === "HEAD" || name.includes("..") || /[\s~^:?*\[\\]/.test(name)) {
    throw new Error(`Invalid base branch: ${name}`);
  }
  return name;
}

function createThread(store, input) {
  const project = store.getProject(input.projectId);
  if (!project) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }

  const settings =
    typeof store.getSettings === "function" ? store.getSettings() : null;
  const provider = resolveNewThreadProvider(input, settings);
  const model = resolveNewThreadModel(input, settings, provider);

  const now = Date.now();
  const thread = {
    id: randomUUID(),
    projectId: input.projectId,
    // Same title length convention as auto-rename from first prompt line.
    title: truncateThreadTitle(input.title || "New Thread"),
    branch: null,
    baseBranch: normalizeBaseBranch(input.baseBranch),
    prNumber: null,
    prUrl: null,
    status: "idle",
    lastError: null,
    lastErrorKind: null,
    createdAt: now,
    updatedAt: now,
    runStartedAt: null,
    stoppedAt: null,
    archived: false,
    settledOverride: null,
    settledAt: null,
    prState: null,
    prMergeable: null,
    // Just-created is not unread: visit time matches creation.
    lastVisitedAt: now,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    notes: "",
    messagePins: [],
    tags: [],
    verifyCommand: null,
    verify: null,
    issueNumber: require("./postmerge.js").normalizeIssueNumber(input.issueNumber),
    postMergeVerify: null,
    provider,
    model,
    sessionId: null,
    permissionMode: "default",
    reasoningEffort: null,
    webSearch: false,
    worktreePath: null,
    handoffFrom: null,
    automationId: input.automationId || null,
    queued: null,
    ask: input.ask === true,
    ...(input.memoryConsolidate === true
      ? { memoryConsolidate: true }
      : {}),
  };

  const threads = store.getThreads().slice();
  threads.push(thread);
  store.setThreads(threads);
  store.setMessages(thread.id, []);
  store.setWorkLog(thread.id, []);
  store.save();
  return thread;
}

/**
 * @param {import('./store').Store} store
 * @param {{ threadId: string, mode: string }} input
 */
function setPermissionMode(store, input) {
  const { threadId, mode } = input;
  if (!PERMISSION_MODES.has(mode)) {
    throw new Error(
      `Invalid permission mode: ${mode}. Expected one of: ${[...PERMISSION_MODES].join(", ")}`,
    );
  }
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!teachPermissionAllowed(mode, thread.teach)) {
    const level = (thread.teach && thread.teach.autonomy) || "hint";
    throw new Error(
      `Teach mode (${level}) does not allow permission mode ${mode}`,
    );
  }
  const entry = getProvider(thread.provider);
  const allowed = honouredPermissionModes(entry);
  if (!allowed.includes(mode)) {
    const providerName =
      (entry && entry.name) || thread.provider || "provider";
    throw new Error(
      `${providerName} does not support permission mode "${mode}"`,
    );
  }
  /** @type {Record<string, unknown>} */
  const patch = { permissionMode: mode };
  // Leaving plan mode dismisses a persisted approval card (issue #707).
  // Switching the picker is "I don't want plan mode", not "approve this".
  if (mode !== "plan" && thread.pendingPlan) {
    patch.pendingPlan = null;
    if (!thread.pendingQuestion) patch.awaitingInput = false;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  const row = updated || { ...thread, ...patch };
  return decorateThread(store, row);
}

/**
 * Set reasoning effort for a thread. null always means "provider default".
 * Rejects levels the thread's provider does not honour so a setting that
 * would never reach the CLI cannot be stored.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, effort: string | null }} input
 */
function setReasoningEffort(store, input) {
  const { threadId, effort } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  if (effort === null || effort === undefined) {
    const updated = store.updateThread(threadId, { reasoningEffort: null });
    store.save();
    return updated ? { ...updated } : { ...thread, reasoningEffort: null };
  }

  const level = String(effort);
  const entry = getProvider(thread.provider);
  const allowed = honouredEfforts(entry, thread.model);
  if (!allowed.includes(level)) {
    const providerName =
      (entry && entry.name) || thread.provider || "provider";
    throw new Error(
      `${providerName} does not support reasoning effort "${level}"`,
    );
  }

  const updated = store.updateThread(threadId, { reasoningEffort: level });
  store.save();
  return updated ? { ...updated } : { ...thread, reasoningEffort: level };
}

/**
 * Enable or disable Codex live web search (`codex exec --search`) for a
 * thread. `webSearch: false` is always allowed. `true` is rejected unless
 * the thread's provider advertises supportsSearch, so a setting that would
 * never reach the CLI cannot be stored.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, webSearch: boolean }} input
 */
function setWebSearch(store, input) {
  const { threadId } = input;
  const enabled = input.webSearch === true;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  if (enabled) {
    const entry = getProvider(thread.provider);
    if (!entry || entry.supportsSearch !== true) {
      const providerName =
        (entry && entry.name) || thread.provider || "provider";
      throw new Error(`${providerName} does not support web search`);
    }
  }

  const updated = store.updateThread(threadId, { webSearch: enabled });
  store.save();
  return updated ? { ...updated } : { ...thread, webSearch: enabled };
}

/**
 * Fork / hand off: new thread in the source's project. Source is never modified.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, provider?: string, model?: string | null, worktree?: boolean, title?: string }} input
 * @returns {object}
 */
function forkThread(store, input) {
  const sourceId = input && input.threadId;
  const source = store.getThread(sourceId);
  if (!source) {
    throw new Error(`Unknown thread: ${sourceId}`);
  }

  const providerProvided = Object.prototype.hasOwnProperty.call(
    input,
    "provider",
  );
  const modelProvided = Object.prototype.hasOwnProperty.call(input, "model");

  let nextProvider = source.provider;
  if (providerProvided) {
    const id = String(input.provider || "");
    if (!isKnownProviderId(id)) {
      throw new Error(`Unknown provider: ${input.provider}`);
    }
    nextProvider = id;
  }

  const providerChanging =
    providerProvided && String(nextProvider) !== String(source.provider);

  let nextModel = source.model;
  const nextEntry = getProvider(nextProvider);
  if (providerChanging) {
    // Same rule as setProvider: do not carry the old provider's model across
    // unless this call supplies one valid for the NEW provider.
    if (modelProvided) {
      nextModel = normalizeModelForProvider(nextEntry, input.model);
    } else {
      nextModel = null;
    }
  } else if (modelProvided) {
    nextModel = normalizeModelForProvider(nextEntry, input.model);
  }

  const sourceTitle =
    source.title != null && String(source.title) !== ""
      ? String(source.title)
      : "New Thread";
  // createThread applies THREAD_TITLE_MAX. Ordinary forks keep one `Fork:`
  // prefix; an explicit title (workers) skips the prefix entirely.
  const created = createThread(store, {
    projectId: source.projectId,
    title: resolveOrdinaryForkTitle(input && input.title, sourceTitle),
  });

  // createThread stamps lastVisitedAt = createdAt and handoffFrom null;
  // patch config + provenance. sessionId stays null (fresh session).
  const forkPatch = {
    provider: nextProvider,
    model: nextModel,
    permissionMode: source.permissionMode,
    handoffFrom: source.id,
    sessionId: null,
  };
  // Teach mode is a thread persona, not a session: forks (including
  // orchestrator workers on another provider) stay in teach mode.
  if (source.teach && source.teach.autonomy) {
    const reviewsPassed = Number(source.teach.reviewsPassed) || 0;
    forkPatch.teach = {
      autonomy: teachAutonomyFor(reviewsPassed),
      reviewsPassed,
    };
  }
  // Same rule as setProvider (issue #177): a mode the new provider cannot
  // honour must not be copied onto the fork. Teach-mode caps still win.
  forkPatch.permissionMode = snapPermissionModeForThread(
    nextEntry,
    source.permissionMode,
    forkPatch.teach,
  );
  // Ask mode is the same: a fork of a read-only Q&A thread stays read-only
  // and must not grow a worktree (issue #392).
  if (source.ask === true) {
    forkPatch.ask = true;
  }
  // Opt-in worktree for user-facing forks (issue #550 chips). Same guards
  // as forkWorkerThread: not an Ask thread, project can host a worktree.
  if (input.worktree === true) {
    const projectId = created.projectId ?? source.projectId;
    const project =
      typeof store.getProject === "function" && projectId != null
        ? store.getProject(projectId)
        : null;
    const sourceAsk = Boolean(source.ask) || Boolean(forkPatch.ask);
    if (!sourceAsk && canHostWorktree(project)) {
      forkPatch.pendingWorktree = true;
    }
  }
  const updated = store.updateThread(created.id, forkPatch);
  store.save();
  return updated ? { ...updated } : { ...created, ...forkPatch };
}

/**
 * Fork a thread into an orchestration WORKER: flagged orchWorker (the runner
 * auto-archives it when its run lands, issue #14) and isolated in its own
 * worktree so N parallel workers never edit the same checkout (issue #30).
 * Lazy like threads:create — startRun materializes the worktree.
 *
 * Shared by orchServer's thread_fork tool and the runner's pendingFork
 * dispatch so the two definitions of "a worker" cannot drift apart. Starting
 * the run is the caller's job: services must not depend on the runner.
 * Worktree workers record the lead's committed HEAD (`leadSnapshotSha`)
 * at fork time so lazy materialization can start from that exact SHA
 * even if the lead advances (issue #948). That start ref is not
 * `baseBranch` (the merge/PR destination).
 *
 * @param {any} store
 * @param {{ threadId: string, provider?: string, model?: string | null, pool?: string, worktree?: boolean, title?: string, prompt?: string }} input
 * @param {(store: any, input: any) => any} [forkImpl] seam for tests
 * @returns {any} the new worker thread
 */
function forkWorkerThread(store, input, forkImpl = forkThread) {
  const {
    resolveSubagentPool,
    poolFromStore,
  } = require("./subagentPool");
  const resolved = resolveSubagentPool(poolFromStore(store), {
    pool: input.pool,
    provider: input.provider,
  });

  /** @type {{ threadId: string, provider?: string, model?: string | null, title?: string }} */
  const forkInput = { threadId: input.threadId };
  const workerTitle = resolveWorkerTitle(input);
  if (workerTitle) forkInput.title = workerTitle;
  if (resolved) {
    forkInput.provider = resolved.provider;
    if (resolved.fromPool) {
      forkInput.model = resolved.model;
    } else if (Object.prototype.hasOwnProperty.call(input, "model")) {
      forkInput.model = input.model;
    }
  } else if (input.provider != null) {
    forkInput.provider = input.provider;
    if (Object.prototype.hasOwnProperty.call(input, "model")) {
      forkInput.model = input.model;
    }
  } else if (Object.prototype.hasOwnProperty.call(input, "model")) {
    forkInput.model = input.model;
  }
  const source = store.getThread(input.threadId);
  const projectId = source ? source.projectId : null;
  const project =
    typeof store.getProject === "function" && projectId != null
      ? store.getProject(projectId)
      : null;
  // Ask workers stay in the checkout — a worktree would burn the isolation
  // Ask exists to avoid (issue #392).
  const sourceAsk = Boolean(source && source.ask);
  const wantsWorktree =
    input.worktree !== false && !sourceAsk && canHostWorktree(project);

  /** @type {{ sha: string, branch: string | null, dirty: boolean } | null} */
  let snapshot = null;
  if (wantsWorktree) {
    const { captureLeadSnapshot } = require("./worktrees.js");
    snapshot = captureLeadSnapshot(store, source);
  }

  const fork = forkImpl(store, forkInput);

  const patch = { orchWorker: true };
  if (resolved && resolved.fromPool && resolved.alias) {
    patch.poolAlias = resolved.alias;
  }
  if (wantsWorktree && snapshot) {
    patch.pendingWorktree = true;
    patch.leadSnapshotSha = snapshot.sha;
    patch.leadSnapshotBranch = snapshot.branch;
    if (snapshot.dirty) patch.leadSnapshotDirty = true;
  }
  const updated = store.updateThread(fork.id, patch);
  store.save();
  return updated ? { ...updated } : { ...fork, ...patch };
}

/**
 * Set thread provider and/or model. Does not bump updatedAt.
 *
 * Rejects unknown provider ids. Changing provider on a thread with a session
 * clears the session id (CLI sessions are not portable across harnesses), so
 * the next send starts a fresh session with the new CLI; the thread and its
 * transcript stay.
 * Model validation: every provider accepts a custom id. The published `models`
 * list is a picker snapshot, not an allowlist (`CUSTOM_MODEL_ID` / "accepts a
 * custom model for every provider"). Guards are trim, non-empty, and at most
 * 100 characters; a bad id fails at the CLI.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, provider?: string, model?: string | null }} input
 */
function setProvider(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }

  const providerProvided = Object.prototype.hasOwnProperty.call(
    input,
    "provider",
  );
  const modelProvided = Object.prototype.hasOwnProperty.call(input, "model");

  if (!providerProvided && !modelProvided) {
    return decorateThread(store, thread);
  }

  const nextProvider = providerProvided ? input.provider : thread.provider;
  if (providerProvided) {
    const id = String(input.provider || "");
    if (!isKnownProviderId(id)) {
      throw new Error(`Unknown provider: ${input.provider}`);
    }
  }

  const providerChanging =
    providerProvided && String(input.provider) !== String(thread.provider);

  /** @type {{ provider?: string, model?: string | null, sessionId?: null, reasoningEffort?: null, webSearch?: boolean }} */
  const patch = {};

  if (providerChanging && thread.status === "working") {
    // The runner writes sessionId back when the turn ends, which would
    // resurrect the old CLI's session onto the new provider. Same rule as
    // deleteThread: wait the run out.
    throw new Error("Cannot switch provider while a run is active");
  }

  if (providerChanging && thread.sessionId) {
    // The old CLI's session cannot be resumed by the new one, so drop it and
    // let the next send start fresh. The thread and its transcript stay.
    patch.sessionId = null;
  }
  if (providerProvided) patch.provider = String(input.provider);

  const nextEntry = getProvider(nextProvider);

  if (providerChanging) {
    // Do not carry the old provider's model into the new provider's argv.
    // Keep a model only when this call supplies one that is valid for the NEW provider.
    if (modelProvided) {
      patch.model = normalizeModelForProvider(nextEntry, input.model);
    } else {
      patch.model = null;
    }
    // Effort is a preference, not a model detail, so it survives the switch
    // when the new provider/model lists that level. It cannot survive onto a
    // model that does not list it: that level would never reach the CLI
    // while the picker kept displaying it (same rule as setReasoningEffort).
    const nextModel = Object.prototype.hasOwnProperty.call(patch, "model")
      ? patch.model
      : thread.model;
    const nextEfforts = honouredEfforts(nextEntry, nextModel);
    patch.reasoningEffort = nextEfforts.includes(thread.reasoningEffort)
      ? thread.reasoningEffort
      : null;
    // Same rule as effort: a search toggle that the new provider cannot
    // honour must not survive the switch (issue #174).
    patch.webSearch =
      nextEntry && nextEntry.supportsSearch === true
        ? thread.webSearch === true
        : false;
    // Same rule as effort: a permission mode the new provider cannot honour
    // must not survive the switch (issue #177). Teach-mode caps still win.
    patch.permissionMode = snapPermissionModeForThread(
      nextEntry,
      thread.permissionMode,
      thread.teach,
    );
  } else if (modelProvided) {
    patch.model = normalizeModelForProvider(nextEntry, input.model);
    // Providers with sessionPinsModel (exec --json ignores -m) drop the
    // session so the next send is a fresh run with the chosen model
    // (#1020). Interactive Codex app-server does not: turn/start.model
    // overrides subsequent turns (live-verified 2026-09-10).
    if (
      thread.sessionId &&
      patch.model !== thread.model &&
      nextEntry &&
      nextEntry.sessionPinsModel === true
    ) {
      patch.sessionId = null;
    }
    const nextEfforts = honouredEfforts(nextEntry, patch.model);
    if (
      thread.reasoningEffort != null &&
      !nextEfforts.includes(thread.reasoningEffort)
    ) {
      patch.reasoningEffort = null;
    }
  }

  const updated = store.updateThread(threadId, patch);
  store.save();
  const row = updated || { ...thread, ...patch };
  return decorateThread(store, row);
}

/**
 * @param {import('./store').Store} [_store]
 * @param {object} [opts] - forwarded to listProviders (which, env, …)
 * @returns {Promise<import('../src/shared/ipc').ProviderInfo[]>}
 */
async function listProvidersForApi(_store, opts) {
  const already = catalogCliProbeStarted();
  // First callers (boot) must stay cheap: file caches only, kick CLI probes
  // in the background. A later list (model picker open) awaits the inflight
  // probe so OpenCode/Cursor notes can appear without a boot stall.
  const probing = probeCatalogCli(opts);
  if (already) {
    try {
      await probing;
    } catch {
      // Missing cache / failed local command = no warning.
    }
  }
  return listProviders(opts);
}

/**
 * Rename a thread. Metadata only: never bumps updatedAt (issue #139), so
 * the sidebar sort is unchanged.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, title: string }} input
 */
function renameThread(store, input) {
  const { threadId, title: raw } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error("Thread title cannot be empty");
  }
  const title = truncateThreadTitle(trimmed);
  const updated = store.updateThread(threadId, { title });
  store.save();
  return updated ? { ...updated } : { ...thread, title };
}

/**
 * Edit-and-resubmit (issue #254): truncate the thread to just before a past
 * USER message so the renderer can re-send an edited prompt via runs.start.
 * Starts no run. Usage / spend is never rewritten.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, messageId: string, prompt: string, restoreFiles?: boolean }} input
 * @param {{ isRunning?: (threadId: string) => boolean, cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ thread: object, droppedMessages: number, restoredSha: string | null }>}
 */
function cloneRewindValue(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function clearRewindRestore(store, threadId) {
  if (!store || typeof store.clearRewindRestore !== "function") return;
  store.clearRewindRestore(threadId);
}

/**
 * Roll a committed rewind back from its restore handle (#1202).
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {{ isRunning?: (threadId: string) => boolean, cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void }} [opts]
 */
async function undoRewindThread(store, threadId, opts) {
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (
    (opts && typeof opts.isRunning === "function" && opts.isRunning(threadId)) ||
    thread.status === "working"
  ) {
    throw new Error("Cannot rewind while a run is active");
  }
  const snap = store.getRewindRestore(threadId);
  if (!snap) {
    return { thread: { ...thread }, droppedMessages: 0, restoredSha: null };
  }
  store.applyRewindRestore(threadId, snap);
  store.clearRewindRestore(threadId);

  let restoredSha = null;
  const live = store.getThread(threadId) || thread;
  if (snap.headSha && live.worktreePath) {
    // Original HEAD is no longer first-parent reachable after restoreFiles
    // reset, so listCheckpoints / restoreCheckpoint would reject it.
    const { gitTryAsync } = require("./worktrees.js");
    const reset = await gitTryAsync(live.worktreePath, [
      "reset",
      "--hard",
      snap.headSha,
    ]);
    if (reset && reset.ok) restoredSha = snap.headSha;
  }

  store.saveNow();
  scheduleArtifactCleanup(opts);
  const next = store.getThread(threadId) || live;
  return { thread: { ...next }, droppedMessages: 0, restoredSha };
}

async function rewindThread(store, input, opts) {
  const threadId = input && input.threadId;
  if (input && input.undo === true) {
    return undoRewindThread(store, threadId, opts);
  }
  const messageId = input && input.messageId;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (
    (opts && typeof opts.isRunning === "function" && opts.isRunning(threadId)) ||
    thread.status === "working"
  ) {
    throw new Error("Cannot rewind while a run is active");
  }
  if (!String((input && input.prompt) ?? "").trim()) {
    throw new Error("Prompt cannot be empty");
  }

  const msgs = store.getMessages(threadId);
  const at = msgs.findIndex((m) => m && m.id === messageId);
  if (at < 0) {
    throw new Error(`Unknown message: ${messageId}`);
  }
  if (msgs[at].role !== "user") {
    throw new Error(`Not a user message: ${messageId}`);
  }

  // Capture before truncate: restoreFiles picks the newest checkpoint at or
  // before this message, not "turn N" (clean turns skip a number).
  const targetAt = Number(msgs[at].createdAt);
  let headSha = null;
  if (input.restoreFiles && thread.worktreePath) {
    const { gitTryAsync } = require("./worktrees.js");
    const head = await gitTryAsync(thread.worktreePath, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    if (head && head.ok) {
      const sha = String(head.stdout || "").trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) headSha = sha;
    }
  }

  store.setRewindRestore(threadId, {
    messages: cloneRewindValue(msgs),
    workLog: cloneRewindValue(store.getWorkLog(threadId)),
    artifacts: cloneRewindValue(store.getRunArtifacts(threadId)),
    sessionId: thread.sessionId != null ? thread.sessionId : null,
    replayContext: thread.replayContext === true,
    status: thread.status,
    lastError: thread.lastError != null ? thread.lastError : null,
    lastErrorKind: thread.lastErrorKind != null ? thread.lastErrorKind : null,
    runStartedAt: thread.runStartedAt != null ? thread.runStartedAt : null,
    headSha,
    retainedCount: at,
  });

  const droppedMessages = store.truncateFromMessage(threadId, messageId);
  const updated = store.updateThread(threadId, {
    sessionId: null,
    replayContext: true,
  });

  let restoredSha = null;
  if (input.restoreFiles && thread.worktreePath) {
    const { listCheckpoints, restoreCheckpoint } = require("./worktrees.js");
    const list = await listCheckpoints({ store, threadId });
    // Newest-first. Newest checkpoint whose commit time is at or before the
    // edited message is the files just before the user sent it.
    // ponytail: git %ct is 1s granularity, so a checkpoint written in the
    // same second the message was sent could sort on the wrong side of the
    // boundary. A real turn takes seconds; worst case is restoring one turn
    // later than intended.
    const match = Number.isFinite(targetAt)
      ? list.find((c) => c.at <= targetAt)
      : null;
    if (match) {
      await restoreCheckpoint({
        store,
        threadId,
        sha: match.sha,
        isRunning: opts && opts.isRunning,
        rewindConversation: false,
      });
      restoredSha = match.sha;
    }
  }

  // Worktree reset is already on disk. Debounced save() would leave a crash
  // in the 250ms window with files rewound and the old transcript resurrected.
  store.saveNow();
  scheduleArtifactCleanup(opts);
  const next = updated || store.getThread(threadId) || thread;
  return { thread: { ...next }, droppedMessages, restoredSha };
}

/**
 * deleteThread's worktree guard. Renderer and Git tab copy depend on this
 * exact wording. removeProject no longer shares it — it reclaims worktrees
 * instead of refusing.
 */
const THREAD_STILL_HAS_WORKTREE =
  "Thread still has a worktree. Merge or delete it in the Git tab first.";

/** Bounded restore window for manual deletion (#940). */
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {object | null | undefined} thread
 * @returns {boolean}
 */
function isTrashed(thread) {
  return Boolean(thread && Number.isFinite(thread.trashedAt));
}

/**
 * @param {object | null | undefined} thread
 * @param {number} now
 * @returns {boolean}
 */
function isTrashExpired(thread, now) {
  return isTrashed(thread) && thread.trashedAt + TRASH_TTL_MS <= now;
}

/**
 * @param {{ now?: number } | null | undefined} opts
 * @returns {number}
 */
function trashNow(opts) {
  return opts && Number.isFinite(opts.now) ? opts.now : Date.now();
}

/**
 * Manual deletion: hide the thread in Recently deleted for TRASH_TTL_MS.
 * Same active-run / worktree guards as deleteThread. Does not prune images
 * or run artifacts — restore still needs them. Programmatic callers that
 * must drop a thread immediately (create rollback, worker orphans, project
 * removal) keep using deleteThread / purgeThread.
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @param {{ isRunning?: (threadId: string) => boolean, getIosSimulator?: () => object | null, now?: number, log?: (msg: string) => void }} [opts]
 */
function trashThread(store, input, opts) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (opts && typeof opts.isRunning === "function" && opts.isRunning(threadId)) {
    throw new Error("Cannot delete thread while a run is active");
  }
  if (thread.worktreePath) {
    throw new Error(THREAD_STILL_HAS_WORKTREE);
  }
  if (isTrashed(thread)) {
    return {
      thread: { ...thread },
      expiresAt: thread.trashedAt + TRASH_TTL_MS,
    };
  }
  const now = trashNow(opts);
  const updated = store.updateThread(threadId, { trashedAt: now });
  store.saveNow();
  void scheduleSimulatorRelease(opts, "releaseThread", { threadId });
  const row = updated || { ...thread, trashedAt: now };
  return { thread: { ...row }, expiresAt: now + TRASH_TTL_MS };
}

/**
 * Restore a trashed thread to the same id and history. Does not start a
 * run, drain the queue, or fire an expired quota timer.
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @param {{ now?: number, cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void }} [opts]
 */
function restoreThread(store, input, opts) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const now = trashNow(opts);
  if (!isTrashed(thread)) {
    throw new Error("Thread is not in Recently deleted");
  }
  if (isTrashExpired(thread, now)) {
    purgeThread(store, threadId);
    store.saveNow();
    void scheduleImagePruneFromStore(store);
    scheduleArtifactCleanup(opts);
    throw new Error("Recently deleted window expired");
  }
  if (!store.getProject(thread.projectId)) {
    throw new Error("Cannot restore: project is no longer available");
  }
  const patch = { trashedAt: null };
  if (thread.status === "quota-wait") {
    patch.status = "idle";
    patch.quotaWaitUntil = null;
  }
  const updated = store.updateThread(threadId, patch);
  store.saveNow();
  const row = updated || { ...thread, ...patch };
  return decorateThread(store, row);
}

/**
 * Permanently delete a thread with its messages and work log.
 * Rejects while a run is active (when isRunning is provided) and when a
 * worktree is still attached.
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @param {{ isRunning?: (threadId: string) => boolean, getIosSimulator?: () => object | null, cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void }} [opts]
 */
function deleteThread(store, input, opts) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (opts && typeof opts.isRunning === "function" && opts.isRunning(threadId)) {
    throw new Error("Cannot delete thread while a run is active");
  }
  if (thread.worktreePath) {
    throw new Error(THREAD_STILL_HAS_WORKTREE);
  }
  purgeThread(store, threadId);
  store.saveNow();
  void scheduleImagePruneFromStore(store);
  scheduleArtifactCleanup(opts);
  void scheduleSimulatorRelease(opts, "releaseThread", { threadId });
}

/**
 * Reclaim expired Recently deleted rows. Safe to call on boot and list.
 * @param {import('./store').Store} store
 * @param {{ now?: number, cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void }} [opts]
 * @returns {number} number of threads purged
 */
function expireTrashedThreads(store, opts) {
  const now = trashNow(opts);
  const ids = store
    .getThreads()
    .filter((t) => isTrashExpired(t, now))
    .map((t) => t.id);
  if (ids.length === 0) return 0;
  for (const id of ids) purgeThread(store, id);
  store.saveNow();
  void scheduleImagePruneFromStore(store);
  scheduleArtifactCleanup(opts);
  return ids.length;
}

/**
 * Unexpired Recently deleted rows, newest first.
 * @param {import('./store').Store} store
 * @param {{ now?: number }} [opts]
 */
function listTrashed(store, opts) {
  const now = trashNow(opts);
  /** @type {object[]} */
  const out = [];
  for (const t of store.getThreads()) {
    if (!isTrashed(t) || isTrashExpired(t, now)) continue;
    const project = store.getProject(t.projectId);
    out.push({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectSlug: project ? project.slug : null,
      projectMissing: !project,
      trashedAt: t.trashedAt,
      expiresAt: t.trashedAt + TRASH_TTL_MS,
    });
  }
  out.sort(
    (a, b) => b.trashedAt - a.trashedAt || String(a.id).localeCompare(String(b.id)),
  );
  return out;
}

/**
 * @param {import('./store').Store} store
 */
/**
 * Attach the computed sandbox badge. Always a new object so a store row
 * never grows a persisted `sandbox` field.
 * @param {import('./store').Store} store
 * @param {object} thread
 */
function decorateThread(store, thread) {
  if (!thread) return thread;
  const project = store.getProject(thread.projectId);
  return {
    ...thread,
    sandbox: resolveSandbox({
      provider: thread.provider,
      permissionMode: thread.permissionMode,
      project,
    }),
  };
}

/**
 * listThreads cache, keyed per store (WeakMap so a discarded store — tests
 * create plenty — never leaks). See listThreads for the invariants.
 * @type {WeakMap<import('./store').Store, { threads: object[], projects: object[], value: object[], rows: Map<object, object> }>}
 */
const listThreadsCache = new WeakMap();

/**
 * Sidebar row: drop detail-only fields (#1385). The renderer reads
 * hypotheses and suggestions from detail.thread only, and across every row
 * they were ~46% of each threads:changed push.
 * @param {object} row
 */
function listRow(row) {
  const { hypotheses, suggestions, ...rest } = row;
  return rest;
}

function listThreads(store) {
  const threads = store.getThreads();
  const projects = store.getProjects();
  // pushThreadsChanged fires on every work-log step during a run, but
  // work-log appends never touch the threads/projects arrays — both are
  // replaced (never mutated in place) on any real change. Key the cache on
  // those identities so no-op ticks skip the whole decorate+serialize, and
  // reuse decorated rows keyed on the thread object so an updateThread that
  // only patched one row skips re-decorating the rest. Row identity does
  // not survive IPC; the renderer restores it in reconcileThreadList.
  const cache = listThreadsCache.get(store);
  if (cache && cache.threads === threads && cache.projects === projects) {
    return cache.value;
  }
  const prevRows = cache ? cache.rows : null;
  /** @type {Map<object, object>} */
  const rows = new Map();
  /** @type {object[]} */
  const value = [];
  for (const t of threads) {
    // Sleep-time consolidation is a system job (issue #722): keep the
    // runner thread, but never show it in the sidebar.
    if (t && t.memoryConsolidate === true) continue;
    if (isTrashed(t)) continue;
    const prev = prevRows && prevRows.get(t);
    if (prev) {
      rows.set(t, prev);
      value.push(prev);
      continue;
    }
    const decorated = listRow(decorateThread(store, t));
    rows.set(t, decorated);
    value.push(decorated);
  }
  listThreadsCache.set(store, { threads, projects, value, rows });
  return value;
}

/**
 * Per-thread summaries for the Agents tab team view (threads:summaries).
 * lastActivity is the first line of the thread's last assistant message,
 * capped at 200 characters (null when the thread has none). orchWorker and
 * projectId ride along so AgentsPanel can tell a true worker from an
 * ordinary fork. Cheap: store only.
 *
 * Optional input scopes the walk BEFORE any message read (#1398): projectId
 * keeps one project's rows, threadIds keeps exact ids. Omitted = all rows.
 * @param {import('./store').Store} store
 * @param {{ projectId?: string, threadIds?: string[] }} [input]
 */
function threadSummaries(store, input) {
  const projectId = input && typeof input.projectId === "string" ? input.projectId : null;
  const ids = input && Array.isArray(input.threadIds) ? new Set(input.threadIds) : null;
  return store
    .getThreads()
    .filter(
      (t) =>
        !(t && t.memoryConsolidate === true) &&
        !isTrashed(t) &&
        (!projectId || t.projectId === projectId) &&
        (!ids || ids.has(t.id)),
    )
    .map((t) => {
      const last = store.getLastAssistantMessage(t.id);
      return {
        id: t.id,
        title: t.title,
        provider: t.provider,
        status: t.status,
        handoffFrom: t.handoffFrom ?? null,
        orchWorker: t.orchWorker === true,
        projectId: t.projectId,
        runStartedAt: t.runStartedAt ?? null,
        stoppedAt: t.stoppedAt ?? null,
        awaitingInput: t.awaitingInput === true,
        stalledAt: t.stalledAt ?? null,
        lastActivity: last
          ? {
              text: String(last.text).split(/\r?\n/, 1)[0].trim().slice(0, 200),
              at: Number(last.createdAt) || t.updatedAt,
            }
          : null,
      };
    });
}

/**
 * Full-content search across titles and message text.
 * @param {import('./store').Store} store
 * @param {{ query?: string }} [input]
 */
async function searchThreads(store, input) {
  const query =
    input && input.query != null ? String(input.query) : "";
  const hits = await store.searchThreads(query);
  return hits.filter(
    (t) => !(t && t.memoryConsolidate === true) && !isTrashed(t),
  );
}

/**
 * Full thread detail for the renderer.
 *
 * Selecting a thread is visiting it: when markVisited is true (default), stamp
 * lastVisitedAt = Date.now() WITHOUT bumping updatedAt (visiting is not
 * activity; bumping would re-unread the thread and re-sort the sidebar).
 * Do not store.save() here: a visit stamp must not schedule a whole-store
 * rewrite (#636). markDirty lets the field ride the next real flush; the
 * exit hook covers quit. Hard crash: unread-dot is a click stale.
 *
 * Callers (audit before changing stamp rules):
 * - electron/ipc.js threads:get — user selection; markVisited true (default)
 * - electron/runner.js pushDetail — background stream refresh; MUST pass
 *   { markVisited: false } so a non-selected thread is never marked read
 * - electron tests — default or explicit depending on the case under test
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {object | null} [workflow]
 * @param {{ markVisited?: boolean }} [opts]
 */
function getThreadDetail(store, threadId, workflow = null, opts) {
  const markVisited = !opts || opts.markVisited !== false;
  const thread = store.getThread(threadId);
  if (!thread || isTrashed(thread)) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (markVisited) {
    // No updatedAt bump: visiting must not re-unread or re-sort the thread.
    store.updateThread(threadId, { lastVisitedAt: Date.now() });
    store.markDirty();
  }
  const current = store.getThread(threadId) || thread;
  return {
    thread: decorateThread(store, current),
    messages: store.getMessages(threadId).slice(),
    workLog: store.getWorkLog(threadId).slice(),
    workflow: workflow ?? null,
    usage: store.getUsage(threadId) ?? null,
    artifacts: store.getRunArtifacts(threadId).slice(),
    // Live permission prompt (runner-ephemeral, never persisted).
    pendingPermission: (opts && opts.pendingPermission) || null,
  };
}

module.exports = {
  normalizeBaseBranch,
  createThread,
  setPermissionMode,
  setReasoningEffort,
  setWebSearch,
  forkThread,
  forkWorkerThread,
  setProvider,
  listProvidersForApi,
  renameThread,
  clearRewindRestore,
  rewindThread,
  THREAD_STILL_HAS_WORKTREE,
  TRASH_TTL_MS,
  isTrashed,
  trashThread,
  restoreThread,
  deleteThread,
  expireTrashedThreads,
  listTrashed,
  decorateThread,
  listThreads,
  threadSummaries,
  searchThreads,
  getThreadDetail,
};
