"use strict";

/**
 * Serialized crew merge queue (#346).
 *
 * Uses the #947 landing contract: intoPath staging is integrated (receipt,
 * issues stay open). Only a human-approved final promote (no intoPath)
 * closes included issue IDs, and only via completeThreadIssue inside
 * mergeWorktree. This module does not close issues itself.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  mergeWorktree,
  removeWorktree,
  resolveWorktreeStart,
  gitTry,
} = require("./worktrees.js");

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function gitOk(cwd, args) {
  const res = gitTry(cwd, args, { raw: true });
  if (!res.ok) {
    throw new Error(
      (res.combined || res.stderr || "git failed").split("\n")[0],
    );
  }
  return String(res.stdout || "").trim();
}
const { classifyMergeLanding } = require("./crewIntegration.js");

const DEFAULT_PORT_BASE = 3000;
const DEFAULT_BRANCH_PREFIX = "lane/";
const DEFAULT_WORKTREE_SUFFIX = "-lane-";
const DEFAULT_BUILD_OUTPUT_DIRS = ["dist", "build", ".next"];
const DEFAULT_WEDGE_MS = 30 * 60 * 1000;
const WEDGE_WATCHDOG_INTERVAL_MS = DEFAULT_WEDGE_MS;
const WEDGE_WATCHDOG_STARTUP_MS = 15_000;

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeQueue(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * @param {object} store
 * @param {object} lead
 * @param {string[]} queue
 */
function writeQueue(store, lead, queue) {
  store.updateThread(lead.id, {
    mergeQueue: queue.length ? queue : undefined,
  });
  store.save();
}

/**
 * @param {object} store
 * @param {{ leadThreadId: string, workerThreadId: string }} input
 * @returns {string[]}
 */
function enqueue(store, input) {
  const lead = store.getThread(input && input.leadThreadId);
  if (!lead) throw new Error(`Unknown lead thread: ${input && input.leadThreadId}`);
  const worker = store.getThread(input && input.workerThreadId);
  if (!worker) {
    throw new Error(`Unknown worker thread: ${input && input.workerThreadId}`);
  }
  if (String(worker.handoffFrom || "") !== String(lead.id)) {
    throw new Error(
      `Worker ${worker.id} is not this lead's worker (handoffFrom mismatch)`,
    );
  }
  const next = normalizeQueue(lead.mergeQueue);
  if (!next.includes(worker.id)) next.push(worker.id);
  writeQueue(store, lead, next);
  return next;
}

/**
 * Squash the next queued worker onto the lead worktree.
 * Classified as integrated — must not close issues.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.leadThreadId
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {{ kind: "integrated", workerThreadId: string }}
 */
function integrateNext(opts) {
  const store = opts && opts.store;
  const lead = store.getThread(opts.leadThreadId);
  if (!lead) throw new Error(`Unknown lead thread: ${opts.leadThreadId}`);
  const project = store.getProject(lead.projectId);
  if (!project || !project.path) {
    throw new Error(`Unknown project for thread: ${lead.id}`);
  }
  if (!lead.worktreePath) {
    throw new Error("Set up a lead worktree first");
  }
  const landing = classifyMergeLanding(lead.worktreePath, project.path);
  if (landing !== "integrated") {
    throw new Error(
      "Queue integrate must target the lead worktree, not the project checkout",
    );
  }
  const queue = normalizeQueue(lead.mergeQueue);
  const workerThreadId = queue[0];
  if (!workerThreadId) throw new Error("Merge queue is empty");

  mergeWorktree({
    store,
    threadId: workerThreadId,
    intoPath: lead.worktreePath,
    broadcast: opts.broadcast,
  });
  writeQueue(store, store.getThread(lead.id) || lead, queue.slice(1));
  return { kind: "integrated", workerThreadId };
}

/**
 * @param {string} cwd
 * @param {string} command
 */
