"use strict";

// Public entry point: re-exports the services-*.js domain modules.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { expandUserPath } = require("./fsBrowse.js");
const { getProvider } = require("./providers.js");
const { getMemoryStatus } = require("./memory-sup.js");
const { runWindowsDoctor } = require("./doctor.js");
const configDoctor = require("./configDoctor.js");
const {
  normalizeSetupCommand,
  normalizeQuickActions,
  runCommand,
} = require("./projectCommands.js");
const { DEFAULT_WORKTREE_RETENTION } = require("./store.js");
const { scheduleImagePruneFromStore } = require("./image-store.js");
const { detectScm, JJ_NON_COLOCATED_ADD_ERROR } = require("./scm.js");
const {
  presentProject,
  normalizeIconPath,
  relativeIconPath,
  iconDataUrlFor,
  ICON_FILTERS,
  mainWorkTree,
} = require("./projectIcon.js");
const {
  PERMISSION_MODES,
  scheduleArtifactCleanup,
  scheduleSimulatorRelease,
  canHostWorktree,
  purgeThread,
} = require("./services-shared.js");
const {
  gitOutAsync,
  gitStatus,
  parseRevListCount,
  gitSyncInfo,
  gitFetch,
  repoInfoFromRemote,
  gitRepoInfo,
  summarizePullOutput,
  pullFailureReason,
  gitPull,
} = require("./services-git.js");
const {
  THREAD_TITLE_MAX,
  THREAD_NOTES_MAX,
  HYPOTHESES_MAX,
  HYPOTHESIS_CLAIM_MAX,
  HYPOTHESIS_REASON_MAX,
  SUGGESTIONS_MAX,
  SUGGESTION_TITLE_MAX,
  SUGGESTION_PROMPT_MAX,
  normalizeModelForProvider,
  isKnownProviderId,
  HANDOFF_MESSAGE_MAX,
  HANDOFF_MESSAGE_COUNT,
  PLANBOARD_NOTE,
  CODEX_COMPUTER_USE_NOTE,
  planboardNoteFor,
  selfIdNoteFor,
  suggestedWorkNoteFor,
  codexComputerUseNoteFor,
  hypothesisNoteFor,
  planStepsFrom,
  buildHandoffPrefix,
  codeIndexNoteFor,
} = require("./services-notes.js");
const {
  TEACH_REVIEW_THRESHOLDS,
  TEACH_REVIEW_PROMPT,
  teachAutonomyFor,
  teachAllowedModes,
  teachPermissionAllowed,
  teachNoteFor,
  startTeach,
  stopTeach,
  askNoteFor,
  startAsk,
  stopAsk,
  recordTeachReview,
  requestTeachReview,
} = require("./services-teach.js");
const {
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
  listThreads,
  threadSummaries,
  searchThreads,
  getThreadDetail,
} = require("./services-threads.js");
const {
  setArchived,
  clearSettledOnActivity,
  setSettled,
  setPinned,
  setQueued,
  takeQueued,
  addBtw,
  finishBtw,
  dismissBtw,
  promoteBtw,
  setSnoozed,
  setTags,
  setThreadProject,
  setMuted,
  setEjected,
  setCrossThreadInbound,
  setQuotaWaitAutoResume,
  setNotes,
  setMessagePins,
  setBaseBranch,
  setPendingWorktree,
  refreshWorkerSnapshot,
  setFeltEstimate,
  recordHypothesis,
  recordSuggestion,
  resolveSuggestion,
  setVerifyCommand,
  runVerifyNow,
} = require("./services-thread-state.js");
const {
  CREW_TASK_TITLE_MAX,
  CREW_TASK_NOTE_MAX,
  CREW_TASKS_MAX,
  CREW_TASK_ATTEMPT_CAP,
  CREW_AUTO_TURN_CAP,
  crewRootOf,
  listCrewTasks,
  addCrewTasks,
  claimCrewTask,
  completeCrewTask,
  releaseCrewTasks,
  crewTaskNoteFor,
  assertUnderDailyBudget,
  orchestrationSpend,
  assertUnderOrchestrationBudget,
} = require("./services-crew.js");
const {
  SPEC_ARTIFACTS,
  SPEC_DIR,
  nextSpecStage,
  specArtifactPath,
  startSpec,
  stopSpec,
  submitSpec,
  specStagePrompt,
  reviewSpec,
  specDispatchPrompt,
  specConvergePrompt,
  dispatchSpec,
  forkSpecWave,
  convergeSpec,
  specNoteFor,
  readSpecArtifact,
} = require("./services-spec.js");

/**
 * Derive owner/repo from a git remote URL, or null if unparseable.
 * @param {string} url
 * @returns {string | null}
 */
function slugFromRemoteUrl(url) {
  if (!url) return null;
  const cleaned = url.trim().replace(/\.git$/i, "");

  // git@host:owner/repo
  const ssh = cleaned.match(/^git@[^:]+:(.+)$/);
  if (ssh) {
    const parts = ssh[1].replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  }

  // https://host/owner/repo or ssh://git@host/owner/repo
  try {
    const withProto = /^[a-z]+:\/\//i.test(cleaned)
      ? cleaned
      : `https://${cleaned}`;
    const u = new URL(withProto);
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  } catch {
    // fall through
  }

  return null;
}

