"use strict";

const path = require("node:path");
const {
  collectMessageTexts,
  threadMatches,
  rankSearchHits,
  matchThreadMessages,
  messagesForRow,
  MESSAGE_SEARCH_LIMIT,
} = require("./threadSearch.js");
const { isSafeThreadId } = require("./store-util.js");

/**
 * `notes` plus linked-PR numbers (both "#482" and "482") and titles, so
 * ⌘K / sidebar search match a thread by its PR (issue #1771). Search-only:
 * never written back to the thread.
 * @param {object} thread
 * @returns {string}
 */
function prSearchText(thread) {
  const notes = thread.notes != null ? String(thread.notes) : "";
  const numbers = new Set();
  const addNumber = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) numbers.add(n);
  };
  const titles = [];
  addNumber(thread.prNumber);
  if (thread.prTitle) titles.push(String(thread.prTitle));
  if (Array.isArray(thread.prLinks)) {
    for (const link of thread.prLinks) {
      if (!link || typeof link !== "object") continue;
      addNumber(link.number);
      if (link.title) titles.push(String(link.title));
    }
  }
  if (numbers.size === 0 && titles.length === 0) return notes;
  const bits = [];
  for (const n of numbers) bits.push(`#${n}`, String(n));
  bits.push(...titles);
  return `${notes} ${bits.join(" ")}`.trim();
}

