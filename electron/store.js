"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getDefaultSecrets } = require("./secrets.js");
const threadSecrets = require("./threadSecrets.js");
const {
  splitMessagesByThread,
  stringifyStore,
  indexMessagesObject,
  findThreadValue,
  peekLastAssistantValue,
  appendJsonArrayItem,
} = require("./jsonEnvelope.js");
const {
  normalizeMcpServers,
  validateMcpServers,
  RESERVED_MCP_NAMES,
} = require("./mcp.js");
const {
  SPEND_RETENTION_DAYS,
  capList,
  localDayKey,
  pruneSpendByDay,
  normalizeRunArtifactsByThread,
  normalizeSpendByDay,
  emptyUsageCell,
  coerceUsageCell,
  normalizeUsageByDay,
  normalizeUsageThreadsByDay,
  encodeThreadFileId,
  decodeThreadFileId,
  isSafeThreadId,
} = require("./store-util.js");
const {
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  normalizeSettings,
} = require("./store-normalize.js");
const {
  STANDARD_TEMPLATE,
  cloneStandardTemplate,
  ensureWorkflowTemplates,
  migrateTemplateKimiModels,
  migrateAutomation,
  DEFAULT_WORKTREE_RETENTION,
  migrateProject,
  backfillFromNotice,
  migrateThread,
} = require("./store-migrate.js");
const StoreUsageMethods = require("./store-usage-methods.js");
const StoreSettingsMethods = require("./store-settings-methods.js");
const StoreSearchMethods = require("./store-search-methods.js");
const StoreTemplateMethods = require("./store-templates-methods.js");

const EMPTY = {
  projects: [],
  spaces: [],
  threads: [],
  messagesByThread: {},
  workLogByThread: {},
  usageByThread: {},
  runArtifactsByThread: {},
  rewindRestoreByThread: {},
  workflowRunByThread: {},
  workflowTemplates: [],
  spendByDay: {},
  usageByDay: {},
  usageThreadsByDay: {},
  automations: [],
  tasksByCrew: {},
  digestSeenAt: null,
  // autoSettleAfterDays defaults to 3 (AUTO_SETTLE_AFTER_DAYS); null = disabled.
  settings: {
    dailyBudgetUsd: null,
    orchestrationBudgetUsd: null,
    autoSettleAfterDays: 3,
    mcpServers: [],
    agentProfiles: [],
    subagentPool: { defaultAlias: null, force: false, entries: [] },
  },
};

// Longest a save() may sit in memory before it hits disk.
// #225: per-thread shards make a flush cheap (one transcript, not the whole
// store), so the #124/#225-interim backoff cap is gone — flat 250ms.
const SAVE_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MAX_MS = SAVE_DEBOUNCE_MS;

/**
 * Minimum gap between two debounced (save()) writes of coder-store.json
 * (#1475); saveNow() is not throttled and does not start a window.
 * The envelope is ~6 MB on a real store and costs ~18 ms of synchronous
 * stringify per write; a stream calls save() several times a second, so
 * rewriting it on every 250 ms flush was ~19 MiB/s of disk writes. Shards
 * keep the 250 ms debounce; the envelope is written at most once per window.
 * Durability trade-off: a crash (not a quit — saveNow() still writes at
 * once) loses at most the last ENVELOPE_THROTTLE_MS of envelope changes
 * (thread rows, usage, settings). Transcripts and work logs are unaffected.
 */
const ENVELOPE_THROTTLE_MS = 2000;

/**
 * Most parsed transcripts kept in memory (#1475). A large thread costs
 * 3–5 MB of heap once hydrated, and browsing used to keep every one for the
 * session. Past this count the least recently read clean, non-running
 * thread drops back to its shard and is re-parsed on the next read.
 */
const MAX_HYDRATED_THREADS = 8;
/**
 * Byte budget for the same LRU, in shard JSON chars (parsed heap runs
 * ~1.3× that). Eight 3–4 MB real threads held ~32 MB of heap under the
 * count cap alone. Soft: dirty, working and in-flight threads stay, and the
 * most recent read always stays so one huge thread is not re-parsed per read.
 */
const MAX_HYDRATED_BYTES = 16 * 1024 * 1024;

/** Per-thread transcript files live next to coder-store.json (#225). */
const MESSAGES_DIR = "messages";
/** Per-thread work-log files live next to coder-store.json (#1204). */
const WORKLOGS_DIR = "worklogs";
/**
 * Side files next to coder-store.json (#1475). threads[].hypotheses and
 * threads[].suggestions (~2.2 MB on a real store) and usageThreadsByDay
 * (~0.8 MB) used to ride in every envelope write; they change only on
 * hypothesis_record / work_suggest / usage, so they get their own files
 * written only when they changed. In memory nothing moves: the arrays stay
 * on the thread rows and data.usageThreadsByDay stays put.
 */
const THREAD_NOTES_FILE = "thread-notes.json";
const USAGE_THREADS_FILE = "usage-threads.json";
const NOTE_FIELDS = ["hypotheses", "suggestions"];

/**
 * @param {object} t
 * @returns {boolean}
 */
function hasInlineNotes(t) {
  return (
    !!t &&
    NOTE_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(t, f))
  );
}

/**
 * @param {object} t
 * @returns {object} the row without hypotheses/suggestions
 */
function stripNotes(t) {
  if (!hasInlineNotes(t)) return t;
  const { hypotheses: _h, suggestions: _s, ...rest } = t;
  return rest;
}

/**
 * Side-file entries plus entries an older build appended inline after a
 * downgrade (#1475). Same id: the inline (newer) copy wins.
 * @param {unknown[]} side
 * @param {unknown} inline
 * @returns {unknown[]}
 */
function mergeNotesById(side, inline) {
  if (!Array.isArray(inline)) return side;
  const ids = new Set(inline.map((e) => e && e.id));
  return [...side.filter((e) => !e || e.id == null || !ids.has(e.id)), ...inline];
}

/**
 * @param {Map<string, object>} a
 * @param {Map<string, object>} b
 * @returns {boolean}
 */
function sameNoteRefs(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, r] of a) {
    const o = b.get(id);
    if (!o || o.hypotheses !== r.hypotheses || o.suggestions !== r.suggestions) {
      return false;
    }
  }
  return true;
}

/**
 * Per-thread transcript retention (issue #89). Caps still bound RAM and the
 * per-shard file; they cannot bound total disk across thread count (#225).
 * Appends may overshoot the cap by the slack; crossing cap + slack drops the
 * oldest entries back to the cap. The slack keeps the drop (which shifts every
 * index, invalidates the runner's prefix diff and forces one full transcript
 * push) amortized over ~slack appends instead of every append.
 */
const MAX_MESSAGES_PER_THREAD = 1000;
const MESSAGE_OVERFLOW_SLACK = 100;
const MAX_WORKLOG_ITEMS_PER_THREAD = 500;
const WORKLOG_OVERFLOW_SLACK = 50;

/**
 * A crashed orchestrated workflow view still has running/pending agents.
 * Mark them failed + __interrupted so Retry reruns the whole interrupted
 * phase and reuses settled phase outputs (#182).
 * @param {object | undefined} view
 * @returns {boolean} true if any agent was interrupted
 */
function healInterruptedWorkflow(view) {
  if (!view || !Array.isArray(view.phases)) return false;
  let healed = false;
  for (const phase of view.phases) {
    for (const agent of (phase && phase.agents) || []) {
      if (agent && (agent.status === "running" || agent.status === "pending")) {
        agent.status = "failed";
        agent.__interrupted = true;
        healed = true;
      }
    }
  }
  return healed;
}

/**
 * CRASH / force-quit path only: threads still "working" on disk when the
 * process loads mean the previous process died mid-run (clean quits mark idle
 * via runner.stopAll first). A crash IS a failure of the run — stamp failed.
 * Status change is real activity, so updatedAt is bumped.
 *
 * The crash event is spliced onto the lazy JSON range so a force-quit with
 * N in-flight runs does not JSON.parse those N transcripts at boot (#643).
 *
 * @param {Store} store
 * @param {object} data
 * @returns {boolean} true if any thread was recovered
 */
function recoverInterruptedRuns(store, data) {
  let recovered = false;
  for (const t of data.threads) {
    if (t.status !== "working") continue;
    const resumable = healInterruptedWorkflow(
      data.workflowRunByThread && data.workflowRunByThread[t.id],
    );
    t.status = "failed";
    t.runStartedAt = null;
    t.lastError = "Run error: app quit while the run was in flight";
    t.lastErrorKind = null;
    t.updatedAt = Date.now();
    // Opt-in resume after restart (issue #1512 I3) keys off this stamp.
    t.interruptedAt = Date.now();
    store._appendLazyMessage(t.id, {
      id: randomUUID(),
      role: "event",
      text: resumable
        ? "Run interrupted: the app crashed or was force-quit mid-run. Retry a failed workflow agent to resume; finished phases are kept."
        : "Run interrupted: the app crashed or was force-quit mid-run",
      createdAt: Date.now(),
    });
    // Fail-closed work-log: a mid-retry (or any other) beginWorkLogStep
    // can stay done:false forever if the process dies before
    // completeWorkLogStep. Mutate data.workLogByThread in place —
    // store.data is not assigned yet during _readFile (#824 / #182).
    // Nested item.done writes do not trip the work-log proxy, so mark
    // the thread dirty or the healed rows never reach worklogs/<id>.json.
    const items =
      data.workLogByThread && data.workLogByThread[t.id];
    if (Array.isArray(items)) {
      let closed = false;
      for (const item of items) {
        if (item && item.done === false) {
          item.done = true;
          closed = true;
        }
      }
      if (closed) store._markWorkLogDirty(t.id);
    }
    recovered = true;
  }
  return recovered;
}

/**
 * Write `contents` to `filePath` via tmp + fsync + rename. `seq` must be
 * unique among concurrent writes to the same path (Date.now collides when
 * a flush writes N shards in one turn).
 * @param {string} filePath
 * @param {string} contents
 * @param {number} seq
 */
function writeAtomicSync(filePath, contents, seq) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${seq}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  try {
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fsync is best-effort; still rename so the write is not lost.
  }
  fs.renameSync(tmp, filePath);
}

/**
 * JSON persistence for Solenta main-process state.
 * Constructor takes a file path; load on start; tolerate missing/corrupt.
 * An unreadable main file is renamed to *.corrupt-<ts> (never discarded)
 * and a sibling *.bak (last good snapshot from a prior successful load)
 * is tried before falling back to empty. Transcripts live in
 * messages/<threadId>.json and work logs in worklogs/<threadId>.json.
 * A flush writes only dirty shards; the envelope at most once per
 * ENVELOPE_THROTTLE_MS. Atomic save:
 * write tmp, fsync, then rename. Debounced flushes (save()) write off the
 * event loop; saveNow() is the synchronous exit/shutdown/test path.
 */