function normalizePathKey(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWindowsAbsolutePath(value) {
  return (
    value.startsWith("\\\\") || /^[a-zA-Z]:([/\\]|$)/.test(String(value || ""))
  );
}

/**
 * Already-added project for this environment: same remote host+path, or the
 * same local path. Trailing slashes and `~` do not create a second entry.
 * @param {import('./store').Store} store
 * @param {{ path?: string, remoteHost?: string, remotePath?: string }} input
 */
function findExistingProject(store, input) {
  const host = input && input.remoteHost ? String(input.remoteHost).trim() : "";
  const projects = store.getProjects();
  if (host) {
    const rpath = normalizePathKey(input && input.remotePath);
    if (!rpath) return null;
    return (
      projects.find(
        (p) =>
          String(p.remoteHost || "").trim() === host &&
          normalizePathKey(p.remotePath || p.path) === rpath,
      ) || null
    );
  }
  const raw = input && input.path ? String(input.path).trim() : "";
  if (!raw) return null;
  const resolved = path.resolve(expandUserPath(raw));
  const key = normalizePathKey(resolved);
  return (
    projects.find(
      (p) => !p.remoteHost && normalizePathKey(p.path) === key,
    ) || null
  );
}

/**
 * True when cwd is a git work tree. A missing git binary, a non-repo, or a
 * bare repo all return false — callers then decide whether to init.
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function isInsideWorkTree(cwd) {
  try {
    const inside = await gitOutAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return inside === "true";
  } catch {
    return false;
  }
}

/**
 * `git init -q` a local directory that is not already a work tree. Existing
 * repos are left untouched. Init failure is a real error, not "not a repo".
 * @param {string} resolved
 */
async function ensureGitWorkTree(resolved) {
  if (await isInsideWorkTree(resolved)) return;
  // Non-colocated jj has no Git work tree. `git init` next to `.jj` would
  // create a second, empty git repo and look colocated (#521).
  const scm = detectScm(resolved);
  if (scm && scm.kind === "jj" && scm.colocated === false) {
    throw new Error(JJ_NON_COLOCATED_ADD_ERROR);
  }
  try {
    await gitOutAsync(resolved, ["init", "-q"]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(`Could not initialize a git repository: ${msg}`);
  }
  if (!(await isInsideWorkTree(resolved))) {
    throw new Error(
      `Not a git repository: ${resolved}. Choose a directory inside a git work tree.`,
    );
  }
}

/**
 * Validate remotes (when set) or a local directory; add ProjectInfo.
 * A local folder that is not yet a git work tree is initialized with
 * `git init -q` (same as createProject). SSH remotes skip the local check.
 * Local paths also get `~` expansion, create-if-missing, and return the
 * existing project instead of duplicating it (#609).
 * @param {import('./store').Store} store
 * @param {string} projectPath
 * @param {{ remoteHost?: string, remotePath?: string } | null} [opts]
 */
async function addProject(store, projectPath, opts) {
  const remoteHost =
    opts && typeof opts.remoteHost === "string" ? opts.remoteHost.trim() : "";
  const remotePath =
    opts && typeof opts.remotePath === "string" ? opts.remotePath.trim() : "";

  if (remoteHost) {
    if (!remotePath) {
      throw new Error("Remote path is required when remote host is set");
    }
    if (!remotePath.startsWith("/") && !remotePath.startsWith("~")) {
      throw new Error("Remote path must be an absolute path (start with / or ~)");
    }
    const existingRemote = findExistingProject(store, {
      remoteHost,
      remotePath,
    });
    if (existingRemote) return presentAdded(existingRemote);
    const folderName = path.posix.basename(remotePath) || "remote";
    const localPath =
      typeof projectPath === "string" && projectPath.trim()
        ? path.resolve(expandUserPath(projectPath.trim()))
        : remotePath;
    const project = {
      id: randomUUID(),
      slug: folderName,
      name: folderName,
      path: localPath,
      remoteHost,
      remotePath,
      worktreeRetention: DEFAULT_WORKTREE_RETENTION,
    };
    const projects = store.getProjects().slice();
    projects.push(project);
    store.setProjects(projects);
    store.save();
    return presentAdded(project);
  }

  const raw = typeof projectPath === "string" ? projectPath.trim() : "";
  if (!raw) {
    throw new Error("Path is required");
  }
  if (isWindowsAbsolutePath(raw) && process.platform !== "win32") {
    throw new Error(
      "Windows-style paths are only supported on Windows environments.",
    );
  }
  const resolved = path.resolve(expandUserPath(raw));
  const existing = findExistingProject(store, { path: resolved });
  if (existing) return presentAdded(existing);

  let stat;
  let created = false;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fs.mkdirSync(resolved, { recursive: true });
    created = true;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Could not create directory: ${resolved}`);
    }
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  try {
    await ensureGitWorkTree(resolved);
  } catch (err) {
    // Roll back only a directory this call created; never an existing one.
    if (created) fs.rmSync(resolved, { recursive: true, force: true });
    throw err;
  }

  const folderName = path.basename(resolved);
  let slug = folderName;
  let name = folderName;

  try {
    const remote = await gitOutAsync(resolved, ["remote", "get-url", "origin"]);
    const derived = slugFromRemoteUrl(remote);
    if (derived) {
      slug = derived;
      name = derived.split("/").pop() || folderName;
    }
  } catch {
    // no origin remote
  }

  const project = {
    id: randomUUID(),
    slug,
    name,
    path: resolved,
    worktreeRetention: DEFAULT_WORKTREE_RETENTION,
  };

  const projects = store.getProjects().slice();
  projects.push(project);
  store.setProjects(projects);
  store.save();
  return presentAdded(project);
}

/**
 * Attach the win32 doctor to the add return value only. The stored
 * object is left untouched so a later save cannot persist the report.
 * Off win32 this is a no-op (same object, no extra field).
 * @param {object} project
 */
async function attachWindowsDoctor(project) {
  const report = await runWindowsDoctor(project);
  return report ? { ...project, windowsDoctor: report } : project;
}

/**
 * The Scratch workspace (#1411, "start without a project"): one built-in
 * project whose folder lives under Solenta's data dir. Deliberately not a
 * git repo, so no worktree, diff or PR flow applies; threads just run in
 * that folder. Idempotent: returns the existing row when there is one and
 * recreates the folder if it went missing.
 *
 * @param {import('./store').Store} store
 * @param {string} userDataPath
 */
function ensureScratchProject(store, userDataPath) {
  if (!userDataPath) {
    throw new Error("Scratch workspace is not available in this mode");
  }
  const dir = path.join(userDataPath, "scratch");
  fs.mkdirSync(dir, { recursive: true });
  const existing = store.getProjects().find((p) => p && p.scratch === true);
  if (existing) return presentProject(existing);
  const project = {
    id: randomUUID(),
    slug: "Scratch",
    name: "Scratch",
    path: dir,
    scratch: true,
    worktreeRetention: DEFAULT_WORKTREE_RETENTION,
  };
  store.setProjects([...store.getProjects(), project]);
  store.save();
  return presentProject(project);
}

async function presentAdded(project) {
  return presentProject(await attachWindowsDoctor(project));
}

/**
 * Create a brand-new project folder: mkdir, then addProject (which git-inits).
 * The name must be a plain folder name (no separators) and the parent
 * directory must already exist. A failed add rolls the new folder back.
 * @param {import('./store').Store} store
 * @param {{ name?: string, parentDir?: string }} input
 */
async function createProject(store, input) {
  const name =
    input && typeof input.name === "string" ? input.name.trim() : "";
  const parentDir =
    input && typeof input.parentDir === "string" ? input.parentDir.trim() : "";

  if (!name) {
    throw new Error("Project name is required");
  }
  if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new Error("Project name must be a plain folder name (no slashes)");
  }
  if (!parentDir) {
    throw new Error("Location is required");
  }

  const parent = path.resolve(expandUserPath(parentDir));
  let stat;
  try {
    stat = fs.statSync(parent);
  } catch {
    throw new Error(`Path does not exist: ${parent}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${parent}`);
  }

  const target = path.join(parent, name);
  if (fs.existsSync(target)) {
    throw new Error(`Already exists: ${target}`);
  }

  fs.mkdirSync(target);
  try {
    return await addProject(store, target);
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Patch an existing project. Today: display name, SSH remote fields,
 * space membership (issue #159), the autoDispatch opt-in (issue #165),
 * worktree retention (#316), a per-project iconPath override (#610), and
 * setupCommand / quickActions (issue #153).
 * Remote validation mirrors addProject: a non-empty host requires an
 * absolute remotePath; an empty host clears both keys, turning the
 * project local again. The local checkout path is never edited here.
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {{ name?: string, remoteHost?: string, remotePath?: string, spaceId?: string, autoDispatch?: boolean, worktreeRetention?: number, iconPath?: string | null, setupCommand?: string | null, quickActions?: Array<{ id?: string, name?: string, command?: string }> }} patch
 */
function updateProject(store, projectId, patch) {
  const projects = store.getProjects().slice();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  const next = { ...projects[idx] };
  const input = patch && typeof patch === "object" ? patch : {};

  if (typeof input.name === "string") {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Name cannot be empty");
    }
    next.name = name;
  }

  if (
    typeof input.remoteHost === "string" ||
    typeof input.remotePath === "string"
  ) {
    const host =
      typeof input.remoteHost === "string" ? input.remoteHost.trim() : "";
    const rpath =
      typeof input.remotePath === "string" ? input.remotePath.trim() : "";
    if (host) {
      if (!rpath) {
        throw new Error("Remote path is required when remote host is set");
      }
      if (!rpath.startsWith("/")) {
        throw new Error("Remote path must be an absolute path (start with /)");
      }
      next.remoteHost = host;
      next.remotePath = rpath;
    } else {
      delete next.remoteHost;
      delete next.remotePath;
    }
  }

  // #568: Spaces retired. Ignore leftover spaceId patches; never persist the key.
  if (typeof input.spaceId === "string") {
    delete next.spaceId;
  }

  // true persists the key; false deletes it so old stores stay clean.
  // Non-boolean input is ignored, not an error.
  if (input.autoDispatch === true) {
    next.autoDispatch = true;
  } else if (input.autoDispatch === false) {
    delete next.autoDispatch;
  }

  if (Object.prototype.hasOwnProperty.call(input, "worktreeRetention")) {
    const v = input.worktreeRetention;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      next.worktreeRetention = Math.floor(v);
    } else {
      throw new Error(
        "worktreeRetention must be a number greater than 0, or 0 to keep everything",
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "iconPath")) {
    const normalized = normalizeIconPath(input.iconPath);
    if (normalized) next.iconPath = normalized;
    else delete next.iconPath;
  }

  if (Object.prototype.hasOwnProperty.call(input, "setupCommand")) {
    const setupCommand = normalizeSetupCommand(input.setupCommand);
    if (setupCommand) next.setupCommand = setupCommand;
    else delete next.setupCommand;
  }

  if (Object.prototype.hasOwnProperty.call(input, "quickActions")) {
    const quickActions = normalizeQuickActions(input.quickActions);
    if (quickActions) next.quickActions = quickActions;
    else delete next.quickActions;
  }

  projects[idx] = next;
  store.setProjects(projects);
  store.save();
  return presentProject(next);
}

/**
 * @param {import('./store').Store} store
 * @returns {{ id: string, name: string }[]}
 */
function listSpaces() {
  return [];
}

/**
 * @param {import('./store').Store} _store
 * @param {{ name?: string }} _input
 */
function addSpace(_store, _input) {
  throw new Error("Spaces have been removed");
}

/**
 * @param {import('./store').Store} _store
 * @param {{ id?: string, name?: string }} _input
 */
function updateSpace(_store, _input) {
  throw new Error("Spaces have been removed");
}

/**
 * Idempotent: Spaces are already gone after the #568 store migration.
 * @param {import('./store').Store} _store
 * @param {{ id?: string }} _input
 */
function removeSpace(_store, _input) {
}

/**
 * Remove the project ENTRY and delete its threads' conversation history
 * (t3-style). The repository on disk is never touched — no fs calls on the
 * project path. Active-run copy is project-scoped. The guard runs before any
 * deletion so a reject cannot leave a half-removed project.
 *
 * Worktrees are reclaimed here rather than blocking the removal: refusing on
 * any attached worktree made removal impossible in practice (every real
 * project accumulates archived threads that still carry a worktreePath, plus
 * stale paths whose directory is long gone). Reclaim uses the GC primitive,
 * so BRANCHES ARE NEVER DELETED and a tree with uncommitted work fails the
 * non-force `worktree remove` and is left on disk for the GC panel instead of
 * being force-deleted under the user.
 *
 * After metadata is durable on disk, schedules one best-effort
 * `opts.cleanupRunArtifacts()` pass (same contract as deleteThread). Cleanup
 * rejection is logged via `opts.log` and never fails project removal.
 * Session processes live in the runner Map, not the Store; the IPC
 * `projects:remove` handler retires each returned id after this succeeds
 * (issue #1227).
 * @param {import('./store').Store} store
 * @param {{ projectId: string }} input
 * @param {{ isRunning?: (threadId: string) => boolean, getIosSimulator?: () => object | null, cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ removedThreadIds: string[] }>}
 */
async function removeProject(store, input, opts) {
  const projectId =
    input && input.projectId != null ? String(input.projectId) : "";
  const project = store.getProject(projectId);
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const threads = store
    .getThreads()
    .filter((t) => t && t.projectId === projectId);

  // Guard first — every thread — before any purge.
  for (const thread of threads) {
    const activeRun =
      thread.status === "working" ||
      (opts &&
        typeof opts.isRunning === "function" &&
        opts.isRunning(thread.id));
    if (activeRun) {
      throw new Error("Cannot remove a project while a run is active");
    }
  }

  const { removeGcWorktree } = require("./worktrees.js");
  for (const thread of threads) {
    if (!thread.worktreePath) continue;
    const res = await removeGcWorktree(store, {
      path: thread.worktreePath,
      threadId: thread.id,
    });
    if (!res.ok) {
      // Dirty or wedged tree: keep it on disk (nothing is lost) and carry on
      // with the removal the user just confirmed.
      console.warn(
        `removeProject: left ${thread.worktreePath} in place: ${res.error}`,
      );
    }
  }

  const removedThreadIds = threads.map((thread) => thread.id);
  for (const thread of threads) {
    purgeThread(store, thread.id);
  }
  store.setProjects(store.getProjects().filter((p) => p.id !== projectId));
  store.saveNow();
  void scheduleImagePruneFromStore(store);
  scheduleArtifactCleanup(opts);
  void scheduleSimulatorRelease(opts, "releaseProject", { projectId });
  return { removedThreadIds };
}

/**
 * List all projects, attaching a derived iconUrl (#610). The store row
 * is never mutated — iconUrl is computed from iconPath / auto-detect.
 * @param {import('./store').Store} store
 */
function listProjects(store) {
  return store.getProjects().map(presentProject);
}

function requireProject(store, projectId) {
  const project = store.getProjects().find((p) => p.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}

/**
 * Native file picker for a project icon override. The chosen file must
 * sit inside the project's checkout (or the repo's main work tree).
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {{ showOpenDialog: (opts: object) => Promise<{ canceled: boolean, filePaths?: string[] }> }} dialog
 * @returns {Promise<{ iconPath: string, iconUrl: string | null } | null>}
 */
async function pickProjectIcon(store, projectId, dialog) {
  const project = requireProject(store, projectId);
  if (!dialog || typeof dialog.showOpenDialog !== "function") {
    throw new Error("File picker is not available in this mode");
  }
  const defaultPath =
    typeof project.path === "string" && project.path ? project.path : undefined;
  const result = await dialog.showOpenDialog({
    title: "Choose a project icon",
    defaultPath,
    properties: ["openFile"],
    filters: ICON_FILTERS,
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  const chosen = result.filePaths[0];
  const scanRoot = (() => {
    try {
      return mainWorkTree(project.path);
    } catch {
      return project.path;
    }
  })();
  const rel =
    relativeIconPath(scanRoot, chosen) ||
    relativeIconPath(project.path, chosen);
  if (!rel) {
    throw new Error("Choose a file inside the project folder.");
  }
  return { iconPath: rel, iconUrl: iconDataUrlFor(project.path, rel) };
}

/**
 * Preview an icon without saving. `iconPath: null` is Automatic (ignore
 * a stored override). Omit iconPath to use whatever is stored.
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {string | null} [iconPath]
 */
function resolveProjectIcon(store, projectId, iconPath) {
  const project = requireProject(store, projectId);
  const override =
    iconPath === undefined ? project.iconPath : iconPath;
  return { iconUrl: iconDataUrlFor(project.path, override) };
}

/**
 * Validate a workflow template before save.
 * Availability of the provider binary is NOT required to save.
 *
 * @param {{ name?: string, phases?: unknown }} template
 */
function validateWorkflowTemplate(template) {
  if (!template || typeof template !== "object") {
    throw new Error("Template is required");
  }
  const name = template.name != null ? String(template.name).trim() : "";
  if (!name) {
    throw new Error("Template name is required");
  }

  const phases = template.phases;
  if (!Array.isArray(phases)) {
    throw new Error("Template phases must be an array");
  }
  if (phases.length < 1 || phases.length > 6) {
    throw new Error("Template must have between 1 and 6 phases");
  }

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (!phase || typeof phase !== "object") {
      throw new Error(`Phase ${i + 1}: invalid phase object`);
    }
    const phaseName =
      phase.name != null ? String(phase.name).trim() : "";
    if (!phaseName) {
      throw new Error(`Phase ${i + 1}: name is required`);
    }
    if (phaseName.length > 24) {
      throw new Error(
        `Phase "${phaseName}": name must be at most 24 characters`,
      );
    }

    const agentCount = phase.agentCount;
    if (
      typeof agentCount !== "number" ||
      !Number.isInteger(agentCount) ||
      agentCount < 1 ||
      agentCount > 4
    ) {
      throw new Error(
        `Phase "${phaseName}": agentCount must be an integer from 1 to 4`,
      );
    }

    const instruction =
      phase.instruction != null ? String(phase.instruction).trim() : "";
    if (!instruction) {
      throw new Error(`Phase "${phaseName}": instruction is required`);
    }
    if (String(phase.instruction).length > 2000) {
      throw new Error(
        `Phase "${phaseName}": instruction must be at most 2000 characters`,
      );
    }

    const providerId =
      phase.provider != null ? String(phase.provider).trim() : "";
    if (!providerId) {
      throw new Error(`Phase "${phaseName}": provider is required`);
    }
    const entry = getProvider(providerId);
    if (!entry || entry.kind === "simulate") {
      throw new Error(
        `Phase "${phaseName}": unknown provider "${providerId}"`,
      );
    }

    // ONE rule for accepting a model, shared with setProvider. This used to be
    // an inline membership check, which meant filling the previously-empty
    // model lists made template phases STRICTER than before while setProvider
    // got looser: a template saved with a custom id then threw on a no-op
    // re-save. Routing through the helper also gives phases the trim, empty and
    // length guards the inline block never had.
    try {
      normalizeModelForProvider(entry, phase.model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Phase "${phaseName}": ${msg}`);
    }
  }
}

