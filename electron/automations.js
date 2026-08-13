"use strict";

const PRESETS = new Set(["hourly", "daily", "weekly"]);

/**
 * Next fire time after `fromMs`.
 *
 * hourly: next top of the hour (strictly after fromMs).
 * daily: next occurrence of `hour` (0-23), today if still upcoming else tomorrow.
 * weekly: next occurrence of `hour` on the same weekday as fromMs.
 *
 * @param {"hourly" | "daily" | "weekly"} preset
 * @param {number | null} hour
 * @param {number} fromMs
 * @returns {number}
 */
function nextFire(preset, hour, fromMs) {
  const from = new Date(fromMs);
  if (Number.isNaN(from.getTime())) {
    throw new Error(`Invalid fromMs: ${fromMs}`);
  }
  if (preset === "hourly") {
    const next = new Date(from);
    next.setMinutes(0, 0, 0);
    if (next.getTime() <= fromMs) {
      next.setHours(next.getHours() + 1);
    }
    return next.getTime();
  }
  if (preset !== "daily" && preset !== "weekly") {
    throw new Error(`Unknown preset: ${preset}`);
  }
  const h = hour == null ? 0 : Number(hour);
  const next = new Date(from);
  next.setHours(h, 0, 0, 0);
  if (next.getTime() <= fromMs) {
    next.setDate(next.getDate() + (preset === "weekly" ? 7 : 1));
  }
  return next.getTime();
}

/**
 * Enabled automations whose nextRunAt is due at or before nowMs.
 *
 * @param {Array<{ enabled?: boolean, nextRunAt?: number }>} automations
 * @param {number} nowMs
 * @returns {object[]}
 */
function dueAutomations(automations, nowMs) {
  if (!Array.isArray(automations)) return [];
  return automations.filter(
    (a) =>
      a &&
      a.enabled &&
      typeof a.nextRunAt === "number" &&
      Number.isFinite(a.nextRunAt) &&
      a.nextRunAt <= nowMs,
  );
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  if (err && typeof err === "object" && "message" in err && err.message) {
    return String(err.message);
  }
  return String(err);
}

/**
 * Persist a patch on one automation. Does not save; caller saves.
 *
 * @param {import("./store").Store} store
 * @param {string} id
 * @param {object} patch
 */
function patchAutomation(store, id, patch) {
  const list = store.getAutomations().map((a) =>
    a && a.id === id ? { ...a, ...patch } : a,
  );
  store.setAutomations(list);
  return list.find((a) => a && a.id === id) || null;
}

/**
 * Fire one automation: create a thread titled with its name, start a run
 * with its prompt/provider/model via the same createThread + startRun path
 * the IPC handlers use, then stamp lastRunAt / nextRunAt / lastError.
 *
 * @param {{ store: import("./store").Store, runner: { startRun: Function }, broadcast?: Function }} ctx
 * @param {object} auto
 * @param {number} now
 * @param {{ rethrow?: boolean }} [opts]
 */
async function runAutomation(ctx, auto, now, opts) {
  const services = require("./services.js");
  const nextRunAt = nextFire(auto.preset, auto.hour, now);
  patchAutomation(ctx.store, auto.id, {
    lastRunAt: now,
    nextRunAt,
    lastError: null,
  });
  ctx.store.save();

  try {
    const thread = services.createThread(ctx.store, {
      projectId: auto.projectId,
      title: auto.name,
    });
    services.setProvider(ctx.store, {
      threadId: thread.id,
      provider: auto.provider,
      model: auto.model,
    });
    if (typeof ctx.broadcast === "function") {
      ctx.broadcast("threads:changed", services.listThreads(ctx.store));
    }
    await ctx.runner.startRun({
      threadId: thread.id,
      prompt: auto.prompt,
    });
    patchAutomation(ctx.store, auto.id, { lastError: null });
    ctx.store.save();
  } catch (err) {
    patchAutomation(ctx.store, auto.id, { lastError: errorText(err) });
    ctx.store.save();
    if (opts && opts.rethrow) throw err;
  }
}

/**
 * Fire one automation immediately, even if nextRunAt is in the future.
 *
 * @param {{ store: import("./store").Store, runner: { startRun: Function }, broadcast?: Function }} ctx
 * @param {string} id
 */
async function runNow(ctx, id) {
  const auto = ctx.store.getAutomation(id);
  if (!auto) {
    throw new Error(`Unknown automation: ${id}`);
  }
  await runAutomation(ctx, auto, Date.now(), { rethrow: true });
  return ctx.store.getAutomation(id);
}

/**
 * Minute ticker. Finds due automations and fires them.
 *
 * @param {{ store: import("./store").Store, runner: { startRun: Function }, broadcast?: Function, intervalMs?: number, now?: () => number }} ctx
 */
function startScheduler(ctx) {
  const intervalMs = ctx.intervalMs == null ? 60_000 : ctx.intervalMs;
  const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
  /** @type {Set<string>} */
  const firing = new Set();
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const now = nowFn();
    const due = dueAutomations(ctx.store.getAutomations(), now);
    for (const auto of due) {
      if (!auto || !auto.id || firing.has(auto.id)) continue;
      firing.add(auto.id);
      try {
        await runAutomation(ctx, auto, now);
      } finally {
        firing.delete(auto.id);
      }
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  return { stop, tick, runNow: (id) => runNow(ctx, id) };
}

module.exports = {
  PRESETS,
  nextFire,
  dueAutomations,
  runAutomation,
  runNow,
  startScheduler,
};