function runCheckGate(cwd, command) {
  try {
    execFileSync("sh", ["-c", String(command)], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`Merge queue check gate failed: ${command}`);
  }
}

/**
 * Land the lead on the final target. Human-only. Closes included issues
 * only because mergeWorktree classifies this as final.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.leadThreadId
 * @param {boolean} [opts.approved]
 * @param {string} [opts.checkCommand]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {{ kind: "final", workerThreadId: string }}
 */
function promote(opts) {
  if (!opts || opts.approved !== true) {
    throw new Error(
      "Promoting the merge queue is the user's decision. Ask first, then call again with approved:true.",
    );
  }
  const store = opts.store;
  const lead = store.getThread(opts.leadThreadId);
  if (!lead) throw new Error(`Unknown lead thread: ${opts.leadThreadId}`);
  const remaining = normalizeQueue(lead.mergeQueue);
  if (remaining.length) {
    throw new Error("Integrate queued workers before promoting");
  }
  const project = store.getProject(lead.projectId);
  const landing = classifyMergeLanding(undefined, project && project.path);
  if (landing !== "final") {
    throw new Error("Queue promote must land on the final target");
  }
  if (opts.checkCommand) {
    const cwd = lead.worktreePath || (project && project.path);
    if (!cwd) throw new Error("Merge queue check gate has no checkout");
    runCheckGate(cwd, opts.checkCommand);
  }
  mergeWorktree({
    store,
    threadId: lead.id,
    broadcast: opts.broadcast,
  });
  return { kind: "final", workerThreadId: lead.id };
}

/**
 * @param {unknown} n
 * @param {unknown} [portBase]
 * @returns {number}
 */
function lanePort(n, portBase) {
  const lane = Number(n);
  if (!Number.isInteger(lane) || lane < 1) {
    throw new Error("Lane must be a positive integer");
  }
  const base = portBase == null ? DEFAULT_PORT_BASE : Number(portBase);
  if (!Number.isInteger(base) || base < 1) {
    throw new Error("portBase must be a positive integer");
  }
  return base + lane;
}

/**
 * Env injected into a lane's dev server (#250).
 * @param {unknown} n
 * @param {unknown} [portBase]
 */
function laneEnv(n, portBase) {
  return {
    PORT: String(lanePort(n, portBase)),
    SOLENTA_LANE: String(Number(n)),
  };
}

/**
 * Shared PORT for the one Spotlight server at the project checkout.
 * Distinct from per-lane ports (portBase + n).
 * @param {unknown} [portBase]
 */
function spotlightEnv(portBase) {
  const base = portBase == null ? DEFAULT_PORT_BASE : Number(portBase);
  if (!Number.isInteger(base) || base < 1) {
    throw new Error("portBase must be a positive integer");
  }
  return {
    PORT: String(base),
    SOLENTA_SPOTLIGHT: "1",
  };
}

/**
 * Per-repo Spotlight opt-in (#250 stretch). true persists; false deletes.
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.projectId
 * @param {boolean} opts.enabled
 */
function setSpotlight(opts) {
  const store = opts && opts.store;
  const project = store.getProject(opts.projectId);
  if (!project) throw new Error(`Unknown project: ${opts && opts.projectId}`);
  const enabled = opts.enabled === true;
  patchProject(store, project.id, {
    spotlight: enabled ? true : undefined,
  });
  return { spotlight: enabled };
}

/**
 * Hot-swap the selected lane onto main. Composes restorePreview (when
 * another lane is mirrored) then previewLane. Does not close issues.
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.projectId
 * @param {number} opts.lane
 * @param {string[]} [opts.buildOutputDirs]
 */