/**
 * @param {import('./store').Store} store
 */
function listTemplates(store) {
  return store.listTemplates();
}

/**
 * Validate and save a workflow template.
 * @param {import('./store').Store} store
 * @param {{ id?: string, name: string, phases: object[] }} template
 */
function saveTemplate(store, template) {
  validateWorkflowTemplate(template);
  const phases = (template.phases || []).map((p) => ({
    name: String(p.name).trim(),
    agentCount: p.agentCount,
    instruction: String(p.instruction),
    provider: String(p.provider).trim(),
    // Store the NORMALIZED value. Validating and then persisting the raw
    // string meant a padded id stored padded, and " " + 100 chars + " " passed
    // the length guard and then stored 102 characters.
    // The entry argument is unused by normalizeModelForProvider now that the
    // list is a suggestion; pass null rather than computing a lookup for show.
    model: normalizeModelForProvider(null, p.model),
  }));
  const saved = store.saveTemplate({
    id: template.id,
    name: String(template.name).trim(),
    phases,
  });
  store.save();
  return saved;
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string }} input
 */
function removeTemplate(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  if (!id) {
    throw new Error("Template id is required");
  }
  store.removeTemplate(id);
  store.save();
}

/**
 * @param {import('./store').Store} store
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function getSettings(store) {
  return store.getSettings();
}

/**
 * Validate and persist settings. Does not touch threads.
 * @param {import('./store').Store} store
 * @param {Partial<{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }>} patch
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null }}
 */