/** Store full-content search methods; store.js copies them onto Store.prototype. */
class StoreSearchMethods {
  /**
   * Snapshot for a worker/inline scan. Copies title/notes and in-memory
   * unsaved text; persisted shards are paths only so the scan does not
   * populate _messagesHydrated.
   * @param {string} needle already lowercased
   * @param {((thread: object) => boolean) | null} [include] scope filter
   *   applied before the scan, so out-of-scope rows never touch the cap
   */
  _buildSearchSnapshot(needle, include) {
    /** @type {object[]} */
    const threads = [];
    for (const thread of this.data.threads) {
      if (!thread || typeof thread !== "object" || thread.id == null) continue;
      if (include && !include(thread)) continue;
      const id = thread.id;
      const row = {
        id,
        title: thread.title != null ? String(thread.title) : "",
        notes: prSearchText(thread),
        updatedAt: Number(thread.updatedAt) || 0,
        liveTexts: null,
        rawJson: null,
        shardPath: null,
      };
      if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, id)) {
        row.liveTexts = collectMessageTexts(this._messagesHydrated[id] || []);
      } else if (this._messagesRaw.has(id)) {
        row.rawJson = this._messagesRaw.get(id);
      } else {
        const r = this._threadRange(id);
        if (r && this._messagesLazy) {
          row.rawJson = this._messagesLazy.raw.slice(r.start, r.end);
        } else if (this._messageShards.has(id) && isSafeThreadId(id)) {
          try {
            row.shardPath = this._messagePath(id);
          } catch {
            // skip unencodable ids; title/notes can still match
          }
        }
      }
      threads.push(row);
    }
    return { needle, threads };
  }

  _cancelSearchWorker() {
    const worker = this._searchWorker;
    this._searchWorker = null;
    if (worker) {
      Promise.resolve(worker.terminate()).catch(() => {});
    }
  }

  /**
   * @param {{ needle: string, threads: object[] }} snapshot
   * @param {number} gen
   * @returns {Promise<{ ids: string[], truncated: boolean }>}
   */
  _runSearchScan(snapshot, gen) {
    const none = { ids: [], truncated: false };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(gen !== this._searchGen ? none : result);
      };
      const SEARCH_INLINE_BATCH = 8;
      const runInline = () => {
        /** @type {Array<{ id: string, updatedAt: number }>} */
        const hits = [];
        let i = 0;
        const step = () => {
          if (gen !== this._searchGen) {
            finish(none);
            return;
          }
          const end = Math.min(i + SEARCH_INLINE_BATCH, snapshot.threads.length);
          for (; i < end; i++) {
            const t = snapshot.threads[i];
            if (threadMatches(t, snapshot.needle)) {
              hits.push({ id: t.id, updatedAt: Number(t.updatedAt) || 0 });
            }
          }
          if (i < snapshot.threads.length) {
            setImmediate(step);
            return;
          }
          finish(rankSearchHits(hits));
        };
        setImmediate(step);
      };
      try {
        const { Worker } = require("node:worker_threads");
        const worker = new Worker(path.join(__dirname, "threadSearch.js"));
        this._searchWorker = worker;
        let usedInline = false;
        worker.once("message", (result) => {
          if (this._searchWorker === worker) this._searchWorker = null;
          Promise.resolve(worker.terminate()).catch(() => {});
          finish(result && Array.isArray(result.ids) ? result : none);
        });
        worker.once("error", () => {
          if (this._searchWorker === worker) this._searchWorker = null;
          usedInline = true;
          runInline();
        });
        worker.once("exit", () => {
          if (this._searchWorker === worker) this._searchWorker = null;
          if (!usedInline) finish(none);
        });
        worker.postMessage(snapshot);
      } catch {
        runInline();
      }
    });
  }

  /**
   * Full-content thread search: titles + notes + message text,
   * case-insensitive substring. Includes archived. Ordered by updatedAt
   * DESC, max SEARCH_LIMIT; truncated says more matched. `include` scopes
   * the scan BEFORE the cap (#1201). Empty / 1-char queries match nothing
   * (renderer only calls with 2+ chars). Scans shards off the main thread
   * and does not hydrate transcripts into _messagesHydrated. A newer call
   * cancels the previous scan (#1122).
   * @param {unknown} query
   * @param {{ include?: (thread: object) => boolean }} [opts]
   * @returns {Promise<{ threads: object[], truncated: boolean }>}
   */
  async searchThreads(query, opts) {
    const raw = query == null ? "" : String(query).trim();
    if (raw.length < 2) return { threads: [], truncated: false };
    const needle = raw.toLowerCase();
    const gen = ++this._searchGen;
    this._cancelSearchWorker();
    const snapshot = this._buildSearchSnapshot(needle, opts && opts.include);
    const { ids, truncated } = await this._runSearchScan(snapshot, gen);
    if (gen !== this._searchGen) return { threads: [], truncated: false };
    const byId = new Map();
    for (const thread of this.data.threads) {
      if (thread && thread.id != null) byId.set(thread.id, thread);
    }
    /** @type {object[]} */
    const hits = [];
    for (const id of ids) {
      const thread = byId.get(id);
      if (thread) hits.push(thread);
    }
    return { threads: hits, truncated };
  }

  /**
   * Snapshot for the message-search scan: same three message sources as
   * _buildSearchSnapshot (live/raw/shard), but no title/notes — message
   * search only looks at message text (#1761).
   * @param {((thread: object) => boolean) | null} [include]
   */
  _buildMessageSearchSnapshot(needle, include) {
    /** @type {object[]} */
    const threads = [];
    for (const thread of this.data.threads) {
      if (!thread || typeof thread !== "object" || thread.id == null) continue;
      if (include && !include(thread)) continue;
      const id = thread.id;
      const row = { id, liveMessages: null, rawJson: null, shardPath: null };
      if (Object.prototype.hasOwnProperty.call(this._messagesHydrated, id)) {
        row.liveMessages = this._messagesHydrated[id] || [];
      } else if (this._messagesRaw.has(id)) {
        row.rawJson = this._messagesRaw.get(id);
      } else {
        const r = this._threadRange(id);
        if (r && this._messagesLazy) {
          row.rawJson = this._messagesLazy.raw.slice(r.start, r.end);
        } else if (this._messageShards.has(id) && isSafeThreadId(id)) {
          try {
            row.shardPath = this._messagePath(id);
          } catch {
            // unencodable id: this thread just contributes no hits
          }
        }
      }
      threads.push(row);
    }
    return { mode: "messages", needle, threads };
  }

  _cancelMessageSearchWorker() {
    const worker = this._messageSearchWorker;
    this._messageSearchWorker = null;
    if (worker) {
      Promise.resolve(worker.terminate()).catch(() => {});
    }
  }

  /**
   * Own worker/generation slot, separate from _runSearchScan: the palette
   * fires searchThreads (thread-kind hits) and searchMessages (message-kind
   * hits) within the same debounce window, and a single shared slot would
   * have the second call cancel the first's in-flight scan (#1761).
   * @param {{ needle: string, threads: object[] }} snapshot
   * @param {number} gen
   * @returns {Promise<{ hits: object[], truncated: boolean }>}
   */
  _runMessageSearchScan(snapshot, gen) {
    const none = { hits: [], truncated: false };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(gen !== this._messageSearchGen ? none : result);
      };
      const SEARCH_INLINE_BATCH = 8;
      const runInline = () => {
        const words = snapshot.needle.split(/\s+/).filter(Boolean);
        /** @type {object[]} */
        const hits = [];
        let i = 0;
        const step = () => {
          if (gen !== this._messageSearchGen) {
            finish(none);
            return;
          }
          const end = Math.min(i + SEARCH_INLINE_BATCH, snapshot.threads.length);
          for (; i < end; i++) {
            const row = snapshot.threads[i];
            const messages = messagesForRow(row);
            for (const hit of matchThreadMessages(row.id, messages, words)) {
              hits.push(hit);
            }
          }
          if (i < snapshot.threads.length) {
            setImmediate(step);
            return;
          }
          hits.sort((a, b) => b.createdAt - a.createdAt);
          finish({
            hits: hits.slice(0, MESSAGE_SEARCH_LIMIT),
            truncated: hits.length > MESSAGE_SEARCH_LIMIT,
          });
        };
        setImmediate(step);
      };
      try {
        const { Worker } = require("node:worker_threads");
        const worker = new Worker(path.join(__dirname, "threadSearch.js"));
        this._messageSearchWorker = worker;
        let usedInline = false;
        worker.once("message", (result) => {
          if (this._messageSearchWorker === worker) this._messageSearchWorker = null;
          Promise.resolve(worker.terminate()).catch(() => {});
          finish(result && Array.isArray(result.hits) ? result : none);
        });
        worker.once("error", () => {
          if (this._messageSearchWorker === worker) this._messageSearchWorker = null;
          usedInline = true;
          runInline();
        });
        worker.once("exit", () => {
          if (this._messageSearchWorker === worker) this._messageSearchWorker = null;
          if (!usedInline) finish(none);
        });
        worker.postMessage(snapshot);
      } catch {
        runInline();
      }
    });
  }

  /**
   * Message-level full-text search (#1761): user + assistant text only
   * (tool/event skipped), case-insensitive, words ANDed. Up to 30 hits
   * newest first, max 3 per thread. `include` scopes the scan BEFORE the
   * cap, same contract as searchThreads. Queries under 3 chars match
   * nothing (the renderer only calls with 3+ chars). Scans shards off the
   * main thread and does not hydrate transcripts into _messagesHydrated.
   * @param {unknown} query
   * @param {{ include?: (thread: object) => boolean }} [opts]
   * @returns {Promise<{ hits: object[], truncated: boolean }>}
   */
  async searchMessages(query, opts) {
    const raw = query == null ? "" : String(query).trim();
    if (raw.length < 3) return { hits: [], truncated: false };
    const needle = raw.toLowerCase();
    const gen = ++this._messageSearchGen;
    this._cancelMessageSearchWorker();
    const snapshot = this._buildMessageSearchSnapshot(needle, opts && opts.include);
    const result = await this._runMessageSearchScan(snapshot, gen);
    if (gen !== this._messageSearchGen) return { hits: [], truncated: false };
    return result;
  }
}

module.exports = StoreSearchMethods;
