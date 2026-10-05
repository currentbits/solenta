"use strict";

const path = require("node:path");
const {
  collectMessageTexts,
  threadMatches,
  rankSearchHits,
} = require("./threadSearch.js");
const { isSafeThreadId } = require("./store-util.js");

/** Store full-content search methods; store.js copies them onto Store.prototype. */
class StoreSearchMethods {
  /**
   * Snapshot for a worker/inline scan. Copies title/notes and in-memory
   * unsaved text; persisted shards are paths only so the scan does not
   * populate _messagesHydrated.
   * @param {string} needle already lowercased
   */
  _buildSearchSnapshot(needle) {
    /** @type {object[]} */
    const threads = [];
    for (const thread of this.data.threads) {
      if (!thread || typeof thread !== "object" || thread.id == null) continue;
      const id = thread.id;
      const row = {
        id,
        title: thread.title != null ? String(thread.title) : "",
        notes: thread.notes != null ? String(thread.notes) : "",
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
   * @returns {Promise<string[]>}
   */
  _runSearchScan(snapshot, gen) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ids) => {
        if (settled) return;
        settled = true;
        resolve(gen !== this._searchGen ? [] : ids);
      };
      const SEARCH_INLINE_BATCH = 8;
      const runInline = () => {
        /** @type {Array<{ id: string, updatedAt: number }>} */
        const hits = [];
        let i = 0;
        const step = () => {
          if (gen !== this._searchGen) {
            finish([]);
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
        worker.once("message", (ids) => {
          if (this._searchWorker === worker) this._searchWorker = null;
          Promise.resolve(worker.terminate()).catch(() => {});
          finish(Array.isArray(ids) ? ids : []);
        });
        worker.once("error", () => {
          if (this._searchWorker === worker) this._searchWorker = null;
          usedInline = true;
          runInline();
        });
        worker.once("exit", () => {
          if (this._searchWorker === worker) this._searchWorker = null;
          if (!usedInline) finish([]);
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
   * DESC, max 50. Empty / 1-char queries return [] (renderer only calls
   * with 2+ chars). Scans shards off the main thread and does not hydrate
   * transcripts into _messagesHydrated. A newer call cancels the previous
   * scan (#1122).
   * @param {unknown} query
   * @returns {Promise<object[]>}
   */
  async searchThreads(query) {
    const raw = query == null ? "" : String(query).trim();
    if (raw.length < 2) return [];
    const needle = raw.toLowerCase();
    const gen = ++this._searchGen;
    this._cancelSearchWorker();
    const snapshot = this._buildSearchSnapshot(needle);
    const ids = await this._runSearchScan(snapshot, gen);
    if (gen !== this._searchGen) return [];
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
    return hits;
  }
}

module.exports = StoreSearchMethods;