function setSettings(store, patch, opts) {
  const next = store.setSettings(patch || {}, opts);
  store.save();
  return next;
}

const AUTOMATION_PRESETS = new Set(["hourly", "daily", "weekly"]);

/**
 * @param {unknown} hour
 * @param {"hourly" | "daily" | "weekly"} preset
 * @returns {number | null}
 */
function normalizeAutomationHour(preset, hour) {
  if (preset === "hourly") return null;
  if (hour == null || hour === "") {
    throw new Error("Hour is required for daily and weekly automations");
  }
  const n = Number(hour);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new Error("Hour must be an integer from 0 to 23");
  }
  return n;
}

/**
 * @param {import('./store').Store} store
 * @param {object} input
 * @returns {object}
 */
function normalizeAutomationInput(store, input, existing) {
  const src = input && typeof input === "object" ? input : {};
  const base = existing || {};

  const nameRaw = Object.prototype.hasOwnProperty.call(src, "name")
    ? src.name
    : base.name;
  const name = nameRaw != null ? String(nameRaw).trim() : "";
  if (!name) {
    throw new Error("Automation name is required");
  }

  const projectId = Object.prototype.hasOwnProperty.call(src, "projectId")
    ? String(src.projectId || "")
    : String(base.projectId || "");
  if (!projectId) {
    throw new Error("Project is required");
  }
  if (!store.getProject(projectId)) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const promptRaw = Object.prototype.hasOwnProperty.call(src, "prompt")
    ? src.prompt
    : base.prompt;
  const prompt = promptRaw != null ? String(promptRaw) : "";
  if (!String(prompt).trim()) {
    throw new Error("Prompt is required");
  }

  const provider = Object.prototype.hasOwnProperty.call(src, "provider")
    ? String(src.provider || "")
    : String(base.provider || "");
  if (!provider || !isKnownProviderId(provider)) {
    throw new Error(`Unknown provider: ${src.provider ?? base.provider}`);
  }

  const modelRaw = Object.prototype.hasOwnProperty.call(src, "model")
    ? src.model
    : base.model;
  const model = normalizeModelForProvider(getProvider(provider), modelRaw);

  const preset = Object.prototype.hasOwnProperty.call(src, "preset")
    ? String(src.preset || "")
    : String(base.preset || "");
  if (!AUTOMATION_PRESETS.has(preset)) {
    throw new Error(
      `Invalid preset: ${preset || "(empty)"}. Expected hourly, daily, or weekly`,
    );
  }

  const hourRaw = Object.prototype.hasOwnProperty.call(src, "hour")
    ? src.hour
    : base.hour;
  const hour = normalizeAutomationHour(preset, hourRaw);

  let enabled = base.enabled !== undefined ? Boolean(base.enabled) : true;
  if (Object.prototype.hasOwnProperty.call(src, "enabled")) {
    enabled = Boolean(src.enabled);
  }

  return { name, projectId, prompt, provider, model, preset, hour, enabled };
}

