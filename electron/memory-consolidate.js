"use strict";

/**
 * Sleep-time memory consolidation (issue #722).
 *
 * Dual-gated per project (≥24h since last fire AND ≥N open review-queue
 * items), then a thread running a cheap worker with a self-contained
 * prompt. Same scheduler shape as automations/postmerge — not a
 * user-visible Automation.
 *
 * Sandbox is host-enforced: memory-only MCP config + Claude
 * `--allowedTools=mcp__coder-memory__*`, and non-memory permission
 * prompts (including memory_delete) are auto-denied. The prompt restates
 * the same rules so a provider without a permission channel still sees
 * them.
 */

const fs = require("node:fs");

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_OPEN = 5;
const WORK_CAP = 20;
const MAX_THREADS_PER_PROJECT = 10;
const TITLE = "Memory consolidation";

/**
 * @returns {number}
 */
function resolveIntervalMs() {
  const raw = process.env.CODER_MEMORY_CONSOLIDATE_INTERVAL_MS;
  if (raw == null || raw === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_MS;
  return n;
}

/**
 * @returns {number}
 */
function resolveMinOpen() {
  const raw = process.env.CODER_MEMORY_CONSOLIDATE_MIN_ITEMS;
  if (raw == null || raw === "") return DEFAULT_MIN_OPEN;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_MIN_OPEN;
  return n;
}

/**
 * Dual-gate: enough open queue work, and long enough since the last fire.
 * Missing lastRunAt (never run) passes the interval side.
 *
 * @param {{
 *   lastRunAt?: number | null,
 *   openCount?: number,
 *   now: number,
 *   minIntervalMs?: number,
 *   minOpen?: number,
 * }} opts
 * @returns {{ ok: boolean, reason?: "interval" | "queue" }}
 */
function shouldConsolidate(opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : 0;
  const open = Number(opts && opts.openCount);
  const minOpen =
    opts && Number.isInteger(opts.minOpen) ? opts.minOpen : resolveMinOpen();
  const minInterval =
    opts && Number.isFinite(opts.minIntervalMs)
      ? opts.minIntervalMs
      : resolveIntervalMs();
  if (!Number.isFinite(open) || open < minOpen) {
    return { ok: false, reason: "queue" };
  }
  const last = opts && opts.lastRunAt;
  if (
    last != null &&
    Number.isFinite(last) &&
    now - last < minInterval
  ) {
    return { ok: false, reason: "interval" };
  }
  return { ok: true };
}

/**
 * Tools this pass may auto-approve. Bare MCP names and the Claude
 * `mcp__coder-memory__*` form both count. memory_delete is refused even
 * though it lives on the memory server: losers are tombstoned.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isMemoryConsolidateTool(name) {
  const n = String(name || "");
  const bare = n.includes("__") ? n.slice(n.lastIndexOf("__") + 2) : n;
  if (bare === "memory_delete") return false;
  if (n.startsWith("mcp__coder-memory__")) return true;
  return bare.startsWith("memory_") || bare.startsWith("session_");
}

/**
 * @param {{ projectPath: string, now?: number, workCap?: number }} opts
 * @returns {string}
 */
function buildConsolidatePrompt(opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const cap =
    opts && Number.isInteger(opts.workCap) && opts.workCap > 0
      ? opts.workCap
      : WORK_CAP;
  const projectPath =
    opts && opts.projectPath != null ? String(opts.projectPath) : "";
  return [
    "You are the sleep-time memory consolidation agent for this project.",
    "",
    "SANDBOX: you may only call coder-memory MCP tools. Do not use file, shell, web, or thread tools. Do not call memory_delete. Losers are tombstoned (supersede or invalidate), never deleted.",
    "",
    `Today's date (ISO): ${today}`,
    `On every memory call, pass project set to this working directory: ${projectPath}`,
    `Cap this pass at ${cap} review-queue items; leave the rest for a later pass.`,
    "",
    "Steps:",
    "1. Call memory_maintenance for this project.",
    "2. Call memory_distill for this project.",
    "3. For each open review-queue pair (up to the cap): merge via memory_supersede, memory_resolve {id, resolution: \"invalidate\"} the stale side, or memory_resolve {id, resolution: \"noop\"}.",
    "   - Same fact / complementary details: memory_supersede the weaker entry (merge unique details into the survivor).",
    "   - One side is stale or contradicted: invalidate (tombstone the older/losing entry).",
    "   - Both should stay: noop.",
    "4. For each fat convention (>1500 chars): memory_supersede with a tighter body that keeps every rule; never drop rules to save space.",
    "5. From the distill evidence pack, memory_store type:strategy rules that are not already listed, then memory_supersede each consumed run with a one-line outcome.",
    "6. In every body you write, replace relative dates (\"yesterday\", \"last week\", \"today\") with ISO dates (YYYY-MM-DD) using today's date above.",
    '7. Finish by memory_store a type:run entry titled "consolidation" whose body is of the form: last consolidation: X resolved, Y merged. Include strategy and trim counts in the same body if you wrote any.',
    "",
    "If the reports are empty, still write the run entry with zeros.",
  ].join("\n");
}

/**
 * Cheap worker: grok-4.5 when the grok CLI is installed, otherwise Claude
 * default. Claude is the provider that can actually confine tools via
 * --allowedTools; grok relies on the prompt plus the host deny list.
 *
 * @returns {{ provider: string, model: string | null }}
 */
function resolveConsolidateProvider() {
  const { getProvider, isBinAvailable, resolveBin } = require("./providers.js");
  const grok = getProvider("grok");
  if (grok && isBinAvailable(resolveBin(grok))) {
    return { provider: "grok", model: "grok-4.5" };
  }
  return { provider: "claude", model: null };
}

/**
 * @param {import("./store").Store} store
 * @param {string} projectId
 * @param {object} patch
 */
function patchProject(store, projectId, patch) {
  store.setProjects(
    store.getProjects().map((p) =>
      p && p.id === projectId ? { ...p, ...patch } : p,
    ),
  );
}

/**
 * Drop oldest consolidation threads past MAX_THREADS_PER_PROJECT.
 * Same keep rules as automation prune: live / worktree / pinned stay.
 *
 * @param {import("./store").Store} store
 * @param {string} projectId
 */
function pruneConsolidateThreads(store, projectId) {
  const services = require("./services.js");
  const indexed = store
    .getThreads()
    .map((t, i) => ({ t, i }))
    .filter(
      ({ t }) =>
        t && t.projectId === projectId && t.memoryConsolidate === true,
    );
  indexed.sort((a, b) => b.t.createdAt - a.t.createdAt || b.i - a.i);
  for (let i = MAX_THREADS_PER_PROJECT; i < indexed.length; i++) {
    const t = indexed[i].t;
    if (t.status === "working" || t.worktreePath || t.pinnedAt) continue;
    services.purgeThread(store, t.id);
  }
}

/**
 * @param {{ store: import("./store").Store }} ctx
 * @param {object} project
 * @returns {boolean}
 */
function hasWorkingPass(ctx, project) {
  return ctx.store.getThreads().some(
    (t) =>
      t &&
      t.projectId === project.id &&
      t.memoryConsolidate === true &&
      t.status === "working",
  );
}

/**
 * @param {{
 *   store: import("./store").Store,
 *   runner: { startRun: Function },
 *   broadcast?: Function,
 *   userDataPath?: string,
 *   maintenance?: (project: object) => Promise<{ queue?: { open?: number } }>,
 *   resolveProvider?: () => { provider: string, model: string | null },
 * }} ctx
 * @param {object} project
 * @returns {Promise<{ queue?: { open?: number } }>}
 */
async function loadMaintenance(ctx, project) {
  if (typeof ctx.maintenance === "function") {
    return ctx.maintenance(project);
  }
  const { createMemoryProxy } = require("./memory-proxy.js");
  const memory = createMemoryProxy({
    userDataPath: ctx.userDataPath || "",
  });
  return memory.maintenance({ project: project.path });
}

/**
 * Fire one consolidation pass. Stamps lastRunAt before startRun so a
 * crash cannot re-fire on the next tick.
 *
 * @param {object} ctx
 * @param {object} project
 * @param {number} now
 * @param {{ bypassGate?: boolean }} [opts]
 * @returns {Promise<object | null>} the thread, or null when skipped
 */
async function fireConsolidate(ctx, project, now, opts) {
  const services = require("./services.js");
  if (!project || !project.id || !project.path) return null;
  if (project.remoteHost) return null;
  try {
    if (!fs.existsSync(project.path)) return null;
  } catch {
    return null;
  }
  if (hasWorkingPass(ctx, project)) return null;

  if (!(opts && opts.bypassGate)) {
    let report;
    try {
      report = await loadMaintenance(ctx, project);
    } catch {
      return null;
    }
    const open = report && report.queue ? Number(report.queue.open) : 0;
    const gate = shouldConsolidate({
      lastRunAt: project.memoryConsolidateAt,
      openCount: open,
      now,
    });
    if (!gate.ok) return null;
  }

  const resolved =
    typeof ctx.resolveProvider === "function"
      ? ctx.resolveProvider()
      : resolveConsolidateProvider();

  patchProject(ctx.store, project.id, {
    memoryConsolidateAt: now,
    memoryConsolidateError: null,
  });
  ctx.store.save();

  const prompt = buildConsolidatePrompt({
    projectPath: project.path,
    now,
  });

  let runErr = null;
  let thread = null;
  try {
    thread = services.createThread(ctx.store, {
      projectId: project.id,
      title: TITLE,
      memoryConsolidate: true,
    });
    services.setProvider(ctx.store, {
      threadId: thread.id,
      provider: resolved.provider,
      model: resolved.model,
    });
    if (typeof ctx.broadcast === "function") {
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    }
    await ctx.runner.startRun({
      threadId: thread.id,
      prompt,
    });
    patchProject(ctx.store, project.id, { memoryConsolidateError: null });
    ctx.store.save();
  } catch (err) {
    runErr = err;
    const message =
      err && typeof err === "object" && "message" in err && err.message
        ? String(err.message)
        : String(err);
    patchProject(ctx.store, project.id, {
      memoryConsolidateError: message,
    });
    ctx.store.save();
  }

  try {
    pruneConsolidateThreads(ctx.store, project.id);
    ctx.store.save();
  } catch {
    // ignore
  }
  if (typeof ctx.broadcast === "function") {
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
  }
  if (runErr && opts && opts.rethrow) throw runErr;
  return ctx.store.getThread(thread && thread.id) || thread;
}

/**
 * Minute ticker. Dual-gate then fire, one project at a time.
 *
 * @param {{
 *   store: import("./store").Store,
 *   runner: { startRun: Function },
 *   broadcast?: Function,
 *   userDataPath?: string,
 *   intervalMs?: number,
 *   now?: () => number,
 *   maintenance?: Function,
 *   resolveProvider?: Function,
 * }} ctx
 */
function startMemoryConsolidateScheduler(ctx) {
  const intervalMs = ctx.intervalMs == null ? 60_000 : ctx.intervalMs;
  const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
  let stopped = false;
  let firing = false;

  async function tick() {
    if (stopped || firing) return;
    firing = true;
    try {
      const now = nowFn();
      const projects = ctx.store.getProjects() || [];
      for (const project of projects) {
        if (stopped) return;
        try {
          await fireConsolidate(ctx, project, now);
        } catch {
          // never kill the ticker
        }
      }
    } finally {
      firing = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  return {
    stop,
    tick,
    runNow: (projectId) => {
      const project = ctx.store
        .getProjects()
        .find((p) => p && p.id === projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      return fireConsolidate(ctx, project, nowFn(), {
        bypassGate: true,
        rethrow: true,
      });
    },
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MIN_OPEN,
  WORK_CAP,
  MAX_THREADS_PER_PROJECT,
  TITLE,
  resolveIntervalMs,
  resolveMinOpen,
  shouldConsolidate,
  isMemoryConsolidateTool,
  buildConsolidatePrompt,
  resolveConsolidateProvider,
  pruneConsolidateThreads,
  fireConsolidate,
  startMemoryConsolidateScheduler,
};
