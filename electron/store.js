"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EMPTY = {
  projects: [],
  threads: [],
  messagesByThread: {},
  workLogByThread: {},
  usageByThread: {},
};

/**
 * Migrate a persisted thread missing the newer session fields.
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
  };
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
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return cloneEmpty();
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const threads = Array.isArray(parsed.threads)
        ? parsed.threads.map(migrateThread)
        : [];
      return {
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

  appendMessage(threadId, message) {
    const list = this.getMessages(threadId).slice();
    list.push(message);
    this.setMessages(threadId, list);
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

  updateThread(threadId, patch) {
    const threads = this.data.threads.map((t) =>
      t.id === threadId ? { ...t, ...patch, updatedAt: Date.now() } : t,
    );
    this.data.threads = threads;
    return threads.find((t) => t.id === threadId) || null;
  }

  getThread(threadId) {
    return this.data.threads.find((t) => t.id === threadId) || null;
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