/**
 * @param {import('./store').Store} store
 */
function listAutomations(store) {
  return store.getAutomations().map((a) => ({ ...a }));
}

/**
 * @param {import('./store').Store} store
 * @param {object} input
 */
function addAutomation(store, input) {
  const { nextFire } = require("./automations.js");
  const fields = normalizeAutomationInput(store, input, null);
  const now = Date.now();
  const created = {
    id: randomUUID(),
    ...fields,
    lastRunAt: null,
    nextRunAt: nextFire(fields.preset, fields.hour, now),
    lastError: null,
  };
  const list = store.getAutomations().slice();
  list.push(created);
  store.setAutomations(list);
  store.save();
  return { ...created };
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string } & object} input
 */
function updateAutomation(store, input) {
  const { nextFire } = require("./automations.js");
  const id = input && input.id != null ? String(input.id) : "";
  const existing = store.getAutomation(id);
  if (!existing) {
    throw new Error(`Unknown automation: ${id}`);
  }
  const fields = normalizeAutomationInput(store, input, existing);
  const scheduleChanged =
    fields.preset !== existing.preset || fields.hour !== existing.hour;
  const updated = {
    ...existing,
    ...fields,
    nextRunAt: scheduleChanged
      ? nextFire(fields.preset, fields.hour, Date.now())
      : existing.nextRunAt,
  };
  store.setAutomations(
    store.getAutomations().map((a) => (a && a.id === id ? updated : a)),
  );
  store.save();
  return { ...updated };
}

