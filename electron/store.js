"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EMPTY = {
  projects: [],
  threads: [],
  messagesByThread: {},
  workLogByThread: {},
};

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
      return {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        threads: Array.isArray(parsed.threads) ? parsed.threads : [],
        messagesByThread:
          parsed.messagesByThread && typeof parsed.messagesByThread === "object"
            ? parsed.messagesByThread
            : {},
        workLogByThread:
          parsed.workLogByThread && typeof parsed.workLogByThread === "object"
            ? parsed.workLogByThread
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
    this.data.threads = threads;
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
  };
}

module.exports = { Store, EMPTY };
