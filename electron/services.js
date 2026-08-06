"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  getProvider,
  knownProviderIds,
  listProviders,
} = require("./providers.js");
const { getMemoryStatus } = require("./memory-sup.js");

const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function gitOut(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

/**
 * Validate path is a git work tree; add ProjectInfo to store.
 * @param {import('./store').Store} store
 * @param {string} projectPath
 */
function addProject(store, projectPath) {
  const resolved = path.resolve(projectPath);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }

  try {
    const inside = gitOut(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      throw new Error("not a git repository");
    }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    if (/not a git repository/i.test(msg) || /not a git/i.test(msg)) {
      throw new Error(
        `Not a git repository: ${resolved}. Choose a directory inside a git work tree.`,
      );
    }
    throw new Error(
      `Not a git repository: ${resolved}. Choose a directory inside a git work tree.`,
    );
  }

  const folderName = path.basename(resolved);
  let slug = folderName;
  let name = folderName;

  try {
    const remote = gitOut(resolved, ["remote", "get-url", "origin"]);
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
  };

  const projects = store.getProjects().slice();
  projects.push(project);
  store.setProjects(projects);
  store.save();
  return project;
}

/**
 * @param {import('./store').Store} store
 * @param {{ projectId: string, title: string }} input
 */
function createThread(store, input) {
  const project = store.getProject(input.projectId);
  if (!project) {
    throw new Error(`Unknown project: ${input.projectId}`);
  }

  const now = Date.now();
  const thread = {
    id: randomUUID(),
    projectId: input.projectId,
    title: input.title || "New Thread",
    branch: null,
    prNumber: null,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    runStartedAt: null,
    archived: false,
    provider: "claude",
    model: null,
    sessionId: null,
    permissionMode: "default",
    worktreePath: null,
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
  const updated = store.updateThread(threadId, { permissionMode: mode });
  store.save();
  return updated ? { ...updated } : { ...thread, permissionMode: mode };
}

/**
 * Set thread provider and/or model. Does not bump updatedAt.
 *
 * Rejects unknown provider ids. Rejects provider change once sessionId is set.
 * Model-only changes are allowed for providers that advertise models (e.g.
 * claude); rejected when a non-null model is passed for providers with an
 * empty models list.
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
    return { ...thread };
  }

  const nextProvider = providerProvided ? input.provider : thread.provider;
  if (providerProvided) {
    const id = String(input.provider || "");
    const known =
      knownProviderIds().includes(id) ||
      (id === "simulate" && process.env.CODER_SIMULATE === "1");
    if (!known) {
      throw new Error(`Unknown provider: ${input.provider}`);
    }
  }

  const providerChanging =
    providerProvided && String(input.provider) !== String(thread.provider);

  if (providerChanging && thread.sessionId) {
    throw new Error(
      `This thread already has a ${thread.provider} session. Create a new thread to switch providers.`,
    );
  }

  if (modelProvided && input.model != null && input.model !== "") {
    const entry = getProvider(nextProvider);
    if (entry && Array.isArray(entry.models) && entry.models.length === 0) {
      throw new Error(
        `Provider ${nextProvider} does not support model selection`,
      );
    }
  }

  /** @type {{ provider?: string, model?: string | null }} */
  const patch = {};
  if (providerProvided) patch.provider = String(input.provider);

  if (providerChanging) {
    // Do not carry the old provider's model into the new provider's argv.
    // Keep a model only when this call supplies one that is valid for the
    // NEW provider (non-empty models list); otherwise force null.
    const nextEntry = getProvider(nextProvider);
    const incoming =
      modelProvided && input.model != null && input.model !== ""
        ? String(input.model)
        : null;
    const validForNew =
      incoming != null &&
      nextEntry &&
      Array.isArray(nextEntry.models) &&
      nextEntry.models.length > 0;
    patch.model = validForNew ? incoming : null;
  } else if (modelProvided) {
    patch.model =
      input.model == null || input.model === "" ? null : String(input.model);
  }

  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * @param {import('./store').Store} [_store]
 * @param {object} [opts] - forwarded to listProviders (which, env, …)
 */
function listProvidersForApi(_store, opts) {
  return listProviders(opts);
}

/**
 * Archive or unarchive a thread. Does not bump updatedAt (not real activity).
 * @param {import('./store').Store} store
 * @param {{ threadId: string, archived: boolean }} input
 */
function setArchived(store, input) {
  const { threadId, archived } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const updated = store.updateThread(threadId, {
    archived: Boolean(archived),
  });
  store.save();
  return updated ? { ...updated } : { ...thread, archived: Boolean(archived) };
}

/**
 * Permanently delete a thread with its messages and work log.
 * Rejects while a run is active (when isRunning is provided) and when a
 * worktree is still attached.
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @param {{ isRunning?: (threadId: string) => boolean }} [opts]
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
    throw new Error(
      "Thread still has a worktree. Merge or delete it in the Git tab first.",
    );
  }
  store.removeThread(threadId);
  store.save();
}

/**
 * @param {import('./store').Store} store
 */
function listThreads(store) {
  return store.getThreads().slice();
}

/**
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {object | null} [workflow]
 */
function getThreadDetail(store, threadId, workflow = null) {
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  return {
    thread: { ...thread },
    messages: store.getMessages(threadId).slice(),
    workLog: store.getWorkLog(threadId).slice(),
    workflow: workflow ?? null,
    usage: store.getUsage(threadId) ?? null,
  };
}

/**
 * @param {string} projectPath
 * @returns {{ isRepo: boolean, branch: string, dirty: boolean }}
 */
function gitStatus(projectPath) {
  const resolved = path.resolve(projectPath);
  try {
    const inside = gitOut(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      return { isRepo: false, branch: "", dirty: false };
    }
  } catch {
    return { isRepo: false, branch: "", dirty: false };
  }

  let branch = "";
  try {
    branch = gitOut(resolved, ["branch", "--show-current"]);
  } catch {
    branch = "";
  }

  let dirty = false;
  try {
    const porcelain = gitOut(resolved, ["status", "--porcelain"]);
    dirty = porcelain.length > 0;
  } catch {
    dirty = false;
  }

  return { isRepo: true, branch, dirty };
}

/**
 * List all projects.
 * @param {import('./store').Store} store
 */
function listProjects(store) {
  return store.getProjects().slice();
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

    const model =
      phase.model == null || phase.model === "" ? null : String(phase.model);
    if (
      model != null &&
      Array.isArray(entry.models) &&
      entry.models.length > 0 &&
      !entry.models.includes(model)
    ) {
      throw new Error(
        `Phase "${phaseName}": model "${model}" is not in provider ${providerId}'s model list`,
      );
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
    model: p.model == null || p.model === "" ? null : String(p.model),
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
 * @returns {{ dailyBudgetUsd: number | null }}
 */
function getSettings(store) {
  return store.getSettings();
}

/**
 * Validate and persist settings. Does not touch threads.
 * @param {import('./store').Store} store
 * @param {Partial<{ dailyBudgetUsd: number | null }>} patch
 * @returns {{ dailyBudgetUsd: number | null }}
 */
function setSettings(store, patch) {
  const next = store.setSettings(patch || {});
  store.save();
  return next;
}

/**
 * @param {import('./store').Store} store
 * @returns {{ spendTodayUsd: number, memory: { running: boolean, adopted: boolean, port: number | null } }}
 */
function appStatus(store) {
  const spend = store.getSpendToday();
  const spendTodayUsd = Math.round(spend * 100) / 100;
  return {
    spendTodayUsd,
    memory: getMemoryStatus(),
  };
}

/**
 * Reject when a daily budget is set and today's spend is already at/over it.
 * Start-time only; does not kill in-flight runs.
 * @param {import('./store').Store} store
 */
function assertUnderDailyBudget(store) {
  const settings = store.getSettings();
  const budget = settings.dailyBudgetUsd;
  if (budget == null) return;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return;
  }
  const spent = store.getSpendToday();
  if (spent >= budget) {
    throw new Error(
      `Daily budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise or clear the cap in Settings.`,
    );
  }
}

module.exports = {
  addProject,
  createThread,
  setPermissionMode,
  setProvider,
  setArchived,
  deleteThread,
  listThreads,
  getThreadDetail,
  gitStatus,
  listProjects,
  listProvidersForApi,
  listTemplates,
  saveTemplate,
  removeTemplate,
  validateWorkflowTemplate,
  slugFromRemoteUrl,
  getSettings,
  setSettings,
  appStatus,
  assertUnderDailyBudget,
  PERMISSION_MODES,
};