/**
 * @param {import('./store').Store} store
 * @param {{ id: string }} input
 */
function removeAutomation(store, input) {
  const id = input && input.id != null ? String(input.id) : "";
  if (!id) {
    throw new Error("Automation id is required");
  }
  const existing = store.getAutomation(id);
  if (!existing) {
    throw new Error(`Unknown automation: ${id}`);
  }
  store.setAutomations(store.getAutomations().filter((a) => !a || a.id !== id));
  store.save();
}

/**
 * Live app status: today's spend, memory health (with counts), and which build
 * is running. A /health failure degrades to nulls; status must never throw.
 * @param {import('./store').Store} store
 * @param {{ health?: () => Promise<any>, status?: () => any, pkg?: any, platform?: string }} [deps] injectable for tests
 */
async function appStatus(store, deps = {}) {
  const spend = store.getSpendToday();
  const spendTodayUsd = Math.round(spend * 100) / 100;
  const base = deps.status ? deps.status() : getMemoryStatus();

  let entries = null;
  let vectors = null;
  let lastError = null;
  if (base.running) {
    try {
      const health = deps.health ? await deps.health() : await fetchMemoryHealth(base.port);
      if (health && typeof health === "object") {
        entries = Number.isFinite(health.entryCount) ? health.entryCount : null;
        vectors =
          health.vectors && Number.isFinite(health.vectors.count)
            ? health.vectors.count
            : null;
        const je = health.janitor && health.janitor.lastError;
        lastError = je ? `${je.step}: ${je.message}` : null;
      }
    } catch {
      // health unreachable: report nulls rather than failing status
    }
  }

  let version = "0.0.0";
  let sha = null;
  let time = null;
  let channel = null;
  try {
    const pkg = deps.pkg || require("../package.json");
    version = String(pkg.version || version);
    sha = pkg.buildSha ? String(pkg.buildSha) : null;
    time = pkg.buildTime ? String(pkg.buildTime) : null;
    channel = pkg.channel ? String(pkg.channel) : null;
  } catch {
    // dev tree without a stamped package: leave nulls
  }

  return {
    spendTodayUsd,
    memory: { ...base, entries, vectors, lastError },
    build: { version, sha, time, channel, platform: deps.platform || process.platform },
  };
}

