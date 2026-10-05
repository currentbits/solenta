"use strict";

// createRunner seam: quota wait and quota failover (#1447, seam 8). Follows
// the seam convention in the header of electron/runner-watchdogs.js.
// markRunFailed stays in runner.js and calls tryQuotaFailover /
// scheduleQuotaWake from this factory's return. startRun is read lazily.
// The factory owns the quota timers; stopAll clears them through cancelAll().

const services = require("./services.js");
const { getProvider } = require("./providers.js");
const { nextQuotaFailover, quotaWaitEnabled } = require("./quotaWait.js");

/**
 * @param {object} ctx - createRunner context (see runner-watchdogs.js header)
 */
function createQuotaWait(ctx) {
  const {
    store,
    active,
    shortError,
    appendMessage,
    pushDetail,
    pushThreadsChanged,
  } = ctx;

  /**
   * Quota-wait (#462): one timer per parked thread. Wake once; a second
   * quota error on the same prompt fails. Distinct from #286 / #294.
   * @type {Map<string, ReturnType<typeof setTimeout>>}
   */
  const quotaTimers = new Map();

  function cancelQuotaWake(threadId) {
    const t = quotaTimers.get(threadId);
    if (!t) return;
    clearTimeout(t);
    quotaTimers.delete(threadId);
  }

  function lastUserOnThread(threadId) {
    const msgs = store.getMessages(threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === "user") return msgs[i];
    }
    return null;
  }

  /**
   * Switch to the next available quotaFailover provider and schedule a
   * same-prompt resume. Returns true when the switch landed.
   */
  function tryQuotaFailover(threadId, errText, runId, extraPatch) {
    const thread = store.getThread(threadId);
    if (!thread) return false;
    const settings = store.getSettings();
    let probe = thread;
    let candidate = null;
    for (let i = 0; i < 8; i++) {
      candidate = nextQuotaFailover({
        text: errText,
        thread: probe,
        settings,
      });
      if (!candidate) return false;
      if (getProvider(candidate.provider)) break;
      probe = { ...probe, quotaFailoverTried: candidate.tried };
      candidate = null;
    }
    if (!candidate) return false;
    const fromProvider = String(thread.provider || "provider");
    // The run has already left `active`, but status is still "working"
    // until this function patches it. setProvider refuses a live run.
    store.updateThread(threadId, {
      status: "idle",
      runStartedAt: null,
    });
    try {
      services.setProvider(store, {
        threadId,
        provider: candidate.provider,
      });
    } catch {
      return false;
    }
    const switched = store.getThread(threadId);
    if (!switched || switched.provider !== candidate.provider) return false;
    store.updateThread(
      threadId,
      {
        ...(extraPatch || {}),
        status: "idle",
        runStartedAt: null,
        lastError: null,
        lastErrorKind: null,
        quotaWaitUntil: null,
        quotaFailoverTried: candidate.tried,
        quotaFailoverPending: true,
      },
      { touch: true },
    );
    appendMessage(threadId, "event", errText, runId);
    appendMessage(
      threadId,
      "event",
      `Quota failover: ${fromProvider} exhausted, switching to ${candidate.provider}.`,
    );
    scheduleFailoverResume(threadId);
    return true;
  }

  function scheduleFailoverResume(threadId) {
    cancelQuotaWake(threadId);
    const timer = setTimeout(() => {
      quotaTimers.delete(threadId);
      void fireFailoverResume(threadId);
    }, 50);
    if (typeof timer.unref === "function") timer.unref();
    quotaTimers.set(threadId, timer);
  }

  async function fireFailoverResume(threadId) {
    const thread = store.getThread(threadId);
    if (!thread || thread.quotaFailoverPending !== true) return;
    if (active.has(threadId)) return;
    const user = lastUserOnThread(threadId);
    if (!user || !String(user.text || "").trim()) {
      store.updateThread(
        threadId,
        {
          status: "failed",
          quotaFailoverPending: false,
          lastError: shortError("Quota failover: nothing to resume"),
        },
        { touch: true },
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      return;
    }
    try {
      await ctx.startRun({
        threadId,
        prompt: user.text,
        attachments: user.attachments,
        fromQuotaFailover: true,
      });
    } catch (err) {
      const reason = err && err.message ? String(err.message) : String(err);
      store.updateThread(
        threadId,
        {
          status: "failed",
          quotaFailoverPending: false,
          lastError: shortError(`Quota failover: resume failed: ${reason}`),
        },
        { touch: true },
      );
      appendMessage(
        threadId,
        "event",
        `Quota failover: resume failed: ${reason}`,
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
    }
  }

  function scheduleQuotaWake(threadId, until) {
    cancelQuotaWake(threadId);
    const delay = Math.max(1000, Number(until) + 2000 - Date.now());
    const cap = Math.min(delay, 2147483647);
    const timer = setTimeout(() => {
      quotaTimers.delete(threadId);
      void fireQuotaWake(threadId);
    }, cap);
    if (typeof timer.unref === "function") timer.unref();
    quotaTimers.set(threadId, timer);
  }

  async function fireQuotaWake(threadId) {
    const thread = store.getThread(threadId);
    if (!thread || thread.status !== "quota-wait") return;
    if (!quotaWaitEnabled(thread, store.getSettings())) return;
    if (active.has(threadId)) return;
    const user = lastUserOnThread(threadId);
    if (!user || !String(user.text || "").trim()) {
      store.updateThread(
        threadId,
        {
          status: "failed",
          quotaWaitUntil: null,
          lastError: shortError("Quota wait: nothing to resume"),
        },
        { touch: true },
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
      return;
    }
    try {
      await ctx.startRun({
        threadId,
        prompt: user.text,
        attachments: user.attachments,
        fromQuotaWait: true,
      });
    } catch (err) {
      const reason = err && err.message ? String(err.message) : String(err);
      store.updateThread(
        threadId,
        {
          status: "failed",
          quotaWaitUntil: null,
          quotaWaitResumed: true,
          lastError: shortError(`Quota wait: resume failed: ${reason}`),
        },
        { touch: true },
      );
      appendMessage(
        threadId,
        "event",
        `Quota wait: resume failed: ${reason}`,
      );
      store.save();
      pushDetail(threadId);
      pushThreadsChanged();
    }
  }

  /**
   * Resume a parked quota-wait now (banner / IPC). Counts as the one-shot.
   * @param {{ threadId: string }} input
   */
  async function resumeQuotaWait(input) {
    const threadId = input && input.threadId;
    const thread = store.getThread(threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    if (thread.status !== "quota-wait") {
      throw new Error("Thread is not waiting on a provider quota reset");
    }
    cancelQuotaWake(threadId);
    if (active.has(threadId)) {
      throw new Error("A run is already active on this thread");
    }
    const user = lastUserOnThread(threadId);
    if (!user || !String(user.text || "").trim()) {
      throw new Error("Quota wait: nothing to resume");
    }
    return ctx.startRun({
      threadId,
      prompt: user.text,
      attachments: user.attachments,
      fromQuotaWait: true,
    });
  }

  function refreshQuotaWait(threadId) {
    const thread = store.getThread(threadId);
    if (
      !thread ||
      services.isTrashed(thread) ||
      thread.status !== "quota-wait" ||
      !thread.quotaWaitUntil
    ) {
      cancelQuotaWake(threadId);
      return;
    }
    if (!quotaWaitEnabled(thread, store.getSettings())) {
      cancelQuotaWake(threadId);
      return;
    }
    scheduleQuotaWake(threadId, thread.quotaWaitUntil);
  }

  function refreshAllQuotaWaits() {
    for (const t of store.getThreads()) {
      if (t.status === "quota-wait") refreshQuotaWait(t.id);
    }
  }

  return {
    cancelQuotaWake,
    tryQuotaFailover,
    scheduleQuotaWake,
    resumeQuotaWait,
    refreshQuotaWait,
    refreshAllQuotaWaits,
    cancelAll() {
      for (const id of [...quotaTimers.keys()]) {
        cancelQuotaWake(id);
      }
    },
  };
}

module.exports = { createQuotaWait };