class Store {
  /**
   * @param {string} filePath
   * @param {{ secrets?: import("./secrets.js").Secrets }} [opts]
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this._secrets = (opts && opts.secrets) || getDefaultSecrets();
    this._secretsMigrated = 0;
    this._dirty = false;
    // Envelope (coder-store.json) needs a write. Shard dirtiness lives in the
    // _dirty*Ids sets; _dirty means "anything pending" (drives the exit hook).
    this._envelopeDirty = false;
    this._lastEnvelopeWriteAt = 0;
    this._timer = null;
    this._timerDue = 0;
    this._flushing = false;
    this._flushPromise = null;
    this._flushDelayMs = SAVE_DEBOUNCE_MS;
    // Bumped by saveNow() so an in-flight async flush knows its payload is stale.
    this._writeGen = 0;
    this._exitHookArmed = false;
    this._flushOnExit = () => {
      if (this._dirty) this.saveNow();
    };
    // Not persisted — last-assistant lookup for threads:summaries (#136).
    this._lastAssistantByThread = new Map();
    // Rolling .bak is off the constructor's sync path (#618). Tests may await it.
    // After the split this copy is envelope-only; transcripts live in messages/
    // and are not cloned into .bak. A still-inline legacy blob is copied to
    // .bak synchronously before the first migration write.
    this._bakCopy = Promise.resolve();
    // #639/#225: transcripts stay unparsed until a thread is opened.
    // Hydrated arrays live on _messagesHydrated; unparsed JSON strings on
    // _messagesRaw; still-lazy blob slices on _messagesLazy (legacy envelope
    // only, dropped after the shard split).
    this._messagesHydrated = {};
    // Read order of hydrated ids, oldest first (LRU for _evictHydrated),
    // mapped to the transcript's JSON length when last parsed or flushed.
    this._hydratedReads = new Map();
    this._messagesLazy = null;
    this._messagesRaw = new Map();
    this._messageShards = new Set();
    this._dirtyMessageIds = new Set();
    this._deletedMessageIds = new Set();
    this._inflightShardIds = null;
    this._inflightDeletedIds = null;
    this._workLogShards = new Set();
    this._dirtyWorkLogIds = new Set();
    this._deletedWorkLogIds = new Set();
    this._inflightWorkLogIds = null;
    this._inflightDeletedWorkLogIds = null;
    this._inlineWorkLogIds = new Set();
    this._workLogsSplit = true;
    // false while hypotheses/suggestions/usageThreadsByDay must stay inline
    // in the envelope (the side-file split failed this load).
    this._sideSplit = true;
    // What the side files on disk hold: note array identities per thread,
    // and the usageThreadsByDay object + mutation count (_usageThreadsGen).
    this._notesWritten = new Map();
    this._usageThreadsGen = 0;
    this._usageThreadsWritten = { ref: null, gen: 0 };
    // Side files that parsed this load; only these are cloned to .bak.
    this._sideLoaded = new Set();
    this._sideFromBak = new Set();
    this._atomicSeq = 0;
    this._searchGen = 0;
    this._searchWorker = null;
    this.data = this._load();
    if (this._secretsMigrated > 0) {
      this._secrets.emit(
        `[store] encrypted ${this._secretsMigrated} plaintext credential(s) at rest`,
      );
    }
    if (this.recoverDanglingRewind()) {
      this._recoveredOnLoad = true;
    }
    if (this._recoveredOnLoad) {
      this.save();
    }
  }

  /**
   * Parse a store JSON string: envelope only, with messagesByThread indexed
   * for lazy hydrate. Falls back to a full JSON.parse if the skip-scan fails.
   * @param {string} raw
   * @returns {{ parsed: object, split: ReturnType<typeof splitMessagesByThread> | null }}
   */
  _parseStoreJson(raw) {
    try {
      const split = splitMessagesByThread(raw);
      const parsed = JSON.parse(split.envelopeJson);
      return { parsed, split };
    } catch {
      return { parsed: JSON.parse(raw), split: null };
    }
  }

  /**
   * Point data.messagesByThread at a proxy that hydrates a thread's array
   * on first read so existing `store.data.messagesByThread[id]` call sites
   * keep working without parsing every transcript at boot.
   * @param {object} data
   * @param {{ raw: string, ranges: Map<string, {start:number, end:number}>, lastAssistants?: Map<string, object | null> } | null} split
   */
  _adoptMessages(data, split) {
    const lazy =
      split && split.raw
        ? {
            raw: split.raw,
            ranges: split.ranges || new Map(),
            intact: true,
            indexed: split.indexed === true,
          }
        : null;
    const hydrated =
      data.messagesByThread &&
      typeof data.messagesByThread === "object" &&
      !Array.isArray(data.messagesByThread)
        ? data.messagesByThread
        : {};
    this._messagesHydrated = hydrated;
    this._messagesLazy = lazy;
    this._attachMessagesProxy(data);
    for (const id of Object.keys(this._messagesHydrated)) {
      const list = this._messagesHydrated[id];
      if (Array.isArray(list) && backfillFromNotice(list)) {
        this._markMessagesDirty(id);
        this.markDirty();
      }
    }
  }

  /**
   * Seed the last-assistant memo from the skip-scan so threads:summaries
   * does not hydrate every transcript.
   * @param {object} data
   * @param {Map<string, object | null> | null | undefined} lastAssistants
   */
  _seedLastAssistants(data, lastAssistants) {
    this._lastAssistantByThread.clear();
    if (!lastAssistants || lastAssistants.size === 0) return;
    for (const t of data.threads || []) {
      if (!t || t.id == null) continue;
      this._lastAssistantByThread.set(
        t.id,
        lastAssistants.has(t.id) ? lastAssistants.get(t.id) : null,
      );
    }
  }

  /**
   * @param {object} data
   */
  _attachMessagesProxy(data) {
    const store = this;
    const target = this._messagesHydrated;
    data.messagesByThread = new Proxy(target, {
      get(t, prop, recv) {
        if (typeof prop !== "string") return Reflect.get(t, prop, recv);
        if (prop === "constructor" || prop === "__proto__" || prop === "toJSON") {
          return Reflect.get(t, prop, recv);
        }
        return store._hydrateMessages(prop);
      },
      set(t, prop, value) {
        if (typeof prop !== "string") return Reflect.set(t, prop, value);
        store._lastAssistantByThread.delete(prop);
        store._invalidateLazy(prop);
        store._messagesRaw.delete(prop);
        store._markMessagesDirty(prop);
        t[prop] = value;
        return true;
      },
      deleteProperty(t, prop) {
        if (typeof prop !== "string") return Reflect.deleteProperty(t, prop);
        store._ensureMessagesIndexed();
        delete t[prop];
        store._hydratedReads.delete(prop);
        store._invalidateLazy(prop);
        store._messagesRaw.delete(prop);
        store._markMessagesDeleted(prop);
        store._lastAssistantByThread.delete(prop);
        return true;
      },
      has(t, prop) {
        if (typeof prop !== "string") return prop in t;
        return store._hasLazyThread(prop);
      },
      ownKeys(t) {
        const keys = new Set(Object.keys(t));
        if (store._messagesLazy) {
          for (const k of store._messagesLazy.ranges.keys()) keys.add(k);
        }
        for (const k of store._messagesRaw.keys()) keys.add(k);
        for (const k of store._messageShards) keys.add(k);
        return [...keys];
      },
      getOwnPropertyDescriptor(t, prop) {
        if (typeof prop !== "string") {
          return Reflect.getOwnPropertyDescriptor(t, prop);
        }
        const present = store._hasLazyThread(prop);
        if (!present) return undefined;
        return {
          enumerable: true,
          configurable: true,
          writable: true,
          // Do not hydrate: Object.keys / hasOwnProperty must stay cheap.
          value: Object.prototype.hasOwnProperty.call(t, prop)
            ? t[prop]
            : undefined,
        };
      },
    });
  }