function spotlightLane(opts) {
  const store = opts && opts.store;
  const project = store.getProject(opts && opts.projectId);
  if (!project || !project.path) {
    throw new Error(`Unknown project: ${opts && opts.projectId}`);
  }
  if (project.spotlight !== true) {
    throw new Error("Spotlight is off for this project");
  }
  const n = Number(opts.lane);
  const current = project.mergePreview;
  if (current && Number(current.lane) !== n) {
    restorePreview({ store, projectId: project.id });
  }
  const previewed = previewLane({
    store,
    projectId: project.id,
    lane: n,
    buildOutputDirs: opts.buildOutputDirs,
  });
  return { ...previewed, spotlight: true };
}

/**
 * @param {unknown} raw
 * @returns {{ n: number, port: number, claimedAt: number, lastBeat: number } | null}
 */
function normalizeLane(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = Number(raw.n);
  if (!Number.isInteger(n) || n < 1) return null;
  const port = Number(raw.port);
  return {
    n,
    port: Number.isInteger(port) && port > 0 ? port : lanePort(n),
    claimedAt:
      typeof raw.claimedAt === "number" && Number.isFinite(raw.claimedAt)
        ? raw.claimedAt
        : 0,
    lastBeat:
      typeof raw.lastBeat === "number" && Number.isFinite(raw.lastBeat)
        ? raw.lastBeat
        : 0,
  };
}

/**
 * @param {object} store
 * @param {string} projectId
 */
function listLanes(store, projectId) {
  const out = [];
  if (!projectId) return out;
  for (const t of store.getThreads()) {
    if (!t || t.projectId !== projectId) continue;
    const lane = normalizeLane(t.lane);
    if (!lane) continue;
    out.push({
      n: lane.n,
      threadId: t.id,
      port: lane.port,
      path: t.worktreePath || null,
      branch: t.branch || null,
      claimedAt: lane.claimedAt,
      lastBeat: lane.lastBeat,
    });
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

/**
 * @param {object} store
 * @param {string} projectId
 */
function nextFreeLane(store, projectId) {
  const taken = new Set(listLanes(store, projectId).map((l) => l.n));
  let n = 1;
  while (taken.has(n)) n += 1;
  return n;
}

/**
 * @param {object} project
 * @param {number} n
 */
function laneDirName(project, n) {
  const base = path.basename(project.path || "project");
  return `${base}${DEFAULT_WORKTREE_SUFFIX}${n}`;
}

/**
 * Claim the lowest free numbered worktree lane for this thread.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.worktreeBase
 * @param {number} [opts.portBase]
 * @param {number} [opts.now]
 */
function claimLane(opts) {
  const store = opts && opts.store;
  const thread = store.getThread(opts.threadId);
  if (!thread) throw new Error(`Unknown thread: ${opts && opts.threadId}`);
  const existing = normalizeLane(thread.lane);
  if (existing && thread.worktreePath && fs.existsSync(thread.worktreePath)) {
    return {
      n: existing.n,
      port: existing.port,
      path: thread.worktreePath,
      branch: thread.branch,
    };
  }
  const project = store.getProject(thread.projectId);
  if (!project || !project.path) {
    throw new Error(`Unknown project for thread: ${thread.id}`);
  }
  const worktreeBase = opts.worktreeBase;
  if (!worktreeBase) throw new Error("worktreeBase is required");
  const n = nextFreeLane(store, thread.projectId);
  const port = lanePort(n, opts.portBase);
  const now = opts.now == null ? Date.now() : opts.now;
  const dir = path.join(worktreeBase, laneDirName(project, n));
  const branch = `${DEFAULT_BRANCH_PREFIX}${n}`;
  fs.mkdirSync(worktreeBase, { recursive: true });
  gitTry(project.path, ["worktree", "remove", "--force", dir]);
  gitTry(project.path, ["branch", "-D", branch]);
  const start = resolveWorktreeStart(thread, project.path);
  gitOk(project.path, ["worktree", "add", "-b", branch, dir, start]);
  store.updateThread(thread.id, {
    worktreePath: dir,
    branch,
    lane: { n, port, claimedAt: now, lastBeat: now },
  });
  store.save();
  return { n, port, path: dir, branch };
}

/**
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {number} [opts.now]
 */
function heartbeatLane(opts) {
  const store = opts && opts.store;
  const thread = store.getThread(opts.threadId);
  const lane = thread && normalizeLane(thread.lane);
  if (!lane) return null;
  const next = {
    ...lane,
    lastBeat: opts.now == null ? Date.now() : opts.now,
  };
  store.updateThread(thread.id, { lane: next });
  store.save();
  return next;
}

/**
 * @param {import('./store').Store} store
 * @param {string} projectId
 * @param {object} patch
 */
function patchProject(store, projectId, patch) {
  const projects = store.getProjects().slice();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) throw new Error(`Unknown project: ${projectId}`);
  const next = { ...projects[idx] };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  projects[idx] = next;
  store.setProjects(projects);
  store.save();
  return next;
}

/**
 * @param {string} root
 * @param {Set<string>} skipDirs
 * @returns {string[]}
 */
function listMirrorFiles(root, skipDirs) {
  /** @type {string[]} */
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(child);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) out.push(child);
    }
  };
  walk("");
  return out;
}