/**
 * Agent-config doctor (#412). Resolve a local checkout or throw.
 * @param {import('./store').Store} store
 * @param {{ projectId?: string }} input
 */
function requireLocalProject(store, input) {
  const projectId =
    input && input.projectId != null ? String(input.projectId) : "";
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const root = project.path;
  if (!root) throw new Error("Config doctor needs a local checkout");
  try {
    if (!fs.statSync(root).isDirectory()) {
      throw new Error("Config doctor needs a local checkout");
    }
  } catch (err) {
    if (err && err.message === "Config doctor needs a local checkout") throw err;
    throw new Error("Config doctor needs a local checkout");
  }
  return { project, root };
}

/**
 * Pull convention / strategy / knowledge rows (full bodies) for generate + coverage.
 * Memory being down returns [] for lint; generate rethrows.
 *
 * @param {{ recent?: Function, get?: Function } | null | undefined} memory
 * @param {string} projectPath
 * @param {{ required?: boolean }} [opts]
 */
async function loadConfigSourceEntries(memory, projectPath, opts) {
  const required = Boolean(opts && opts.required);
  if (!memory || typeof memory.recent !== "function") {
    if (required) throw new Error("Memory server is not running.");
    return [];
  }
  const types = ["convention", "strategy", "knowledge"];
  const seen = new Set();
  const rows = [];
  try {
    for (const type of types) {
      const list = await memory.recent({
        limit: 50,
        project: projectPath,
        type,
      });
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        if (!row || !row.id || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  } catch (err) {
    if (required) throw err;
    return [];
  }

  const full = [];
  for (const row of rows) {
    if (typeof memory.get !== "function") {
      full.push(row);
      continue;
    }
    try {
      full.push(await memory.get({ id: row.id }));
    } catch {
      full.push(row);
    }
  }
  return full;
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string }} input
 * @param {{ memory?: object }} [deps]
 */
/**
 * Browsable wiki for the Memory tab (issue #268). Builds the index on first
 * open when none exists so the map is an onboarding deliverable, not a
 * side-effect of the next agent turn.
 *
 * @param {import('./store').Store} store
 * @param {{ projectId: string }} input
 * @param {{ userDataPath?: string }} [deps]
 * @returns {Promise<import('../src/shared/ipc').ProjectCodeMap>}
 */
async function readProjectCodeMap(store, input, deps) {
  const { project, root } = requireLocalProject(store, input);
  const userDataPath = deps && deps.userDataPath ? String(deps.userDataPath) : "";
  const empty = {
    projectId: project.id,
    updatedAt: 0,
    fileCount: 0,
    symbolCount: 0,
    headSha: "",
    defaultBranch: "",
    modules: [],
    dependencies: [],
  };
  if (!userDataPath || process.env.CODER_CODEINDEX_DISABLE === "1") return empty;

  const { readIndex, refreshIndex } = require("./codeindex.js");
  const { buildWiki, publishWiki } = require("./codewiki.js");
  let index = readIndex(userDataPath, root);
  if (!index) {
    index = await refreshIndex({ userDataPath, repoRoot: root });
  }
  const wiki = await buildWiki(index, root);
  void publishWiki({ userDataPath, repoRoot: root, index });
  return { projectId: project.id, ...wiki };
}

async function lintAgentConfig(store, input, deps) {
  const { project, root } = requireLocalProject(store, input);
  const files = configDoctor.discoverAgentConfigFiles(root);
  const memoryEntries = await loadConfigSourceEntries(
    deps && deps.memory,
    root,
  );
  const report = configDoctor.lintAgentConfigFiles(files, {
    root,
    packageScripts: configDoctor.loadPackageScripts(root),
    memoryEntries,
  });
  return {
    projectId: project.id,
    ...report,
  };
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, targets?: string[] }} input
 * @param {{ memory?: object }} [deps]
 */
async function previewAgentConfig(store, input, deps) {
  const { project, root } = requireLocalProject(store, input);
  const memoryEntries = await loadConfigSourceEntries(
    deps && deps.memory,
    root,
    { required: true },
  );
  const files = configDoctor.previewGeneratedFiles({
    root,
    name: project.name || project.slug || "Project",
    memoryEntries,
    targets: input && input.targets,
  });
  const warnings = [];
  for (const file of files) {
    for (const leak of configDoctor.leakPaths(file.content)) {
      const msg = `${file.path}: absolute home-directory path looks like a leak: ${leak}`;
      if (!warnings.includes(msg)) warnings.push(msg);
    }
  }
  return { projectId: project.id, files, warnings };
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, targets?: string[] }} input
 * @param {{ memory?: object }} [deps]
 */
async function writeAgentConfig(store, input, deps) {
  const preview = await previewAgentConfig(store, input, deps);
  const { root } = requireLocalProject(store, input);
  const written = configDoctor.writeAgentConfigFiles(root, preview.files);
  return { projectId: preview.projectId, written };
}