  /**
   * @param {string} threadId
   * @returns {boolean}
   */
  _hasLazyThread(threadId) {
    if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, threadId)) {
      return true;
    }
    if (this._messagesRaw.has(threadId) || this._messageShards.has(threadId)) {
      return true;
    }
    const lazy = this._messagesLazy;
    if (!lazy || !lazy.raw) return false;
    if (lazy.ranges.has(threadId)) return true;
    if (lazy.indexed) return false;
    const r = findThreadValue(lazy.raw, threadId);
    if (!r) return false;
    lazy.ranges.set(threadId, r);
    return true;
  }

  /**
   * Index every thread range from the raw slice. First mutating save only.
   */
  _ensureMessagesIndexed() {
    const lazy = this._messagesLazy;
    if (!lazy || lazy.indexed || !lazy.raw) return;
    const indexed = indexMessagesObject(lazy.raw);
    lazy.ranges = indexed.ranges;
    lazy.indexed = true;
    for (const [id, last] of indexed.lastAssistants) {
      if (!this._lastAssistantByThread.has(id)) {
        this._lastAssistantByThread.set(id, last);
      }
    }
  }

  /**
   * @param {string} [threadId]
   */
  _invalidateLazy(threadId) {
    const lazy = this._messagesLazy;
    if (!lazy) return;
    if (threadId != null) lazy.ranges.delete(threadId);
    lazy.intact = false;
    if (lazy.indexed && lazy.ranges.size === 0) this._messagesLazy = null;
  }

  /**
   * @param {string} threadId
   * @returns {{ start: number, end: number } | null}
   */
  _threadRange(threadId) {
    const lazy = this._messagesLazy;
    if (!lazy || !lazy.raw) return null;
    if (lazy.ranges.has(threadId)) return lazy.ranges.get(threadId);
    const r = findThreadValue(lazy.raw, threadId);
    if (r) lazy.ranges.set(threadId, r);
    return r;
  }

  /**
   * After splicing bytes into lazy.raw, shift cached ranges that start at or
   * after the insertion point. `exceptId` is already updated by
   * appendJsonArrayItem.
   * @param {number} at
   * @param {number} delta
   * @param {string} exceptId
   */
  _shiftLazyRanges(at, delta, exceptId) {
    const lazy = this._messagesLazy;
    if (!lazy || !lazy.ranges || !delta) return;
    for (const [id, r] of lazy.ranges) {
      if (id === exceptId) continue;
      if (r.start >= at) {
        r.start += delta;
        r.end += delta;
      }
    }
  }

  /**
   * @returns {string}
   */
  _messagesDir() {
    return path.join(path.dirname(this.filePath), MESSAGES_DIR);
  }

  /**
   * @returns {string}
   */
  _workLogsDir() {
    return path.join(path.dirname(this.filePath), WORKLOGS_DIR);
  }

  /**
   * @param {string} threadId
   * @returns {string}
   */
  _messagePath(threadId) {
    const fileId = encodeThreadFileId(threadId);
    if (!fileId) {
      throw new Error("invalid thread id for shard path");
    }
    return path.join(this._messagesDir(), `${fileId}.json`);
  }

  /**
   * @param {string} threadId
   * @returns {string}
   */
  _workLogPath(threadId) {
    const fileId = encodeThreadFileId(threadId);
    if (!fileId) {
      throw new Error("invalid thread id for shard path");
    }
    return path.join(this._workLogsDir(), `${fileId}.json`);
  }

  _scanMessageShards() {
    this._messageShards = new Set();
    let names;
    try {
      names = fs.readdirSync(this._messagesDir());
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = decodeThreadFileId(name.slice(0, -".json".length));
      if (id) this._messageShards.add(id);
    }
  }

  _scanWorkLogShards() {
    this._workLogShards = new Set();
    let names;
    try {
      names = fs.readdirSync(this._workLogsDir());
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = decodeThreadFileId(name.slice(0, -".json".length));
      if (id) this._workLogShards.add(id);
    }
  }

  /**
   * @param {string} threadId
   */
  _markMessagesDirty(threadId) {
    if (!isSafeThreadId(threadId)) return;
    this._dirtyMessageIds.add(threadId);
    this._deletedMessageIds.delete(threadId);
    this._messageShards.add(threadId);
  }

  /**
   * @param {string} threadId
   */
  _markMessagesDeleted(threadId) {
    if (!isSafeThreadId(threadId)) return;
    this._deletedMessageIds.add(threadId);
    this._dirtyMessageIds.delete(threadId);
    this._messageShards.delete(threadId);
    this._messagesRaw.delete(threadId);
  }

  /**
   * @param {string} threadId
   */
  _markWorkLogDirty(threadId) {
    if (!isSafeThreadId(threadId)) return;
    this._dirtyWorkLogIds.add(threadId);
    this._deletedWorkLogIds.delete(threadId);
    this._workLogShards.add(threadId);
  }

  /**
   * @param {string} threadId
   */
  _markWorkLogDeleted(threadId) {
    if (!isSafeThreadId(threadId)) return;
    this._deletedWorkLogIds.add(threadId);
    this._dirtyWorkLogIds.delete(threadId);
    this._workLogShards.delete(threadId);
  }

  /**
   * @param {string} threadId
   * @returns {string | null}
   */
  _readShardFile(threadId) {
    if (!this._messageShards.has(threadId) || !isSafeThreadId(threadId)) {
      return null;
    }
    try {
      return fs.readFileSync(this._messagePath(threadId), "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") this._messageShards.delete(threadId);
      return null;
    }
  }

  /**
   * @param {string} threadId
   * @returns {string | null}
   */
  _readMessageRaw(threadId) {
    if (this._messagesRaw.has(threadId)) return this._messagesRaw.get(threadId);
    const raw = this._readShardFile(threadId);
    if (raw == null) return null;
    this._messagesRaw.set(threadId, raw);
    return raw;
  }

  /**
   * Snapshot dirty shards for one flush. Clears the dirty sets by default so
   * later mutations land in a follow-up write. Pass `{ clear: false }` when
   * the caller will drop only the ids that actually landed.
   * @param {{ clear?: boolean }} [opts]
   * @returns {{
   *   writes: Array<{ id: string, json: string, dest: string, kind: "messages" | "worklogs" }>,
   *   deleted: Array<{ id: string, dest: string, kind: "messages" | "worklogs" }>,
   * }}
   */
  _snapshotDirtyShards(opts = {}) {
    const writes = [];
    for (const id of this._dirtyMessageIds) {
      if (this._deletedMessageIds.has(id) || !isSafeThreadId(id)) continue;
      let json = null;
      if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, id)) {
        json = JSON.stringify(this._messagesHydrated[id] || []);
        // Refresh the LRU size estimate in place (Map.set keeps the order).
        if (this._hydratedReads.has(id)) this._hydratedReads.set(id, json.length);
      } else if (this._messagesRaw.has(id)) {
        json = this._messagesRaw.get(id);
      } else {
        const r = this._threadRange(id);
        if (r && this._messagesLazy) {
          json = this._messagesLazy.raw.slice(r.start, r.end);
        }
      }
      if (json != null) {
        writes.push({
          id,
          json,
          dest: this._messagePath(id),
          kind: "messages",
        });
      }
    }
    const workLogs =
      this.data &&
      this.data.workLogByThread &&
      typeof this.data.workLogByThread === "object"
        ? this.data.workLogByThread
        : null;
    for (const id of this._dirtyWorkLogIds) {
      if (this._deletedWorkLogIds.has(id) || !isSafeThreadId(id)) continue;
      const items = workLogs ? workLogs[id] : undefined;
      writes.push({
        id,
        json: JSON.stringify(Array.isArray(items) ? items : []),
        dest: this._workLogPath(id),
        kind: "worklogs",
      });
    }
    const deleted = [];
    for (const id of this._deletedMessageIds) {
      if (!isSafeThreadId(id)) continue;
      deleted.push({
        id,
        dest: this._messagePath(id),
        kind: "messages",
      });
    }
    for (const id of this._deletedWorkLogIds) {
      if (!isSafeThreadId(id)) continue;
      deleted.push({
        id,
        dest: this._workLogPath(id),
        kind: "worklogs",
      });
    }
    if (opts.clear !== false) {
      this._dirtyMessageIds.clear();
      this._deletedMessageIds.clear();
      this._dirtyWorkLogIds.clear();
      this._deletedWorkLogIds.clear();
    }
    return { writes, deleted };
  }

  /**
   * Last-good copy of a still-inline legacy envelope, taken before the first
   * migration write. Copies the file actually being migrated (main or `.bak`).
   * Envelope-only rolling backups stay on the async path.
   * @param {string} sourcePath
   * @returns {boolean}
   */
  _copyLegacyEnvelopeBak(sourcePath) {
    const bakPath = `${this.filePath}.bak`;
    const src = sourcePath || this.filePath;
    try {
      if (!fs.existsSync(src)) return false;
      if (path.resolve(src) === path.resolve(bakPath)) return true;
      fs.copyFileSync(src, bakPath, fs.constants.COPYFILE_FICLONE);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Split inline messagesByThread onto messages/<id>.json. Existing shard
   * files win unless that id was mutated this load (crash-recovery splice).
   * Safe to run twice. Fail closed: the envelope is stripped only after
   * every legacy key was written or already had a winning shard. Unencodable
   * keys and I/O errors leave the inline blob in place for retry.
   * @param {object} data
   * @param {string} [sourcePath] file that was parsed (main or `.bak`)
   * @returns {boolean} true if every inline transcript was safely handled
   */
  _migrateInlineMessages(data, sourcePath) {
    const lazy = this._messagesLazy;
    const ids = new Set();
    for (const id of Object.keys(this._messagesHydrated)) ids.add(id);
    if (lazy && lazy.raw) {
      if (!lazy.indexed) {
        try {
          const indexed = indexMessagesObject(lazy.raw, {
            peekAssistants: false,
          });
          lazy.ranges = indexed.ranges;
          lazy.indexed = true;
        } catch {
          return false;
        }
      }
      for (const id of lazy.ranges.keys()) ids.add(id);
    }
    if (ids.size === 0) return false;

    const writable = [...ids].filter((id) => isSafeThreadId(id));
    if (writable.length > 0 && !this._copyLegacyEnvelopeBak(sourcePath)) {
      return false;
    }

    let complete = writable.length === ids.size;
    for (const id of writable) {
      try {
        const dest = this._messagePath(id);
        const dirty = this._dirtyMessageIds.has(id);
        if (fs.existsSync(dest) && !dirty) {
          this._messageShards.add(id);
          delete this._messagesHydrated[id];
          this._messagesRaw.delete(id);
          continue;
        }
        let json = null;
        if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, id)) {
          json = JSON.stringify(this._messagesHydrated[id] || []);
        } else if (this._messagesRaw.has(id)) {
          json = this._messagesRaw.get(id);
        } else if (lazy && lazy.raw) {
          const r = lazy.ranges.get(id);
          if (r) json = lazy.raw.slice(r.start, r.end);
        }
        if (json == null) {
          complete = false;
          continue;
        }
        writeAtomicSync(dest, json, ++this._atomicSeq);
        this._messageShards.add(id);
        delete this._messagesHydrated[id];
        this._messagesRaw.delete(id);
        this._dirtyMessageIds.delete(id);
      } catch {
        complete = false;
      }
    }
    if (!complete) return false;
    // Drop the blob so a later flush cannot put 180MB back in the envelope.
    this._messagesLazy = null;
    this._attachMessagesProxy(data);
    return true;
  }

  /**
   * @param {string} threadId
   * @returns {string | null}
   */
  _readWorkLogFile(threadId) {
    if (!this._workLogShards.has(threadId) || !isSafeThreadId(threadId)) {
      return null;
    }
    try {
      return fs.readFileSync(this._workLogPath(threadId), "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") this._workLogShards.delete(threadId);
      return null;
    }
  }

  /**
   * Index worklogs/<id>.json without reading them (#1475): the proxy parses
   * a shard on first access. Existing shards win against a leftover inline
   * copy (interrupted migrate). Once read, arrays stay in memory — a
   * 500-row cap is small compared to transcripts.
   * @param {object} data
   */
  _adoptWorkLogs(data) {
    const map =
      data.workLogByThread &&
      typeof data.workLogByThread === "object" &&
      !Array.isArray(data.workLogByThread)
        ? data.workLogByThread
        : {};
    this._inlineWorkLogIds = new Set(Object.keys(map));
    this._scanWorkLogShards();
    for (const id of this._workLogShards) delete map[id];
    data.workLogByThread = map;
    this._attachWorkLogProxy(data);
    this._workLogsSplit = this._inlineWorkLogIds.size === 0;
  }

  /**
   * Parse one thread's work-log shard into the in-memory map.
   * @param {Record<string, unknown>} map proxy target
   * @param {string} threadId
   * @returns {unknown[] | undefined}
   */
  _hydrateWorkLog(map, threadId) {
    if (Object.prototype.hasOwnProperty.call(map, threadId)) {
      return /** @type {unknown[]} */ (map[threadId]);
    }
    const raw = this._readWorkLogFile(threadId);
    if (raw == null) return undefined;
    let val;
    try {
      val = JSON.parse(raw);
    } catch {
      val = [];
    }
    if (!Array.isArray(val)) val = [];
    map[threadId] = val;
    return val;
  }

  /**
   * @param {object} data
   */
  _attachWorkLogProxy(data) {
    const store = this;
    const target =
      data.workLogByThread &&
      typeof data.workLogByThread === "object" &&
      !Array.isArray(data.workLogByThread)
        ? data.workLogByThread
        : {};
    data.workLogByThread = new Proxy(target, {
      get(t, prop, recv) {
        if (typeof prop !== "string") return Reflect.get(t, prop, recv);
        if (prop === "constructor" || prop === "__proto__" || prop === "toJSON") {
          return Reflect.get(t, prop, recv);
        }
        return store._hydrateWorkLog(t, prop);
      },
      has(t, prop) {
        if (typeof prop !== "string") return prop in t;
        return (
          Object.prototype.hasOwnProperty.call(t, prop) ||
          store._workLogShards.has(prop)
        );
      },
      ownKeys(t) {
        const keys = new Set(Object.keys(t));
        for (const k of store._workLogShards) keys.add(k);
        return [...keys];
      },
      getOwnPropertyDescriptor(t, prop) {
        if (typeof prop !== "string") {
          return Reflect.getOwnPropertyDescriptor(t, prop);
        }
        const own = Object.prototype.hasOwnProperty.call(t, prop);
        if (!own && !store._workLogShards.has(prop)) return undefined;
        // Do not read the shard: Object.keys / hasOwnProperty stay cheap.
        return {
          enumerable: true,
          configurable: true,
          writable: true,
          value: own ? t[prop] : undefined,
        };
      },
      set(t, prop, value) {
        if (typeof prop !== "string") return Reflect.set(t, prop, value);
        t[prop] = value;
        store._markWorkLogDirty(prop);
        return true;
      },
      deleteProperty(t, prop) {
        if (typeof prop !== "string") return Reflect.deleteProperty(t, prop);
        delete t[prop];
        store._markWorkLogDeleted(prop);
        return true;
      },
    });
  }

  /**
   * Split inline workLogByThread onto worklogs/<id>.json. Existing shard
   * files win unless that id was mutated this load (crash-recovery close).
   * Envelope is stripped only after every legacy key was written or already
   * had a winning shard.
   * @param {object} data
   * @returns {boolean} true if the envelope should drop the inline map
   */
  _migrateInlineWorkLogs(data) {
    const ids = [...this._inlineWorkLogIds];
    if (ids.length === 0) {
      this._workLogsSplit = true;
      return false;
    }
    let complete = true;
    for (const id of ids) {
      if (!isSafeThreadId(id)) {
        complete = false;
        continue;
      }
      const dirty = this._dirtyWorkLogIds.has(id);
      if (this._workLogShards.has(id) && !dirty) continue;
      const items =
        data.workLogByThread &&
        Object.prototype.hasOwnProperty.call(data.workLogByThread, id)
          ? data.workLogByThread[id]
          : [];
      try {
        writeAtomicSync(
          this._workLogPath(id),
          JSON.stringify(Array.isArray(items) ? items : []),
          ++this._atomicSeq,
        );
        this._workLogShards.add(id);
        this._dirtyWorkLogIds.delete(id);
      } catch {
        complete = false;
      }
    }
    if (!complete) {
      this._workLogsSplit = false;
      return false;
    }
    this._inlineWorkLogIds.clear();
    this._workLogsSplit = true;
    return true;
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  _sidePath(name) {
    return path.join(path.dirname(this.filePath), name);
  }

  /**
   * Parse a side file, falling back to its rolling `.bak` when the main copy
   * is missing or unreadable. Never throws.
   * @param {string} name
   * @returns {object | null}
   */
  _readSideFile(name) {
    const p = this._sidePath(name);
    for (const candidate of [p, `${p}.bak`]) {
      try {
        const val = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (val && typeof val === "object" && !Array.isArray(val)) {
          if (candidate === p) this._sideLoaded.add(name);
          else this._sideFromBak.add(name);
          return val;
        }
      } catch {
        // Missing or corrupt: try the backup, then give up.
      }
    }
    return null;
  }

  /**
   * Put side-file notes back on the parsed thread rows and pick the
   * usageThreadsByDay source. A field still inline in the envelope (an
   * unmigrated store, or one an older build wrote after a downgrade) is
   * merged over the side copy.
   * @param {object[]} threads parsed rows, mutated
   * @param {unknown} inlineUsage parsed.usageThreadsByDay
   * @returns {{ usage: unknown, inline: boolean }}
   */
  _adoptSideFiles(threads, inlineUsage) {
    this._sideLoaded = new Set();
    this._sideFromBak = new Set();
    const notes = this._readSideFile(THREAD_NOTES_FILE);
    let inline = false;
    for (const t of threads) {
      if (!t || t.id == null) continue;
      if (hasInlineNotes(t)) inline = true;
      if (!notes) continue;
      for (const f of NOTE_FIELDS) {
        const side = notes[f] && notes[f][t.id];
        if (!Array.isArray(side)) continue;
        t[f] = Object.prototype.hasOwnProperty.call(t, f)
          ? mergeNotesById(side, t[f])
          : side;
      }
    }
    const sideUsage = this._readSideFile(USAGE_THREADS_FILE);
    const hasInlineUsage =
      !!inlineUsage &&
      typeof inlineUsage === "object" &&
      Object.keys(inlineUsage).length > 0;
    if (hasInlineUsage) inline = true;
    let usage = sideUsage || inlineUsage;
    if (sideUsage && hasInlineUsage) {
      usage = { ...sideUsage };
      for (const [day, row] of Object.entries(inlineUsage)) {
        usage[day] = { ...(sideUsage[day] || {}), ...row };
      }
    }
    return { usage, inline };
  }

  /**
   * Per-thread note array identities, for change detection.
   * @param {object[]} threads
   * @returns {Map<string, { hypotheses: unknown, suggestions: unknown }>}
   */
  _noteRefs(threads) {
    const refs = new Map();
    for (const t of threads || []) {
      if (!t || t.id == null) continue;
      if (t.hypotheses === undefined && t.suggestions === undefined) continue;
      refs.set(t.id, { hypotheses: t.hypotheses, suggestions: t.suggestions });
    }
    return refs;
  }

  /**
   * Side files whose content changed since they were last written. Call
   * `commit()` on each once its bytes are on disk.
   * ponytail: change detection is by identity. updateThread replaces the
   * note arrays and recordUsage bumps _usageThreadsGen; an in-place push into
   * thread.hypotheses would not be seen. Diff the JSON if that ever happens.
   * @param {object} [data]
   * @param {boolean} [force] write both even if unchanged
   * @returns {Array<{ dest: string, json: string, commit: () => void }>}
   */
  _snapshotSideFiles(data = this.data, force = false) {
    if (!this._sideSplit) return [];
    const out = [];
    const refs = this._noteRefs(data.threads);
    if (force || !sameNoteRefs(refs, this._notesWritten)) {
      const notes = { hypotheses: {}, suggestions: {} };
      for (const [id, r] of refs) {
        if (r.hypotheses !== undefined) notes.hypotheses[id] = r.hypotheses;
        if (r.suggestions !== undefined) notes.suggestions[id] = r.suggestions;
      }
      out.push({
        dest: this._sidePath(THREAD_NOTES_FILE),
        json: JSON.stringify(notes),
        commit: () => {
          this._notesWritten = refs;
        },
      });
    }
    const usage = data.usageThreadsByDay;
    const gen = this._usageThreadsGen;
    if (
      force ||
      usage !== this._usageThreadsWritten.ref ||
      gen !== this._usageThreadsWritten.gen
    ) {
      out.push({
        dest: this._sidePath(USAGE_THREADS_FILE),
        json: JSON.stringify(usage || {}),
        commit: () => {
          this._usageThreadsWritten = { ref: usage, gen };
        },
      });
    }
    return out;
  }

  /**
   * Record that the side files on disk already match `data` (clean load).
   * @param {object} data
   */
  _markSideFilesWritten(data) {
    this._notesWritten = this._noteRefs(data.threads);
    this._usageThreadsWritten = {
      ref: data.usageThreadsByDay,
      gen: this._usageThreadsGen,
    };
    // Read from .bak: the main copy is missing or corrupt, so rewrite it.
    if (this._sideFromBak.has(THREAD_NOTES_FILE)) this._notesWritten = new Map();
    if (this._sideFromBak.has(USAGE_THREADS_FILE)) {
      this._usageThreadsWritten = { ref: null, gen: -1 };
    }
    if (this._sideFromBak.size > 0) this._recoveredOnLoad = true;
  }

  /**
   * Move inline hypotheses/suggestions/usageThreadsByDay into the side
   * files. Fail closed: the envelope keeps them inline (_sideSplit false)
   * unless both side files were written. The file being migrated is copied
   * to `.bak` first.
   * @param {object} data
   * @param {string} sourcePath
   * @returns {boolean} true if the envelope should be rewritten without them
   */
  _migrateSideFiles(data, sourcePath) {
    this._sideSplit = true;
    try {
      if (!this._copyLegacyEnvelopeBak(sourcePath)) throw new Error("no .bak");
      for (const s of this._snapshotSideFiles(data, true)) {
        writeAtomicSync(s.dest, s.json, ++this._atomicSeq);
        s.commit();
      }
      return true;
    } catch {
      this._sideSplit = false;
      return false;
    }
  }

  /**
   * Append one message without hydrating a still-lazy transcript. Crash
   * recovery uses this so a force-quit does not JSON.parse in-flight runs.
   * @param {string} threadId
   * @param {object} message
   */
  _appendLazyMessage(threadId, message) {
    if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, threadId)) {
      const list = this._messagesHydrated[threadId];
      if (Array.isArray(list)) list.push(message);
      else this._messagesHydrated[threadId] = [message];
      this._markMessagesDirty(threadId);
      return;
    }
    // Prefer an existing shard over the legacy blob (interrupted migrate).
    const fileRaw = this._readMessageRaw(threadId);
    if (fileRaw) {
      const range = { start: 0, end: fileRaw.length };
      const patched = appendJsonArrayItem(fileRaw, range, message);
      if (patched) {
        this._messagesRaw.set(threadId, patched.raw);
        this._markMessagesDirty(threadId);
        return;
      }
    }
    const lazy = this._messagesLazy;
    if (lazy && lazy.raw) {
      const r = this._threadRange(threadId);
      if (r) {
        const patched = appendJsonArrayItem(lazy.raw, r, message);
        if (patched) {
          lazy.raw = patched.raw;
          this._shiftLazyRanges(patched.at, patched.delta, threadId);
          this._markMessagesDirty(threadId);
          return;
        }
      }
    }
    // Missing key or not an array: tiny hydrated tail, not the original blob.
    this._messagesHydrated[threadId] = [message];
    this._invalidateLazy(threadId);
    this._markMessagesDirty(threadId);
  }

  /**
   * Parse one thread's message array from a shard or the leftover blob slice.
   * @param {string} threadId
   * @returns {object[] | undefined}
   */
  _hydrateMessages(threadId) {
    if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, threadId)) {
      this._touchHydrated(threadId);
      return this._messagesHydrated[threadId];
    }
    let json = null;
    if (this._messagesRaw.has(threadId)) {
      json = this._messagesRaw.get(threadId);
    } else {
      const fileRaw = this._readMessageRaw(threadId);
      if (fileRaw) json = fileRaw;
    }
    if (json == null) {
      const r = this._threadRange(threadId);
      if (r && this._messagesLazy) {
        json = this._messagesLazy.raw.slice(r.start, r.end);
      }
    }
    if (json == null) return undefined;
    let val;
    try {
      val = JSON.parse(json);
    } catch {
      val = [];
    }
    if (!Array.isArray(val)) val = [];
    if (backfillFromNotice(val)) {
      this._markMessagesDirty(threadId);
      this.markDirty();
      // Constructor assigns this.data from _load(); save during load would
      // stringify before that assignment. Persist now only when already live.
      if (this.data) this.save();
    }
    this._messagesHydrated[threadId] = val;
    this._messagesRaw.delete(threadId);
    this._hydratedReads.set(threadId, json.length);
    this._evictHydrated();
    return val;
  }

  /**
   * Move a hydrated id to the most recent end of the LRU, keeping its size.
   * @param {string} threadId
   */
  _touchHydrated(threadId) {
    const bytes = this._hydratedReads.get(threadId) || 0;
    this._hydratedReads.delete(threadId);
    this._hydratedReads.set(threadId, bytes);
  }

  /**
   * Drop least recently read transcripts past MAX_HYDRATED_THREADS or
   * MAX_HYDRATED_BYTES back to their shard. Only a thread whose shard on disk
   * is current is eligible: never one that is working, dirty, mid-flush, or
   * still on the legacy blob, and never the most recent read.
   */
  _evictHydrated() {
    const hydrated = this._messagesHydrated;
    const ids = Object.keys(hydrated);
    let excess = ids.length - MAX_HYDRATED_THREADS;
    let bytes = 0;
    for (const id of ids) bytes += this._hydratedReads.get(id) || 0;
    if (excess <= 0 && bytes <= MAX_HYDRATED_BYTES) return;
    let newest;
    for (const id of this._hydratedReads.keys()) newest = id;
    const working = new Set(
      (this.data ? this.data.threads : [])
        .filter((t) => t && t.status === "working")
        .map((t) => t.id),
    );
    const lazy = this._messagesLazy;
    // Never-read ids (legacy inline load) first, then least recently read.
    const order = [
      ...ids.filter((id) => !this._hydratedReads.has(id)),
      ...this._hydratedReads.keys(),
    ];
    for (const id of order) {
      if (excess <= 0 && bytes <= MAX_HYDRATED_BYTES) break;
      if (
        id === newest ||
        !Object.prototype.hasOwnProperty.call(hydrated, id) ||
        working.has(id) ||
        !this._messageShards.has(id) ||
        this._dirtyMessageIds.has(id) ||
        this._deletedMessageIds.has(id) ||
        (this._inflightShardIds && this._inflightShardIds.has(id)) ||
        (lazy && lazy.ranges.has(id))
      ) {
        continue;
      }
      bytes -= this._hydratedReads.get(id) || 0;
      delete hydrated[id];
      this._hydratedReads.delete(id);
      excess -= 1;
    }
  }

  /**
   * Envelope only: transcripts live in messages/<id>.json, work logs in
   * worklogs/<id>.json. A still-inline legacy workLogByThread rides along
   * until the shard split completes.
   * @param {object} [data]
   * @returns {string}
   */
  _serialize(data) {
    const src = data || this.data;
    // Secret fields are sealed in the JSON payload only; in-memory settings
    // stay plaintext (#543). stringifyStore skips data.messagesByThread and
    // data.workLogByThread, so the shallow copy never walks those maps.
    const settings = this._secrets.concealSettings(src.settings);
    // Side-file data (#1475) leaves the envelope once its files are written.
    const payload = this._sideSplit
      ? {
          ...src,
          settings,
          threads: (src.threads || []).map(stripNotes),
          usageThreadsByDay: {},
        }
      : settings === src.settings
        ? src
        : { ...src, settings };
    const workLogs = this._workLogsSplit
      ? {}
      : src.workLogByThread && typeof src.workLogByThread === "object"
        ? src.workLogByThread
        : {};
    if (this._messagesLazy && this._messagesLazy.raw) {
      return stringifyStore(
        payload,
        this._messagesHydrated,
        this._messagesLazy,
        workLogs,
      );
    }
    return stringifyStore(payload, {}, null, workLogs);
  }

  /**
   * Read, parse and normalize one store file. Throws on missing, unreadable
   * or unparseable input so callers can quarantine or fall through to backup.
   * @param {string} filePath
   * @returns {object}
   */
  _readFile(filePath) {
    this._messagesLazy = null;
    this._workLogsSplit = false;
    this._inlineWorkLogIds = new Set();
    const raw = fs.readFileSync(filePath, "utf8");
    const { parsed, split } = this._parseStoreJson(raw);
    const threads = Array.isArray(parsed.threads)
      ? parsed.threads.map(migrateThread)
      : [];
    const rawProjects = Array.isArray(parsed.projects) ? parsed.projects : [];
    const hadSpaces =
      (Array.isArray(parsed.spaces) && parsed.spaces.length > 0) ||
      rawProjects.some(
        (p) =>
          p &&
          typeof p === "object" &&
          typeof p.spaceId === "string" &&
          p.spaceId.trim() !== "",
      );
    const useLazy = !!(split && split.raw);
    // Reveal secret-bearing raw settings before canonical normalization so
    // env-agreement and size caps run on plaintext. Non-deterministic
    // safeStorage ciphertext would otherwise look like env conflicts, and
    // sealed envelopes can exceed plaintext length caps.
    const revealed = this._secrets.revealSettings(parsed.settings);
    const side = this._adoptSideFiles(threads, parsed.usageThreadsByDay);
    // Inline until _migrateSideFiles has written both side files.
    this._sideSplit = !side.inline;
    const data = {
      projects: rawProjects.map(migrateProject),
      // #568: Spaces retired. Keep the key so old files still parse; never load rows.
      spaces: [],
      threads,
      messagesByThread: useLazy
        ? {}
        : parsed.messagesByThread && typeof parsed.messagesByThread === "object"
          ? parsed.messagesByThread
          : {},
      workLogByThread:
        parsed.workLogByThread && typeof parsed.workLogByThread === "object"
          ? parsed.workLogByThread
          : {},
      usageByThread:
        parsed.usageByThread && typeof parsed.usageByThread === "object"
          ? parsed.usageByThread
          : {},
      runArtifactsByThread: normalizeRunArtifactsByThread(parsed.runArtifactsByThread),
      rewindRestoreByThread:
        parsed.rewindRestoreByThread &&
        typeof parsed.rewindRestoreByThread === "object" &&
        !Array.isArray(parsed.rewindRestoreByThread)
          ? parsed.rewindRestoreByThread
          : {},
      workflowRunByThread:
        parsed.workflowRunByThread &&
        typeof parsed.workflowRunByThread === "object" &&
        !Array.isArray(parsed.workflowRunByThread)
          ? parsed.workflowRunByThread
          : {},
      workflowTemplates: Array.isArray(parsed.workflowTemplates)
        ? parsed.workflowTemplates.map(migrateTemplateKimiModels)
        : [],
      spendByDay: normalizeSpendByDay(parsed.spendByDay),
      usageByDay: normalizeUsageByDay(parsed.usageByDay),
      usageThreadsByDay: normalizeUsageThreadsByDay(side.usage),
      automations: Array.isArray(parsed.automations)
        ? parsed.automations.map(migrateAutomation)
        : [],
      digestSeenAt:
        typeof parsed.digestSeenAt === "number" &&
        Number.isFinite(parsed.digestSeenAt)
          ? parsed.digestSeenAt
          : null,
      tasksByCrew:
        parsed.tasksByCrew &&
        typeof parsed.tasksByCrew === "object" &&
        !Array.isArray(parsed.tasksByCrew)
          ? parsed.tasksByCrew
          : {},
      settings: normalizeSettings(revealed.settings),
    };
    ensureWorkflowTemplates(data);
    this._scanMessageShards();
    this._adoptMessages(data, useLazy ? split : null);
    this._adoptWorkLogs(data);
    this._recoveredOnLoad = recoverInterruptedRuns(this, data) || hadSpaces;
    if (revealed.migrated > 0) {
      this._secretsMigrated = revealed.migrated;
      this._recoveredOnLoad = true;
    }
    try {
      const messagesMigrated = this._migrateInlineMessages(data, filePath);
      const workLogsMigrated = this._migrateInlineWorkLogs(data);
      let sideMigrated = false;
      if (side.inline) sideMigrated = this._migrateSideFiles(data, filePath);
      else this._markSideFilesWritten(data);
      if (messagesMigrated || workLogsMigrated || sideMigrated) {
        try {
          writeAtomicSync(
            this.filePath,
            this._serialize(data),
            ++this._atomicSeq,
          );
        } catch {
          // Shards are on disk; next boot retries the envelope strip.
          this._recoveredOnLoad = true;
        }
      }
    } catch {
      // Parsed envelope stays in memory. Never quarantine a readable store
      // because a shard write or encode failed.
    }
    this._seedLastAssistants(
      data,
      useLazy && split ? split.lastAssistants : null,
    );
    if (this._dirtyMessageIds.size > 0) this._recoveredOnLoad = true;
    return data;
  }

  _load() {
    this._recoveredOnLoad = false;
    this._secretsMigrated = 0;
    const bakPath = `${this.filePath}.bak`;
    const mainExists = fs.existsSync(this.filePath);
    if (mainExists) {
      try {
        const data = this._readFile(this.filePath);
        // Last-known-good snapshot from this successful start. Off the
        // constructor's sync path so first paint is not blocked (#618).
        // setImmediate + copyFileSync: the copy finishes in one turn after
        // we yield, and a missing source (test tmpdir already gone) is a
        // no-op instead of recreating files under rmdir.
        // FICLONE: instant CoW clone on APFS instead of a byte copy of the
        // whole store; silently falls back to a real copy elsewhere.
        const src = this.filePath;
        this._bakCopy = new Promise((resolve) => {
          setImmediate(() => {
            try {
              if (fs.existsSync(src)) {
                fs.copyFileSync(src, bakPath, fs.constants.COPYFILE_FICLONE);
                // Only side files that parsed: never clone a corrupt one
                // over its last good backup.
                for (const name of this._sideLoaded) {
                  const side = this._sidePath(name);
                  fs.copyFileSync(side, `${side}.bak`, fs.constants.COPYFILE_FICLONE);
                }
              }
            } catch {
              // Never fail a load over the rolling backup.
            }
            resolve();
          });
        });
        return data;
      } catch {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.filePath, corruptPath);
          console.error(
            `[store] quarantined unreadable store ${this.filePath} → ${corruptPath}`,
          );
        } catch {
          // Keep going even if the rename fails (file may be locked).
        }
      }
    }

    // Main missing or unreadable: try the last-known-good backup.
    if (fs.existsSync(bakPath)) {
      try {
        const data = this._readFile(bakPath);
        console.error(`[store] recovered store from backup ${bakPath}`);
        return data;
      } catch {
        // Both main and backup failed.
      }
    }

    this._lastAssistantByThread.clear();
    this._messagesLazy = null;
    this._scanMessageShards();
    const data = cloneEmpty();
    this._messagesHydrated = data.messagesByThread;
    this._attachMessagesProxy(data);
    this._adoptWorkLogs(data);
    this._sideSplit = true;
    this._markSideFilesWritten(data);
    return data;
  }

  /**
   * Remember in-memory mutations without scheduling a flush. The next
   * save() coalesces them; the exit hook writes if we quit first. Use for
   * cheap bookkeeping (lastVisitedAt) that must not rewrite the whole
   * store on every call (#636). Not `touch`: that already means bump
   * updatedAt on updateThread.
   */
  markDirty() {
    this._dirty = true;
    // ponytail: every markDirty/save() counts as an envelope change, because
    // callers mutate store.data directly and the store cannot see that. The
    // throttle, not change detection, is what bounds envelope writes.
    this._envelopeDirty = true;
    // At most one exit hook no matter how often markDirty()/save() run.
    if (!this._exitHookArmed) {
      this._exitHookArmed = true;
      process.once("exit", this._flushOnExit);
    }
  }

  /**
   * Mark dirty and coalesce writes. The envelope is small; each flush
   * stringifies only dirty message/work-log shards plus the envelope and
   * writes tmp-then-rename off the event loop. Callers that need the bytes
   * on disk right now use saveNow().
   */
  save() {
    this.markDirty();
    this._scheduleFlush();
  }

  /**
   * @param {number} [delayMs] defaults to the shard debounce. An earlier
   *   request replaces a later pending timer (a deferred envelope must not
   *   hold back a shard write).
   */
  _scheduleFlush(delayMs = this._flushDelayMs) {
    const due = Date.now() + delayMs;
    if (this._timer) {
      if (this._timerDue <= due) return;
      clearTimeout(this._timer);
    }
    this._timerDue = due;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flushAsync();
    }, delayMs);
    // Never hold the event loop open; the exit hook is what guarantees the write.
    this._timer.unref?.();
  }

  /** @returns {boolean} */
  _shardsDirty() {
    return (
      this._dirtyMessageIds.size > 0 ||
      this._deletedMessageIds.size > 0 ||
      this._dirtyWorkLogIds.size > 0 ||
      this._deletedWorkLogIds.size > 0
    );
  }

  /** @returns {number} ms until the envelope may be written again (0 = now) */
  _envelopeWait() {
    return Math.max(
      0,
      this._lastEnvelopeWriteAt + ENVELOPE_THROTTLE_MS - Date.now(),
    );
  }

  /**
   * Debounced flush: stringify the envelope plus dirty shards, then write
   * tmp + rename via fs.promises so the disk IO stays off the event loop.
   * A flush that turns stale mid-flight (a synchronous saveNow bumping
   * `_writeGen`) drops its tmp files instead of renaming over newer data.
   * An unrelated later `_dirty` does not invalidate this shard snapshot.
   * The envelope rides along only when its throttle window is open (or the
   * flush deletes a shard); otherwise this writes dirty shards alone.
   * Never throws: failures re-mark dirty so the next save()/exit hook retries.
   */
  _flushAsync() {
    if (this._flushing) {
      // The in-flight flush re-checks dirty on completion and reschedules.
      if (this._dirty) this._scheduleFlush();
      return;
    }
    if (!this._dirty) return;
    // Deletes commit together with the envelope, so a crash cannot leave a
    // thread row whose transcript is already gone. They are rare.
    const hasDeletes =
      this._deletedMessageIds.size > 0 || this._deletedWorkLogIds.size > 0;
    const writeEnvelope =
      this._envelopeDirty && (hasDeletes || this._envelopeWait() === 0);
    if (!writeEnvelope && !this._shardsDirty()) {
      // Only a throttled envelope is pending: wake when its window opens.
      if (this._envelopeDirty) this._scheduleNextFlush();
      else this._dirty = false;
      return;
    }
    this._flushing = true;
    if (writeEnvelope) this._envelopeDirty = false;
    this._dirty = this._envelopeDirty;
    const gen = this._writeGen;
    const snapshot = this._snapshotDirtyShards();
    this._inflightShardIds = new Set(
      snapshot.writes.filter((w) => w.kind === "messages").map((w) => w.id),
    );
    this._inflightDeletedIds = new Set(
      snapshot.deleted.filter((d) => d.kind === "messages").map((d) => d.id),
    );
    this._inflightWorkLogIds = new Set(
      snapshot.writes.filter((w) => w.kind === "worklogs").map((w) => w.id),
    );
    this._inflightDeletedWorkLogIds = new Set(
      snapshot.deleted.filter((d) => d.kind === "worklogs").map((d) => d.id),
    );
    const payload = writeEnvelope ? this._serialize() : null;
    const envelopeTmp = writeEnvelope
      ? `${this.filePath}.${process.pid}.${++this._atomicSeq}.tmp`
      : null;
    // Side files ride with the envelope (same throttle, same dirtiness).
    const sideTmps = (writeEnvelope ? this._snapshotSideFiles() : []).map(
      (w) => ({ ...w, tmp: `${w.dest}.${process.pid}.${++this._atomicSeq}.tmp` }),
    );
    const shardTmps = snapshot.writes.map((w) => ({
      id: w.id,
      kind: w.kind,
      dest: w.dest,
      tmp: `${w.dest}.${process.pid}.${++this._atomicSeq}.tmp`,
      json: w.json,
    }));
    this._flushPromise = (async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.filePath), {
          recursive: true,
        });
        const dirs = new Set(shardTmps.map((s) => path.dirname(s.dest)));
        for (const dir of dirs) {
          await fs.promises.mkdir(dir, { recursive: true });
        }
        const writeTmp = async (tmp, contents) => {
          const handle = await fs.promises.open(tmp, "w");
          try {
            await handle.writeFile(contents, "utf8");
            try {
              await handle.sync();
            } catch {
              // fsync is best-effort; still rename so the write is not lost.
            }
          } finally {
            await handle.close();
          }
        };
        if (envelopeTmp) await writeTmp(envelopeTmp, payload);
        for (const s of sideTmps) await writeTmp(s.tmp, s.json);
        for (const s of shardTmps) await writeTmp(s.tmp, s.json);
        // Synchronous commit: saveNow cannot interleave inside this block.
        // A later unrelated `_dirty` (settings, lastVisitedAt, …) does not
        // invalidate this shard snapshot; only a newer `_writeGen` (saveNow)
        // does. Follow-up flushes pick up the envelope-only mutation.
        if (this._writeGen === gen) {
          const failedDeletes = [];
          for (const d of snapshot.deleted) {
            try {
              fs.unlinkSync(d.dest);
            } catch {
              if (fs.existsSync(d.dest)) failedDeletes.push(d);
            }
          }
          for (const s of shardTmps) {
            fs.renameSync(s.tmp, s.dest);
            if (s.kind === "worklogs") this._workLogShards.add(s.id);
            else this._messageShards.add(s.id);
          }
          for (const s of sideTmps) {
            fs.renameSync(s.tmp, s.dest);
            s.commit();
          }
          if (failedDeletes.length === 0) {
            if (envelopeTmp) {
              fs.renameSync(envelopeTmp, this.filePath);
              this._lastEnvelopeWriteAt = Date.now();
            }
          } else {
            this._dirty = true;
            if (writeEnvelope) this._envelopeDirty = true;
            for (const d of failedDeletes) {
              if (d.kind === "worklogs") this._deletedWorkLogIds.add(d.id);
              else this._deletedMessageIds.add(d.id);
            }
          }
        }
        // else: stale payload; the tmp unlinks below discard it.
      } catch (err) {
        if (this._writeGen === gen) {
          this._dirty = true;
          if (writeEnvelope) this._envelopeDirty = true;
          for (const w of snapshot.writes) {
            if (w.kind === "worklogs") this._dirtyWorkLogIds.add(w.id);
            else this._dirtyMessageIds.add(w.id);
          }
          for (const d of snapshot.deleted) {
            if (d.kind === "worklogs") this._deletedWorkLogIds.add(d.id);
            else this._deletedMessageIds.add(d.id);
          }
          console.error(
            `[store] async flush failed (will retry): ${err && err.message}`,
          );
        }
      } finally {
        if (envelopeTmp) await fs.promises.unlink(envelopeTmp).catch(() => {});
        for (const s of sideTmps) {
          await fs.promises.unlink(s.tmp).catch(() => {});
        }
        for (const s of shardTmps) {
          await fs.promises.unlink(s.tmp).catch(() => {});
        }
        this._inflightShardIds = null;
        this._inflightDeletedIds = null;
        this._inflightWorkLogIds = null;
        this._inflightDeletedWorkLogIds = null;
        this._flushing = false;
        this._flushPromise = null;
        if (this._dirty) this._scheduleNextFlush();
      }
    })();
  }

  /** Shards debounce at 250 ms; an envelope-only flush waits for its window. */
  _scheduleNextFlush() {
    this._scheduleFlush(
      this._shardsDirty()
        ? this._flushDelayMs
        : Math.max(this._flushDelayMs, this._envelopeWait()),
    );
  }

  /**
   * Test hook: resolves once any in-flight async flush has settled.
   * @returns {Promise<void>}
   */
  flushPending() {
    return this._flushPromise || Promise.resolve();
  }

  /**
   * Synchronous flush for the exit hook, shutdown and tests. Cancels any
   * pending debounce and aborts any in-flight async flush (its payload is
   * older than what this writes).
   */
  saveNow() {
    // ponytail: stays sync because process.on('exit') cannot await. Do not
    // "fix" this into async; the debounce path is the hot one. Writes the
    // envelope plus dirty shards only — not every transcript.
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._flushDelayMs = SAVE_DEBOUNCE_MS;
    // Invalidate any in-flight async commit before touching files. The async
    // rename loop is synchronous, so it cannot interleave with this method.
    this._writeGen += 1;
    // Replay deletes first, then writes so a later setMessages/setWorkLog wins.
    if (this._inflightDeletedIds) {
      for (const id of this._inflightDeletedIds) {
        if (!this._dirtyMessageIds.has(id)) this._markMessagesDeleted(id);
      }
    }
    if (this._inflightShardIds) {
      for (const id of this._inflightShardIds) {
        if (!this._deletedMessageIds.has(id)) this._markMessagesDirty(id);
      }
    }
    if (this._inflightDeletedWorkLogIds) {
      for (const id of this._inflightDeletedWorkLogIds) {
        if (!this._dirtyWorkLogIds.has(id)) this._markWorkLogDeleted(id);
      }
    }
    if (this._inflightWorkLogIds) {
      for (const id of this._inflightWorkLogIds) {
        if (!this._deletedWorkLogIds.has(id)) this._markWorkLogDirty(id);
      }
    }
    const snapshot = this._snapshotDirtyShards({ clear: false });
    const shardKey = (row) => `${row.kind}:${row.id}`;
    const landedDeletes = new Set();
    const landedWrites = new Set();
    try {
      for (const d of snapshot.deleted) {
        try {
          fs.unlinkSync(d.dest);
          landedDeletes.add(shardKey(d));
        } catch {
          if (!fs.existsSync(d.dest)) landedDeletes.add(shardKey(d));
        }
      }
      for (const w of snapshot.writes) {
        writeAtomicSync(w.dest, w.json, ++this._atomicSeq);
        if (w.kind === "worklogs") this._workLogShards.add(w.id);
        else this._messageShards.add(w.id);
        landedWrites.add(shardKey(w));
      }
      const deletesPending = snapshot.deleted.some(
        (d) => !landedDeletes.has(shardKey(d)),
      );
      for (const s of this._snapshotSideFiles()) {
        writeAtomicSync(s.dest, s.json, ++this._atomicSeq);
        s.commit();
      }
      if (!deletesPending) {
        writeAtomicSync(this.filePath, this._serialize(), ++this._atomicSeq);
        // Not a throttle tick: an explicit write does not delay the next
        // debounced one (the throttle bounds the save() path only).
        this._envelopeDirty = false;
      }
      for (const w of snapshot.writes) {
        if (!landedWrites.has(shardKey(w))) continue;
        if (w.kind === "worklogs") this._dirtyWorkLogIds.delete(w.id);
        else this._dirtyMessageIds.delete(w.id);
      }
      for (const d of snapshot.deleted) {
        if (!landedDeletes.has(shardKey(d))) continue;
        if (d.kind === "worklogs") this._deletedWorkLogIds.delete(d.id);
        else this._deletedMessageIds.delete(d.id);
      }
      if (
        this._dirtyMessageIds.size === 0 &&
        this._deletedMessageIds.size === 0 &&
        this._dirtyWorkLogIds.size === 0 &&
        this._deletedWorkLogIds.size === 0
      ) {
        this._dirty = false;
        if (this._exitHookArmed) {
          this._exitHookArmed = false;
          process.off("exit", this._flushOnExit);
        }
      } else {
        this._dirty = true;
        this.markDirty();
      }
    } catch (err) {
      for (const w of snapshot.writes) {
        if (!landedWrites.has(shardKey(w))) continue;
        if (w.kind === "worklogs") this._dirtyWorkLogIds.delete(w.id);
        else this._dirtyMessageIds.delete(w.id);
      }
      for (const d of snapshot.deleted) {
        if (!landedDeletes.has(shardKey(d))) continue;
        if (d.kind === "worklogs") this._deletedWorkLogIds.delete(d.id);
        else this._deletedMessageIds.delete(d.id);
      }
      this._dirty = true;
      this.markDirty();
      throw err;
    }
  }

  getProjects() {
    return this.data.projects;
  }

  setProjects(projects) {
    this.data.projects = (projects || []).map(migrateProject);
  }

  getSpaces() {
    return [];
  }

  setSpaces() {
    this.data.spaces = [];
  }

  getThreads() {
    return this.data.threads;
  }

  setThreads(threads) {
    this.data.threads = threads.map(migrateThread);
  }

  getMessages(threadId) {
    const list = this._hydrateMessages(threadId);
    return list || [];
  }

  /**
   * Last assistant message with non-empty text. Memoized until the thread's
   * message list changes. Not persisted.
   * @param {string} threadId
   * @returns {object | null}
   */
  getLastAssistantMessage(threadId) {
    if (this._lastAssistantByThread.has(threadId)) {
      return this._lastAssistantByThread.get(threadId);
    }
    if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, threadId)) {
      const msgs = this._messagesHydrated[threadId] || [];
      let last = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (
          m &&
          m.role === "assistant" &&
          typeof m.text === "string" &&
          m.text.trim() !== ""
        ) {
          last = m;
          break;
        }
      }
      this._lastAssistantByThread.set(threadId, last);
      return last;
    }
    if (this._messagesRaw.has(threadId)) {
      const raw = this._messagesRaw.get(threadId);
      const last = peekLastAssistantValue(raw, 0, raw.length);
      this._lastAssistantByThread.set(threadId, last);
      return last;
    }
    const fileRaw = this._readShardFile(threadId);
    if (fileRaw) {
      const last = peekLastAssistantValue(fileRaw, 0, fileRaw.length);
      this._lastAssistantByThread.set(threadId, last);
      return last;
    }
    const r = this._threadRange(threadId);
    if (r && this._messagesLazy) {
      const last = peekLastAssistantValue(
        this._messagesLazy.raw,
        r.start,
        r.end,
      );
      this._lastAssistantByThread.set(threadId, last);
      return last;
    }
    this._lastAssistantByThread.set(threadId, null);
    return null;
  }

  setMessages(threadId, messages) {
    this._lastAssistantByThread.delete(threadId);
    this._invalidateLazy(threadId);
    this._messagesRaw.delete(threadId);
    this._messagesHydrated[threadId] = capList(
      messages,
      MAX_MESSAGES_PER_THREAD,
      MESSAGE_OVERFLOW_SLACK,
      `Older messages were dropped to cap this transcript at ${MAX_MESSAGES_PER_THREAD}.`,
    );
    this._markMessagesDirty(threadId);
    this._touchHydrated(threadId);
  }

  /**
   * Append a message and bump the owning thread's updatedAt (real activity).
   * @param {string} threadId
   * @param {object} message
   */
  appendMessage(threadId, message) {
    const list = this.getMessages(threadId).slice();
    // Every runner/adapter message write lands here or in updateMessage, and
    // the renderer push, summaries and session transcript read back from the
    // store, so redacting here covers them all (#1531 secret_request).
    list.push(threadSecrets.redact(threadId, message));
    this.setMessages(threadId, list);
    this.updateThread(threadId, {}, { touch: true });
  }

  getWorkLog(threadId) {
    return this.data.workLogByThread[threadId] || [];
  }

  setWorkLog(threadId, items) {
    this.data.workLogByThread[threadId] = capList(
      items,
      MAX_WORKLOG_ITEMS_PER_THREAD,
      WORKLOG_OVERFLOW_SLACK,
      null,
    );
  }

  appendWorkLog(threadId, item) {
    const list = this.getWorkLog(threadId).slice();
    list.push(item);
    this.setWorkLog(threadId, list);
  }

  getRunArtifacts(threadId) {
    const value = this.data.runArtifactsByThread[String(threadId)];
    return Array.isArray(value) ? value : [];
  }

  setRunArtifacts(threadId, artifacts) {
    const id = String(threadId);
    this.data.runArtifactsByThread[id] = Array.isArray(artifacts)
      ? artifacts.map((artifact) => ({ ...artifact, threadId: id }))
      : [];
    this.markDirty();
  }

  findRunArtifact(id) {
    const wanted = String(id || "");
    for (const [threadId, artifacts] of Object.entries(
      this.data.runArtifactsByThread,
    )) {
      if (!Array.isArray(artifacts)) continue;
      const artifact = artifacts.find((item) => item && item.id === wanted);
      if (artifact) return { threadId, artifact };
    }
    return null;
  }

  /**
   * Drop messageId and every message after it, plus work-log items whose
   * runId is among the dropped runs. Usage / spend is left alone.
   * @param {string} threadId
   * @param {string} messageId
   * @returns {number} messages dropped (0 when messageId is not in the thread)
   */
  truncateFromMessage(threadId, messageId) {
    const msgs = this.getMessages(threadId);
    const idx = msgs.findIndex((m) => m && m.id === messageId);
    if (idx < 0) return 0;
    const dropped = msgs.slice(idx);
    const droppedRunIds = new Set();
    for (const m of dropped) {
      if (m && m.runId) droppedRunIds.add(m.runId);
    }
    this.setMessages(threadId, msgs.slice(0, idx));
    if (droppedRunIds.size) {
      this.setWorkLog(
        threadId,
        this.getWorkLog(threadId).filter(
          (w) => !w || !w.runId || !droppedRunIds.has(w.runId),
        ),
      );
    }
    const retainedRunIds = new Set();
    for (const m of this.getMessages(threadId)) {
      if (m && m.runId) retainedRunIds.add(m.runId);
    }
    for (const w of this.getWorkLog(threadId)) {
      if (w && w.runId) retainedRunIds.add(w.runId);
    }
    this.setRunArtifacts(
      threadId,
      this.getRunArtifacts(threadId).filter(
        (a) => !a || !a.runId || retainedRunIds.has(a.runId),
      ),
    );
    return dropped.length;
  }

  /**
   * Last orchestrated workflow view (internal shape, incl. agent outputs).
   * Persisted so a crash or restart can resume finished phases (#182).
   * @param {string} threadId
   * @returns {object | null}
   */
  getWorkflowRun(threadId) {
    return this.data.workflowRunByThread[threadId] || null;
  }

  /**
   * @param {string} threadId
   * @param {object} view
   */
  setWorkflowRun(threadId, view) {
    this.data.workflowRunByThread[threadId] = view;
  }

  /**
   * Snapshot taken just before a rewind, so a rejected start can put the
   * tail back (#1202). Not part of ThreadInfo; listThreads must not send it.
   * @param {string} threadId
   * @returns {object | null}
   */
  getRewindRestore(threadId) {
    const map = this.data.rewindRestoreByThread;
    if (!map || typeof map !== "object") return null;
    return map[threadId] || null;
  }

  /**
   * @param {string} threadId
   * @param {object | null} snap
   */
  setRewindRestore(threadId, snap) {
    if (!this.data.rewindRestoreByThread || typeof this.data.rewindRestoreByThread !== "object") {
      this.data.rewindRestoreByThread = {};
    }
    if (snap == null) {
      delete this.data.rewindRestoreByThread[threadId];
    } else {
      this.data.rewindRestoreByThread[threadId] = snap;
    }
    this.markDirty();
  }

  /**
   * Drop a pending rewind restore handle without applying it. Call when a
   * run has been accepted so a later undo cannot resurrect the tail.
   * @param {string} threadId
   */
  clearRewindRestore(threadId) {
    this.setRewindRestore(threadId, null);
  }

  /**
   * Put the pre-rewind transcript, work-log, artifacts, and session fields
   * back. Caller owns saveNow / file restore.
   * @param {string} threadId
   * @param {object} snap
   */
  applyRewindRestore(threadId, snap) {
    if (!snap || typeof snap !== "object") return;
    if (Array.isArray(snap.messages)) this.setMessages(threadId, snap.messages);
    if (Array.isArray(snap.workLog)) this.setWorkLog(threadId, snap.workLog);
    if (Array.isArray(snap.artifacts)) this.setRunArtifacts(threadId, snap.artifacts);
    this.updateThread(threadId, {
      sessionId: snap.sessionId != null ? snap.sessionId : null,
      replayContext: snap.replayContext === true,
      ...(snap.status != null ? { status: snap.status } : {}),
      lastError: snap.lastError != null ? snap.lastError : null,
      lastErrorKind: snap.lastErrorKind != null ? snap.lastErrorKind : null,
      runStartedAt: snap.runStartedAt != null ? snap.runStartedAt : null,
    });
  }

  /**
   * Crash/reload recovery for #1202: an idle thread with a restore handle
   * and no new run yet must not keep a truncated shard. Working threads
   * keep the handle (start accepted). If the transcript grew past the
   * retained count, a run already appended — drop the handle.
   * @returns {boolean}
   */
  recoverDanglingRewind() {
    const map = this.data.rewindRestoreByThread;
    if (!map || typeof map !== "object") return false;
    let recovered = false;
    for (const threadId of Object.keys(map)) {
      const snap = map[threadId];
      const thread = this.getThread(threadId);
      if (!thread || thread.status === "working") continue;
      const currentLen = this.getMessages(threadId).length;
      if (
        snap &&
        typeof snap.retainedCount === "number" &&
        currentLen !== snap.retainedCount
      ) {
        delete map[threadId];
        recovered = true;
        continue;
      }
      this.applyRewindRestore(threadId, snap);
      delete map[threadId];
      recovered = true;
    }
    if (recovered) this.markDirty();
    return recovered;
  }

  /**
   * The shared task list of one crew, keyed by the crew ROOT thread id
   * (issue #277). Returns a copy; callers mutate through setCrewTasks.
   * @param {string} rootThreadId
   * @returns {Array<object>}
   */
  getCrewTasks(rootThreadId) {
    if (!this.data.tasksByCrew || typeof this.data.tasksByCrew !== "object") {
      this.data.tasksByCrew = {};
    }
    const list = this.data.tasksByCrew[rootThreadId];
    return Array.isArray(list) ? list.map((t) => ({ ...t })) : [];
  }

  /**
   * Replace a crew's task list. Does not save; caller must save.
   * @param {string} rootThreadId
   * @param {Array<object>} tasks
   */
  setCrewTasks(rootThreadId, tasks) {
    if (!this.data.tasksByCrew || typeof this.data.tasksByCrew !== "object") {
      this.data.tasksByCrew = {};
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      delete this.data.tasksByCrew[rootThreadId];
      return;
    }
    this.data.tasksByCrew[rootThreadId] = tasks.map((t) => ({ ...t }));
  }

  /**
   * Last time the morning digest was marked seen (epoch ms), or null.
   * @returns {number | null}
   */
  getDigestSeenAt() {
    const v = this.data.digestSeenAt;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  /**
   * @param {number | null} ms
   */
  setDigestSeenAt(ms) {
    this.data.digestSeenAt =
      typeof ms === "number" && Number.isFinite(ms) ? ms : null;
  }

  /**
   * Patch an existing message by id. No-op if missing.
   * @param {string} threadId
   * @param {string} messageId
   * @param {object} patch
   */
  updateMessage(threadId, messageId, patch) {
    const list = this.getMessages(threadId).slice();
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    // Streams patch the whole accumulated text, so a value split across
    // chunks is caught once both halves have arrived.
    list[idx] = { ...list[idx], ...threadSecrets.redact(threadId, patch) };
    this.setMessages(threadId, list);
    return list[idx];
  }

  /**
   * Patch an existing work-log item by id. No-op if missing.
   * @param {string} threadId
   * @param {string} itemId
   * @param {object} patch
   */
  updateWorkLogItem(threadId, itemId, patch) {
    const list = this.getWorkLog(threadId).slice();
    const idx = list.findIndex((w) => w.id === itemId);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch };
    this.setWorkLog(threadId, list);
    return list[idx];
  }

  /**
   * Patch a thread. Does NOT bump updatedAt unless options.touch is true.
   * Real activity only: message append (via appendMessage), run status change,
   * or title change. Internal bookkeeping must omit touch.
   * @param {string} threadId
   * @param {object} patch
   * @param {{ touch?: boolean }} [options]
   */
  updateThread(threadId, patch, options) {
    const touch = Boolean(options && options.touch);
    const threads = this.data.threads.map((t) => {
      if (t.id !== threadId) return t;
      let p = patch;
      // CLI sessions are per-cwd (claude stores them under the munged spawn
      // dir), so a worktreePath change makes the captured sessionId
      // unresumable: --resume then dies with `error_during_execution` /
      // "No conversation found". Drop it so the next turn starts fresh.
      if (
        Object.prototype.hasOwnProperty.call(patch, "worktreePath") &&
        patch.worktreePath !== t.worktreePath &&
        !Object.prototype.hasOwnProperty.call(patch, "sessionId")
      ) {
        p = { ...patch, sessionId: null };
        // Same rule as setProvider (#1493): a dropped session replays the
        // thread's own tail so the next turn is not blind.
        if (t.sessionId) p.replayContext = true;
      }
      // Snapshot the rollout model on first sessionId (or a replacement
      // id). Codex exec resume ignores later picker changes (#1215).
      if (Object.prototype.hasOwnProperty.call(p, "sessionId")) {
        const nextSid =
          p.sessionId && p.sessionId !== "cwd" ? p.sessionId : null;
        const prevSid =
          t.sessionId && t.sessionId !== "cwd" ? t.sessionId : null;
        if (!Object.prototype.hasOwnProperty.call(p, "sessionStartModel")) {
          if (!nextSid) {
            p = { ...p, sessionStartModel: null };
          } else if (nextSid !== prevSid) {
            const modelSrc = Object.prototype.hasOwnProperty.call(p, "model")
              ? p.model
              : t.model;
            p = {
              ...p,
              sessionStartModel:
                modelSrc != null && String(modelSrc).trim() !== ""
                  ? String(modelSrc).trim()
                  : null,
            };
          }
        }
      }
      // A retry/new run is any non-failed status — drop a stale reason.
      // quota-wait keeps lastError so the card tooltip still explains why.
      if (
        Object.prototype.hasOwnProperty.call(p, "status") &&
        p.status !== "failed" &&
        p.status !== "quota-wait"
      ) {
        p = { ...p, lastError: null, lastErrorKind: null };
      } else if (
        Object.prototype.hasOwnProperty.call(p, "lastError") &&
        !Object.prototype.hasOwnProperty.call(p, "lastErrorKind")
      ) {
        // The semantic kind describes this exact error, never an older one.
        p = { ...p, lastErrorKind: null };
      }
      if (touch) {
        return { ...t, ...p, updatedAt: Date.now() };
      }
      return { ...t, ...p };
    });
    this.data.threads = threads;
    return threads.find((t) => t.id === threadId) || null;
  }

  getThread(threadId) {
    if (threadId == null) return null;
    return this.data.threads.find((t) => t.id === threadId) || null;
  }

  /**
   * Permanently remove a thread and every per-thread keyed map entry
   * (messages, work log, session usage, any future *ByThread map).
   * Does not save; caller must save.
   * @param {string} threadId
   * @returns {boolean} true if a thread was removed
   */
  removeThread(threadId) {
    if (threadId == null) return false;
    this._lastAssistantByThread.delete(threadId);
    const before = this.data.threads.length;
    this.data.threads = this.data.threads.filter((t) => t.id !== threadId);
    // Cascade: drop every *ByThread map key so nothing is orphaned on disk.
    for (const key of Object.keys(this.data)) {
      if (!key.endsWith("ByThread")) continue;
      const map = this.data[key];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        delete map[threadId];
      }
    }
    // tasksByCrew is keyed by the crew ROOT thread, not by every thread.
    if (this.data.tasksByCrew && typeof this.data.tasksByCrew === "object") {
      delete this.data.tasksByCrew[threadId];
    }
    return this.data.threads.length < before;
  }

  getProject(projectId) {
    return this.data.projects.find((p) => p.id === projectId) || null;
  }

  /**
   * @returns {object[]}
   */
  getAutomations() {
    if (!Array.isArray(this.data.automations)) {
      this.data.automations = [];
    }
    return this.data.automations;
  }

  /**
   * @param {object[]} automations
   */
  setAutomations(automations) {
    this.data.automations = Array.isArray(automations)
      ? automations.map(migrateAutomation)
      : [];
  }

  /**
   * @param {string} id
   */
  getAutomation(id) {
    if (id == null) return null;
    return this.getAutomations().find((a) => a && a.id === id) || null;
  }
}