/**
 * Mirror a lane's live tree onto the project checkout (no build outputs).
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.projectId
 * @param {number} opts.lane
 * @param {string[]} [opts.buildOutputDirs]
 */
function previewLane(opts) {
  const store = opts && opts.store;
  const project = store.getProject(opts.projectId);
  if (!project || !project.path) {
    throw new Error(`Unknown project: ${opts && opts.projectId}`);
  }
  const n = Number(opts.lane);
  const row = listLanes(store, project.id).find((l) => l.n === n);
  if (!row || !row.path) throw new Error(`Lane ${n} is not claimed`);
  const current = project.mergePreview;
  const already = current && Number(current.lane) === n;
  const porcelain = gitOk(project.path, ["status", "--porcelain"]);
  if (porcelain && !already) {
    throw new Error("Main checkout is dirty; restore or commit before preview");
  }
  const skip = new Set(
    Array.isArray(opts.buildOutputDirs)
      ? opts.buildOutputDirs
      : DEFAULT_BUILD_OUTPUT_DIRS,
  );
  const sha = gitOk(project.path, ["rev-parse", "HEAD"]);
  const files = listMirrorFiles(row.path, skip);
  for (const rel of files) {
    const dest = path.join(project.path, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(row.path, rel), dest);
  }
  const next = patchProject(store, project.id, {
    mergePreview: { lane: n, sha, files },
  });
  return { lane: n, sha, files, path: next.path };
}

/**
 * @param {string} destRoot
 * @param {string} rel
 */
