"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const EMPTY = {
  projects: [],
  threads: [],
  messagesByThread: {},
  workLogByThread: {},
  usageByThread: {},
};

/**
 * Migrate a persisted thread missing the newer session fields.
 * Does not change updatedAt.
 * @param {object} t
 */
function migrateThread(t) {
  if (!t || typeof t !== "object") return t;
  return {
    ...t,
    provider: t.provider != null ? t.provider : "claude",
    sessionId: t.sessionId !== undefined ? t.sessionId : null,
    permissionMode: t.permissionMode != null ? t.permissionMode : "default",
    worktreePath: t.worktreePath !== undefined ? t.worktreePath : null,
    runStartedAt: t.runStartedAt !== undefined ? t.runStartedAt : null,
    archived: t.archived != null ? Boolean(t.archived) : false,
  };
}

/**
 * Threads left "working" when the app died mid-run become failed with an event.
 * Status change is real activity, so updatedAt is bumped.
 * @param {object} data
 * @returns {boolean} true if any thread was recovered
 */
function recoverInterruptedRuns(data) {
  let recovered = false;
  for (const t of data.threads) {
    if (t.status !== "working") continue;
    t.status = "failed";
    t.runStartedAt = null;
    t.updatedAt = Date.now();
    const list = Array.isArray(data.messagesByThread[t.id])
      ? data.messagesByThread[t.id].slice()
      : [];
    list.push({
      id: randomUUID(),
      role: "event",
      text: "Run interrupted by app restart",
      createdAt: Date.now(),
    });
    data.messagesByThread[t.id] = list;
    recovered = true;
  }
  return recovered;
}

/**
 * JSON persistence for Coder main-process state.
 * Constructor takes a file path; load on start; tolerate missing/corrupt.
 * Atomic-ish save: write tmp then rename.
 */
class Store {
  /**
   * @param {string} filePath
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
    if (this._recoveredOnLoad) {
      this.save();
    }
  }

  _load() {
    this._recoveredOnLoad = false;
    try {
      if (!fs.existsSync(this.filePath)) {
        return cloneEmpty();
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.map(migrateThread)
        : [];
      const data = {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        threads,
        messagesByThread:
          parsed.messagesByThread && typeof parsed.messagesByThread === "object"
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
      };
      this._recoveredOnLoad = recoverInterruptedRuns(data);
      return data;
    } catch {
      return cloneEmpty();
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  getProjects() {
    return this.data.projects;
  }

  setProjects(projects) {
    this.data.projects = projects;
  }

  getThreads() {
    return this.data.threads;
  }

  setThreads(threads) {
    this.data.threads = threads.map(migrateThread);
  }

  getMessages(threadId) {
    return this.data.messagesByThread[threadId] || [];
  }

  setMessages(threadId, messages) {
    this.data.messagesByThread[threadId] = messages;
  }

  /**
   * Append a message and bump the owning thread's updatedAt (real activity).
   * @param {string} threadId
   * @param {object} message
   */
  appendMessage(threadId, message) {
    const list = this.getMessages(threadId).slice();
    list.push(message);
    this.setMessages(threadId, list);
    this.updateThread(threadId, {}, { touch: true });
  }

  getWorkLog(threadId) {
    return this.data.workLogByThread[threadId] || [];
  }

  setWorkLog(threadId, items) {
    this.data.workLogByThread[threadId] = items;
  }

  appendWorkLog(threadId, item) {
    const list = this.getWorkLog(threadId).slice();
    list.push(item);
    this.setWorkLog(threadId, list);
  }

  /**
   * @param {string} threadId
   * @returns {{ model: string | null, inputTokens: number, outputTokens: number, costUsd: number, turns: number } | null}
   */
  getUsage(threadId) {
    return this.data.usageByThread[threadId] || null;
  }

  /**
   * @param {string} threadId
   * @param {object | null} usage
   */
  setUsage(threadId, usage) {
    if (usage == null) {
      delete this.data.usageByThread[threadId];
    } else {
      this.data.usageByThread[threadId] = usage;
    }
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
    list[idx] = { ...list[idx], ...patch };
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
      if (touch) {
        return { ...t, ...patch, updatedAt: Date.now() };
      }
      return { ...t, ...patch };
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
    return this.data.threads.length < before;
  }

  getProject(projectId) {
    return this.data.projects.find((p) => p.id === projectId) || null;
  }
}

function cloneEmpty() {
  return {
    projects: [],
    threads: [],
    messagesByThread: {},
    workLogByThread: {},
    usageByThread: {},
  };
}

module.exports = { Store, EMPTY, migrateThread };