/** GET /health on the local memory server; resolves null on any failure. */
function fetchMemoryHealth(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    /** @param {any} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        req.destroy();
      } catch {
        // already closed
      }
      resolve(value);
    };
    const req = require("node:http").get(
      { host: "127.0.0.1", port, path: "/health", timeout: 1500 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          // Health is a small JSON document; refuse to buffer a runaway body.
          if (body.length > 256 * 1024) return finish(null);
          body += c;
        });
        res.on("end", () => {
          // A 500 whose body happens to parse is not health.
          if (res.statusCode !== 200) return finish(null);
          try {
            finish(JSON.parse(body));
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => finish(null));
    // `timeout` is socket INACTIVITY, so a server dribbling a byte at a time can
    // hold status open forever. This is the absolute deadline. It is armed AFTER
    // http.get: an invalid port makes get() throw synchronously, and a timer
    // armed first would outlive the rejection and then fire into a TDZ `req`.
    deadline = setTimeout(() => finish(null), 2000);
  });
}

module.exports = {
  addProject,
  createProject,
  removeProject,
  scheduleSimulatorRelease,
  updateProject,
  pickProjectIcon,
  resolveProjectIcon,
  lintAgentConfig,
  previewAgentConfig,
  writeAgentConfig,
  createThread,
  forkThread,
  canHostWorktree,
  forkWorkerThread,
  setPermissionMode,
  setReasoningEffort,
  setWebSearch,
  setProvider,
  // normalizeModelForProvider / isKnownProviderId / truncateThreadTitle stay
  // module-private (round-49 review A-n2: dead exports). Tests use
  // THREAD_TITLE_MAX / HANDOFF_MESSAGE_MAX / buildHandoffPrefix.
  buildHandoffPrefix,
  THREAD_TITLE_MAX,
  THREAD_NOTES_MAX,
  HANDOFF_MESSAGE_MAX,
  HANDOFF_MESSAGE_COUNT,
  PLANBOARD_NOTE,
  planboardNoteFor,
  selfIdNoteFor,
  suggestedWorkNoteFor,
  CODEX_COMPUTER_USE_NOTE,
  codexComputerUseNoteFor,
  subagentPoolNoteFor: require("./subagentPool").subagentPoolNoteFor,
  resolveSubagentPool: require("./subagentPool").resolveSubagentPool,
  hypothesisNoteFor,
  HYPOTHESES_MAX,
  HYPOTHESIS_CLAIM_MAX,
  HYPOTHESIS_REASON_MAX,
  recordHypothesis,
  SUGGESTIONS_MAX,
  SUGGESTION_TITLE_MAX,
  SUGGESTION_PROMPT_MAX,
  recordSuggestion,
  resolveSuggestion,
  CREW_TASK_TITLE_MAX,
  CREW_TASK_NOTE_MAX,
  CREW_TASKS_MAX,
  CREW_TASK_ATTEMPT_CAP,
  CREW_AUTO_TURN_CAP,
  crewRootOf,
  listCrewTasks,
  addCrewTasks,
  claimCrewTask,
  completeCrewTask,
  releaseCrewTasks,
  crewTaskNoteFor,
  SPEC_ARTIFACTS,
  SPEC_DIR,
  nextSpecStage,
  specArtifactPath,
  specNoteFor,
  reviewItineraryNoteFor: require("./reviewItinerary").reviewItineraryNoteFor,
  REVIEW_ITINERARY_NOTE: require("./reviewItinerary").REVIEW_ITINERARY_NOTE,
  teachNoteFor,
  askNoteFor,
  startAsk,
  stopAsk,
  teachAutonomyFor,
  teachAllowedModes,
  teachPermissionAllowed,
  TEACH_REVIEW_THRESHOLDS,
  TEACH_REVIEW_PROMPT,
  startTeach,
  stopTeach,
  recordTeachReview,
  requestTeachReview,
  codeIndexNoteFor,
  readProjectCodeMap,
  specStagePrompt,
  startSpec,
  stopSpec,
  submitSpec,
  reviewSpec,
  dispatchSpec,
  forkSpecWave,
  convergeSpec,
  specDispatchPrompt,
  specConvergePrompt,
  readSpecArtifact,
  planStepsFrom,
  setArchived,
  setSettled,
  setPinned,
  setTags,
  setThreadProject,
  setQueued,
  takeQueued,
  addBtw,
  finishBtw,
  dismissBtw,
  promoteBtw,
  setSnoozed,
  setMuted,
  setEjected,
  setCrossThreadInbound,
  setQuotaWaitAutoResume,
  setNotes,
  setMessagePins,
  setBaseBranch,
  setPendingWorktree,
  ensureScratchProject,
  refreshWorkerSnapshot,
  setFeltEstimate,
  setVerifyCommand,
  runVerifyNow,
  runCommand,
  renameThread,
  rewindThread,
  clearRewindRestore,
  clearSettledOnActivity,
  deleteThread,
  trashThread,
  restoreThread,
  expireTrashedThreads,
  listTrashed,
  isTrashed,
  TRASH_TTL_MS,
  purgeThread,
  THREAD_STILL_HAS_WORKTREE,
  listThreads,
  threadSummaries,
  searchThreads,
  getThreadDetail,
  gitStatus,
  parseRevListCount,
  gitSyncInfo,
  gitFetch,
  repoInfoFromRemote,
  gitRepoInfo,
  summarizePullOutput,
  pullFailureReason,
  gitPull,
  listProjects,
  listSpaces,
  addSpace,
  updateSpace,
  removeSpace,
  listProvidersForApi,
  listTemplates,
  saveTemplate,
  removeTemplate,
  validateWorkflowTemplate,
  slugFromRemoteUrl,
  getSettings,
  setSettings,
  listAutomations,
  addAutomation,
  updateAutomation,
  removeAutomation,
  appStatus,
  assertUnderDailyBudget,
  assertUnderOrchestrationBudget,
  orchestrationSpend,
  PERMISSION_MODES,
};