function unlinkCopied(destRoot, rel) {
  const abs = path.join(destRoot, rel);
  try {
    fs.unlinkSync(abs);
  } catch {
    // already gone
  }
  let dir = path.dirname(abs);
  const root = path.resolve(destRoot);
  while (dir.startsWith(root) && dir !== root) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Undo a preview mirror. Does not move the lane or close issues.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.projectId
 */
function restorePreview(opts) {
  const store = opts && opts.store;
  const project = store.getProject(opts.projectId);
  if (!project || !project.path) {
    throw new Error(`Unknown project: ${opts && opts.projectId}`);
  }
  const preview = project.mergePreview;
  if (!preview || !preview.sha) return { restored: false };
  gitOk(project.path, ["reset", "--hard", String(preview.sha)]);
  for (const rel of Array.isArray(preview.files) ? preview.files : []) {
    const tracked = gitTry(project.path, [
      "cat-file",
      "-e",
      `${preview.sha}:${rel}`,
    ]);
    if (!tracked.ok) unlinkCopied(project.path, rel);
  }
  patchProject(store, project.id, { mergePreview: undefined });
  return { restored: true, sha: preview.sha };
}

/**
 * Tear down lanes whose heartbeat is older than wedgeMs.
 * Does not close issues and does not move the project checkout.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.projectId
 * @param {number} [opts.now]
 * @param {number} [opts.wedgeMs]
 * @returns {{ n: number, threadId: string }[]}
 */
function recycleWedgedLanes(opts) {
  const store = opts && opts.store;
  const now = opts.now == null ? Date.now() : opts.now;
  const wedgeMs = opts.wedgeMs == null ? DEFAULT_WEDGE_MS : opts.wedgeMs;
  const recycled = [];
  for (const row of listLanes(store, opts.projectId)) {
    const beat = row.lastBeat || row.claimedAt || 0;
    if (now - beat < wedgeMs) continue;
    const live = store.getThread(row.threadId);
    if (live && live.worktreePath) {
      removeWorktree({
        store,
        threadId: row.threadId,
        force: true,
      });
    }
    store.updateThread(row.threadId, { lane: undefined });
    store.save();
    recycled.push({ n: row.n, threadId: row.threadId });
  }
  return recycled;
}

/**
 * Main-process interval: recycle wedged lanes for every project.
 * Same shape as createRetentionSweeper — unref'd startup + interval,
 * injectable timers and now. Does not close issues and does not move main.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {number | (() => number)} [opts.now]
 * @param {number} [opts.wedgeMs]
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.startupDelayMs]
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 * @param {typeof recycleWedgedLanes} [opts.recycleFn]
 */
function createWedgedLaneWatchdog(opts) {
  const store = opts.store;
  const intervalMs =
    opts.intervalMs != null ? opts.intervalMs : WEDGE_WATCHDOG_INTERVAL_MS;
  const startupDelayMs =
    opts.startupDelayMs != null
      ? opts.startupDelayMs
      : WEDGE_WATCHDOG_STARTUP_MS;
  const wedgeMs = opts.wedgeMs == null ? DEFAULT_WEDGE_MS : opts.wedgeMs;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const recycleFn = opts.recycleFn || recycleWedgedLanes;

  function resolveNow() {
    if (opts.now == null) return Date.now();
    return typeof opts.now === "function" ? opts.now() : opts.now;
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let startupTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let intervalTimer = null;

  function tick() {
    const now = resolveNow();
    const projects =
      store && typeof store.getProjects === "function"
        ? store.getProjects()
        : [];
    for (const project of projects) {
      if (!project || !project.id) continue;
      try {
        recycleFn({
          store,
          projectId: project.id,
          now,
          wedgeMs,
        });
      } catch {
        // one project must not stop the rest
      }
    }
  }

  function start() {
    if (startupTimer != null || intervalTimer != null) return;
    startupTimer = setTimeoutFn(() => {
      startupTimer = null;
      tick();
    }, startupDelayMs);
    if (startupTimer && typeof startupTimer.unref === "function") {
      startupTimer.unref();
    }
    intervalTimer = setIntervalFn(() => {
      tick();
    }, intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === "function") {
      intervalTimer.unref();
    }
  }

  function stop() {
    if (startupTimer != null) {
      clearTimeoutFn(startupTimer);
      startupTimer = null;
    }
    if (intervalTimer != null) {
      clearIntervalFn(intervalTimer);
      intervalTimer = null;
    }
  }

  return { start, stop, tick };
}

module.exports = {
  enqueue,
  integrateNext,
  promote,
  normalizeQueue,
  claimLane,
  listLanes,
  lanePort,
  laneEnv,
  spotlightEnv,
  setSpotlight,
  spotlightLane,
  heartbeatLane,
  previewLane,
  restorePreview,
  recycleWedgedLanes,
  createWedgedLaneWatchdog,
  DEFAULT_PORT_BASE,
  DEFAULT_WEDGE_MS,
  DEFAULT_BUILD_OUTPUT_DIRS,
  WEDGE_WATCHDOG_INTERVAL_MS,
  WEDGE_WATCHDOG_STARTUP_MS,
};
