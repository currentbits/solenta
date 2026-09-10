"use strict";

const { createMemoryProxy } = require("./memory-proxy.js");
const { getMemoryStatus } = require("./memory-sup.js");

const BATCH_SIZE = 10;
const FLUSH_MS = 2000;
/** Pending export entries, including the in-flight batch. Independent of Store. */
const MAX_PENDING_ENTRIES = 256;
/** Pending export payload estimate, including the in-flight batch. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * Cheap retained-size estimate (JS string length, not UTF-8). Used only to
 * bound this optional mirror; Store history is unaffected.
 * @param {object} entry
 * @returns {number}
 */
function estimateEntryBytes(entry) {
  if (!entry || typeof entry !== "object") return 0;
  let n = 48;
  if (typeof entry.content === "string") n += entry.content.length;
  if (typeof entry.sessionId === "string") n += entry.sessionId.length;
  if (typeof entry.project === "string") n += entry.project.length;
  if (typeof entry.threadTitle === "string") n += entry.threadTitle.length;
  if (typeof entry.agent === "string") n += entry.agent.length;
  if (typeof entry.role === "string") n += entry.role.length;
  return n;
}

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
 * @param {number} [opts.maxPendingEntries]
 * @param {number} [opts.maxPendingBytes]
 * @param {{ session: (input: object) => Promise<unknown> }} [opts.proxy]
 * @param {(msg: string) => void} [opts.log]
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
  const maxPendingEntriesRaw =
    opts.maxPendingEntries != null
      ? Number(opts.maxPendingEntries)
      : MAX_PENDING_ENTRIES;
  const maxPendingEntries =
    Number.isFinite(maxPendingEntriesRaw) && maxPendingEntriesRaw >= 1
      ? Math.floor(maxPendingEntriesRaw)
      : MAX_PENDING_ENTRIES;
  const maxPendingBytesRaw =
    opts.maxPendingBytes != null
      ? Number(opts.maxPendingBytes)
      : MAX_PENDING_BYTES;
  const maxPendingBytes =
    Number.isFinite(maxPendingBytesRaw) && maxPendingBytesRaw >= 1
      ? Math.floor(maxPendingBytesRaw)
      : MAX_PENDING_BYTES;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const log = opts.log || ((msg) => console.warn(msg));

  /** @type {{ entry: object, bytes: number }[]} */
  let queue = [];
  /** Batches currently owned by postBatch / flush (including in-flight). */
  /** @type {Set<{ entry: object, bytes: number }[]>} */
  const liveBatches = new Set();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  let disposed = false;
  let flushing = false;
  let heldBytes = 0;
  let heldCount = 0;
  let droppedCount = 0;

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
    if (disposed || flushing || timer != null || queue.length === 0 || inFlight) {
      return;
    }
    timer = setTimeoutFn(() => {
      timer = null;
      void pump();
    }, flushMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  function noteDrop() {
    droppedCount += 1;
    if (droppedCount === 1 || droppedCount % 100 === 0) {
      try {
        log(
          `session-record: dropped ${droppedCount} transcript export ${
            droppedCount === 1 ? "entry" : "entries"
          } (pending=${heldCount} bytes=${heldBytes})`,
        );
      } catch {
        // never throw into callers
      }
    }
  }

  /**
   * Drop our references to a held batch and, unless dispose already zeroed
   * the counters, release its accounting.
   * @param {{ entry: object, bytes: number }[] | null | undefined} batch
   */
  function releaseBatch(batch) {
    if (!batch) return;
    const tracked = liveBatches.has(batch);
    liveBatches.delete(batch);
    let bytes = 0;
    let count = 0;
    for (const item of batch) {
      if (!item) continue;
      bytes += item.bytes || 0;
      count += 1;
      item.entry = null;
    }
    batch.length = 0;
    if (!disposed && tracked) {
      heldBytes = Math.max(0, heldBytes - bytes);
      heldCount = Math.max(0, heldCount - count);
    }
  }

  /**
   * Admit one normalized entry or drop it. Never retains an oversize copy.
   * @param {object} entry
   * @returns {boolean}
   */
  function admit(entry) {
    const bytes = estimateEntryBytes(entry);
    if (
      bytes > maxPendingBytes ||
      heldCount >= maxPendingEntries ||
      heldBytes + bytes > maxPendingBytes
    ) {
      noteDrop();
      return false;
    }
    queue.push({ entry, bytes });
    heldBytes += bytes;
    heldCount += 1;
    return true;
  }

  /**
   * Post one batch of entries. Never throws. Releases remaining refs on
   * dispose so a slow await cannot keep the rest of the batch alive.
   * @param {{ entry: object, bytes: number }[]} batch
   */
  async function postBatch(batch) {
    if (!batch.length) return;
    const proxy = getProxy();
    if (!proxy) return;
    for (let i = 0; i < batch.length; i++) {
      if (disposed) return;
      const item = batch[i];
      const entry = item && item.entry;
      if (!entry) continue;
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
    if (disposed || flushing || queue.length === 0) return Promise.resolve();

    inFlight = (async () => {
      /** @type {{ entry: object, bytes: number }[] | null} */
      let batch = null;
      try {
        clearTimer();
        batch = queue.splice(0, batchSize);
        liveBatches.add(batch);
        await postBatch(batch);
      } catch {
        // silent
      } finally {
        releaseBatch(batch);
        inFlight = null;
        if (disposed || flushing) return;
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
   * Fire-and-forget; never throws. Overflow drops the mirror copy only.
   * @param {object | object[]} entries
   */
  function recordTranscript(entries) {
    try {
      if (disposed) return;
      const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
      for (const raw of list) {
        const entry = normalizeEntry(raw);
        if (entry) admit(entry);
      }
      if (queue.length === 0) return;
      if (flushing) return;
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
    flushing = true;
    try {
      clearTimer();
      // Wait for the current pump (if any) without letting it start another,
      // then post the remainder. Bounded: no open-ended while with re-entry races.
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // ignore
        }
      }
      clearTimer();
      const pending = queue.splice(0, queue.length);
      liveBatches.add(pending);
      try {
        await postBatch(pending);
      } finally {
        releaseBatch(pending);
      }
      clearTimer();
    } catch {
      // silent
    } finally {
      flushing = false;
      if (!disposed && queue.length > 0) {
        if (queue.length >= batchSize) void pump();
        else scheduleTimer();
      }
    }
  }

  function dispose() {
    disposed = true;
    clearTimer();
    for (const item of queue) {
      if (item) item.entry = null;
    }
    queue = [];
    for (const batch of liveBatches) {
      for (const item of batch) {
        if (item) item.entry = null;
      }
      batch.length = 0;
    }
    liveBatches.clear();
    heldBytes = 0;
    heldCount = 0;
  }

  return {
    recordTranscript,
    flush,
    dispose,
    /** @internal Queue + in-flight. */
    get pendingCount() {
      return heldCount;
    },
    /** @internal */
    get pendingBytes() {
      return heldBytes;
    },
    /** @internal Overflow drops only; never message content. */
    get droppedCount() {
      return droppedCount;
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
  estimateEntryBytes,
  BATCH_SIZE,
  FLUSH_MS,
  MAX_PENDING_ENTRIES,
  MAX_PENDING_BYTES,
};