// Domain method groups live in store-*-methods.js as classes. Copy their
// descriptors so the methods stay non-enumerable, exactly like methods
// declared in the class body.
for (const Methods of [
  StoreUsageMethods,
  StoreSettingsMethods,
  StoreSearchMethods,
  StoreTemplateMethods,
]) {
  for (const name of Object.getOwnPropertyNames(Methods.prototype)) {
    if (name === "constructor") continue;
    if (Object.prototype.hasOwnProperty.call(Store.prototype, name)) {
      throw new Error(`Store.${name} is defined twice`);
    }
    Object.defineProperty(
      Store.prototype,
      name,
      Object.getOwnPropertyDescriptor(Methods.prototype, name),
    );
  }
}

function cloneEmpty() {
  const data = {
    projects: [],
    spaces: [],
    threads: [],
    messagesByThread: {},
    workLogByThread: {},
    usageByThread: {},
    runArtifactsByThread: {},
    rewindRestoreByThread: {},
    workflowRunByThread: {},
    workflowTemplates: [],
    spendByDay: {},
    usageByDay: {},
    usageThreadsByDay: {},
    automations: [],
    tasksByCrew: {},
    digestSeenAt: null,
    // autoSettleAfterDays defaults to 3 (AUTO_SETTLE_AFTER_DAYS); null = disabled.
    settings: {
      dailyBudgetUsd: null,
      orchestrationBudgetUsd: null,
      autoSettleAfterDays: 3,
      mcpServers: [],
      agentProfiles: [],
      subagentPool: { defaultAlias: null, force: false, entries: [] },
    },
  };
  ensureWorkflowTemplates(data);
  return data;
}

module.exports = {
  Store,
  EMPTY,
  DEFAULT_WORKTREE_RETENTION,
  migrateProject,
  migrateThread,
  backfillFromNotice,
  migrateAutomation,
  STANDARD_TEMPLATE,
  cloneStandardTemplate,
  ensureWorkflowTemplates,
  localDayKey,
  pruneSpendByDay,
  normalizeSettings,
  normalizeMcpServers,
  validateMcpServers,
  RESERVED_MCP_NAMES,
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  normalizeSpendByDay,
  normalizeUsageByDay,
  normalizeUsageThreadsByDay,
  emptyUsageCell,
  coerceUsageCell,
  SPEND_RETENTION_DAYS,
  MAX_MESSAGES_PER_THREAD,
  MESSAGE_OVERFLOW_SLACK,
  MAX_WORKLOG_ITEMS_PER_THREAD,
  WORKLOG_OVERFLOW_SLACK,
  SAVE_DEBOUNCE_MS,
  SAVE_DEBOUNCE_MAX_MS,
  ENVELOPE_THROTTLE_MS,
  MAX_HYDRATED_THREADS,
  MAX_HYDRATED_BYTES,
};
