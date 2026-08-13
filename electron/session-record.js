"use strict";

const { createMemoryProxy } = require("./memory-proxy.js");
const { getMemoryStatus } = require("./memory-sup.js");

const BATCH_SIZE = 10;
const FLUSH_MS = 2000;

/**
 * Map Solenta message role to session API role.
 * @param {string} role
 * @returns {"user" | "assistant" | "tool" | "system" | null}
 */
function mapMessageRole(role) {
  const r = String(role || "");
  if (r === "user") return "user";
  if (r === "assistant") return "assistant";
  if (r === "tool") return "tool";
  if (r === "event") return "system";
  return null;
}

/**
 * Normalize one transcript entry for POST /api/session.
 * @param {object} raw
 * @returns {object | null}
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role;
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool" &&
    role !== "system"
  ) {
    return null;
  }
  const content = raw.content == null ? "" : String(raw.content);
  if (!content) return null;
  const sessionId =
    raw.sessionId != null && String(raw.sessionId) !== ""
      ? String(raw.sessionId)
      : null;
  if (!sessionId) return null;

  /** @type {Record<string, unknown>} */
  const entry = {
    sessionId,
    role,
    content,
  };
  if (raw.project !== undefined) {
    entry.project =
      raw.project == null || raw.project === ""
        ? null
        : String(raw.project);
  }
  if (raw.threadTitle !== undefined) {
    entry.threadTitle =
      raw.threadTitle == null ? null : String(raw.threadTitle);
  }
  if (raw.agent !== undefined) {
    entry.agent = raw.agent == null || raw.agent === "" ? null : String(raw.agent);
  }
  return entry;
}

/**
 * Fire-and-forget session transcript recorder with in-process batching.
 * Batches up to `batchSize` entries or `flushMs` (whichever first).
 * Silent no-op when memory is down; never throws into callers.
 *
 * @param {object} [opts]
 * @param {string} [opts.userDataPath]
 * @param {() => { running: boolean, adopted: boolean, port: number | null }} [opts.getStatus]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.flushMs]
 * @param {number} [opts.batchSize]
 * @param {{ session: (input: object) => Promise<unknown> }} [opts.proxy]
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 */
function createSessionRecorder(opts = {}) {
  const userDataPath = opts.userDataPath || "";
  const getStatus = opts.getStatus || getMemoryStatus;
  const timeoutMs = opts.timeoutMs;
  const flushMsRaw = opts.flushMs != null ? Number(opts.flushMs) : FLUSH_MS;
  const flushMs =
    Number.isFinite(flushMsRaw) && flushMsRaw >= 0 ? flushMsRaw : FLUSH_MS;
  const batchSizeRaw =
    opts.batchSize != null ? Number(opts.batchSize) : BATCH_SIZE;
  const batchSize =
    Number.isFinite(batchSizeRaw) && batchSizeRaw >= 1
      ? Math.floor(batchSizeRaw)
      : BATCH_SIZE;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;

  /** @type {object[]} */
  let queue = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  let disposed = false;

  function getProxy() {
    if (opts.proxy) return opts.proxy;
    if (!userDataPath) return null;
    return createMemoryProxy({
      userDataPath,
      getStatus,
      timeoutMs: timeoutMs != null ? timeoutMs : 5000,
    });
  }

  function clearTimer() {
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function scheduleTimer() {
    if (disposed || timer != null || queue.length === 0 || inFlight) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void pump();
    }, flushMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  /**
   * Post one batch of entries. Never throws.
   * @param {object[]} batch
   */
  async function postBatch(batch) {
    if (!batch.length) return;
    const proxy = getProxy();
    if (!proxy) return;
    for (const entry of batch) {
      if (disposed) return;
      try {
        await proxy.session(entry);
      } catch {
        // Memory down / network / non-2xx: drop this entry.
      }
    }
  }

  /**
   * Pump the queue: send up to one batchSize, then re-arm.
   * Only one pump runs at a time. Never throws.
   * @returns {Promise<void>}
   */
  function pump() {
    if (inFlight) return inFlight;
    if (disposed || queue.length === 0) return Promise.resolve();

    inFlight = (async () => {
      try {
        clearTimer();
        const batch = queue.splice(0, batchSize);
        await postBatch(batch);
      } catch {
        // silent
      } finally {
        inFlight = null;
        if (disposed) return;
        if (queue.length >= batchSize) {
          // Full batch waiting: pump again without the timer.
          void pump();
        } else if (queue.length > 0) {
          scheduleTimer();
        }
      }
    })();
    return inFlight;
  }

  /**
   * Enqueue transcript entries for batched POST /api/session.
   * Fire-and-forget; never throws.
   * @param {object | object[]} entries
   */
  function recordTranscript(entries) {
    try {
      if (disposed) return;
      const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
      for (const raw of list) {
        const entry = normalizeEntry(raw);
        if (entry) queue.push(entry);
      }
      if (queue.length === 0) return;
      if (queue.length >= batchSize) {
        clearTimer();
        void pump();
      } else {
        scheduleTimer();
      }
    } catch {
      // never throw into callers
    }
  }

  /**
   * Flush all pending entries (app-quit / stopAll path). Never throws.
   * @returns {Promise<void>}
   */
  async function flush() {
    try {
      clearTimer();
      // Snapshot everything currently queued plus wait for any in-flight pump,
      // then post any remainder. Bounded: no open-ended while with re-entry races.
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // ignore
        }
      }
      clearTimer();
      const pending = queue.splice(0, queue.length);
      await postBatch(pending);
      // In case pump's finally re-queued a timer after we snapshotted, clear it.
      clearTimer();
    } catch {
      // silent
    }
  }

  function dispose() {
    disposed = true;
    clearTimer();
    queue = [];
  }

  return {
    recordTranscript,
    flush,
    dispose,
    /** @internal */
    get pendingCount() {
      return queue.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton used by the runner / app-quit path.
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof createSessionRecorder> | null} */
let defaultRecorder = null;

/**
 * Configure (or reconfigure) the process-wide session recorder.
 * @param {Parameters<typeof createSessionRecorder>[0]} opts
 */
function configureSessionRecord(opts) {
  if (defaultRecorder) {
    try {
      defaultRecorder.dispose();
    } catch {
      // ignore
    }
  }
  defaultRecorder = createSessionRecorder(opts || {});
  return defaultRecorder;
}

function ensureDefaultRecorder() {
  if (!defaultRecorder) {
    defaultRecorder = createSessionRecorder({});
  }
  return defaultRecorder;
}

/**
 * Fire-and-forget enqueue on the process-wide recorder. Never throws.
 * @param {object | object[]} entries
 */
function recordTranscript(entries) {
  try {
    ensureDefaultRecorder().recordTranscript(entries);
  } catch {
    // silent
  }
}

/**
 * Flush the process-wide queue. Never throws.
 * @returns {Promise<void>}
 */
async function flushSessionRecord() {
  try {
    if (!defaultRecorder) return;
    await defaultRecorder.flush();
  } catch {
    // silent
  }
}

/**
 * Reset singleton state (tests only).
 */
function resetSessionRecordForTests() {
  if (defaultRecorder) {
    try {
      defaultRecorder.dispose();
    } catch {
      // ignore
    }
  }
  defaultRecorder = null;
}

module.exports = {
  createSessionRecorder,
  configureSessionRecord,
  recordTranscript,
  flushSessionRecord,
  resetSessionRecordForTests,
  mapMessageRole,
  normalizeEntry,
  BATCH_SIZE,
  FLUSH_MS,
};
