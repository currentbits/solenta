"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** Builtin "Plan and Verify" workflow template (seeded on every store). */
const STANDARD_TEMPLATE = {
  id: "standard",
  name: "Plan and Verify",
  builtin: true,
  phases: [
    {
      name: "seed",
      agentCount: 1,
      instruction:
        "Produce a concise plan (max 15 lines) plus key questions.",
      provider: "claude",
      model: null,
    },
    {
      name: "analyze",
      agentCount: 2,
      instruction:
        "Deep-dive the task. Agent focus should diversify: implementation approach versus risks and testing. Max 30 lines.",
      provider: "claude",
      model: null,
    },
    {
      name: "synthesize",
      agentCount: 1,
      instruction:
        "Using the plan and analyses, produce the final self-contained answer to the original task.",
      provider: "claude",
      model: null,
    },
  ],
};

const EMPTY = {
  projects: [],
  threads: [],
  messagesByThread: {},
  workLogByThread: {},
  usageByThread: {},
  workflowTemplates: [],
  spendByDay: {},
  settings: { dailyBudgetUsd: null },
};

const SPEND_RETENTION_DAYS = 90;

/**
 * Local calendar day key YYYY-MM-DD (LOCAL timezone, not UTC).
 * @param {Date} [now]
 * @returns {string}
 */
function localDayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Drop spendByDay keys older than retention days relative to `now`.
 * Mutates the map in place.
 * @param {Record<string, number>} spendByDay
 * @param {Date} [now]
 */
function pruneSpendByDay(spendByDay, now = new Date()) {
  if (!spendByDay || typeof spendByDay !== "object") return;
  const cutoff = new Date(now instanceof Date ? now.getTime() : Date.now());
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - SPEND_RETENTION_DAYS);
  const cutoffKey = localDayKey(cutoff);
  for (const key of Object.keys(spendByDay)) {
    if (typeof key !== "string" || key < cutoffKey) {
      delete spendByDay[key];
    }
  }
}

/**
 * Normalize settings from disk.
 * @param {unknown} raw
 * @returns {{ dailyBudgetUsd: number | null }}
 */
function normalizeSettings(raw) {
  const settings = { dailyBudgetUsd: null };
  if (!raw || typeof raw !== "object") return settings;
  const v = /** @type {{ dailyBudgetUsd?: unknown }} */ (raw).dailyBudgetUsd;
  if (v === null || v === undefined) {
    settings.dailyBudgetUsd = null;
  } else if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    settings.dailyBudgetUsd = v;
  } else {
    settings.dailyBudgetUsd = null;
  }
  return settings;
}

/**
 * Normalize spendByDay map and prune old buckets.
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {Record<string, number>}
 */
function normalizeSpendByDay(raw, now = new Date()) {
  /** @type {Record<string, number>} */
  const map = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === "string" && typeof v === "number" && Number.isFinite(v)) {
        map[k] = v;
      }
    }
  }
  pruneSpendByDay(map, now);
  return map;
}

/**
 * Deep-clone the builtin standard template.
 * @returns {object}
 */
function cloneStandardTemplate() {
  return JSON.parse(JSON.stringify(STANDARD_TEMPLATE));
}

/**
 * @param {unknown} phases
 * @returns {object[]}
 */
function clonePhases(phases) {
  if (!Array.isArray(phases)) return [];
  return JSON.parse(JSON.stringify(phases));
}

/**
 * Ensure workflowTemplates exists and the builtin "standard" template is present.
 * @param {object} data
 */
function ensureWorkflowTemplates(data) {
  if (!Array.isArray(data.workflowTemplates)) {
    data.workflowTemplates = [];
  }
  const hasStandard = data.workflowTemplates.some(
    (t) => t && t.id === "standard",
  );
  if (!hasStandard) {
    data.workflowTemplates.unshift(cloneStandardTemplate());
  }
  // Normalize builtin flag on standard if someone corrupted it.
  for (const t of data.workflowTemplates) {
    if (t && t.id === "standard") {
      t.builtin = true;
      if (!t.name) t.name = STANDARD_TEMPLATE.name;
      if (!Array.isArray(t.phases) || t.phases.length === 0) {
        t.phases = clonePhases(STANDARD_TEMPLATE.phases);
      }
    }
  }
}

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
    model: t.model !== undefined ? t.model : null,
    sessionId: t.sessionId !== undefined ? t.sessionId : null,
    permissionMode: t.permissionMode != null ? t.permissionMode : "default",
    // Older stores lack reasoningEffort; null (not undefined) so the picker is stable.
    reasoningEffort:
      t.reasoningEffort !== undefined ? t.reasoningEffort : null,
    worktreePath: t.worktreePath !== undefined ? t.worktreePath : null,
    runStartedAt: t.runStartedAt !== undefined ? t.runStartedAt : null,
    archived: t.archived != null ? Boolean(t.archived) : false,
    // Older stores may lack PR fields; null (not undefined) so the badge is stable.
    prNumber: t.prNumber !== undefined ? t.prNumber : null,
    prUrl: t.prUrl !== undefined ? t.prUrl : null,
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
        workflowTemplates: Array.isArray(parsed.workflowTemplates)
          ? parsed.workflowTemplates
          : [],
        spendByDay: normalizeSpendByDay(parsed.spendByDay),
        settings: normalizeSettings(parsed.settings),
      };
      ensureWorkflowTemplates(data);
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
   * Add a cost delta to today's local-day spend bucket.
   * Zero/negative/non-finite deltas are ignored.
   * @param {number} deltaUsd
   * @param {Date} [now] - injectable clock for tests
   */
  recordSpend(deltaUsd, now = new Date()) {
    const n = Number(deltaUsd);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this.data.spendByDay || typeof this.data.spendByDay !== "object") {
      this.data.spendByDay = {};
    }
    const key = localDayKey(now);
    this.data.spendByDay[key] = (Number(this.data.spendByDay[key]) || 0) + n;
  }

  /**
   * @param {Date} [now]
   * @returns {number}
   */
  getSpendToday(now = new Date()) {
    if (!this.data.spendByDay || typeof this.data.spendByDay !== "object") {
      return 0;
    }
    const key = localDayKey(now);
    const v = this.data.spendByDay[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }

  /**
   * @returns {{ dailyBudgetUsd: number | null }}
   */
  getSettings() {
    if (!this.data.settings || typeof this.data.settings !== "object") {
      this.data.settings = { dailyBudgetUsd: null };
    }
    return {
      dailyBudgetUsd:
        this.data.settings.dailyBudgetUsd == null
          ? null
          : this.data.settings.dailyBudgetUsd,
    };
  }

  /**
   * Validate and merge settings. Does not touch threads.
   * Does not save; caller must save.
   * @param {Partial<{ dailyBudgetUsd: number | null }>} patch
   * @returns {{ dailyBudgetUsd: number | null }}
   */
  setSettings(patch) {
    if (!patch || typeof patch !== "object") {
      return this.getSettings();
    }
    if (Object.prototype.hasOwnProperty.call(patch, "dailyBudgetUsd")) {
      const v = patch.dailyBudgetUsd;
      if (v !== null) {
        if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) {
          throw new Error(
            "Daily budget must be a positive number or null",
          );
        }
      }
      if (!this.data.settings || typeof this.data.settings !== "object") {
        this.data.settings = { dailyBudgetUsd: null };
      }
      this.data.settings.dailyBudgetUsd = v === null ? null : v;
    }
    return this.getSettings();
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
   * Full-content thread search: titles + message text, case-insensitive
   * substring. Includes archived. Ordered by updatedAt DESC, max 50.
   * Empty / 1-char queries return [] (renderer only calls with 2+ chars).
   * @param {unknown} query
   * @returns {object[]}
   */
  searchThreads(query) {
    const raw = query == null ? "" : String(query).trim();
    if (raw.length < 2) return [];
    const needle = raw.toLowerCase();
    /** @type {object[]} */
    const hits = [];
    for (const thread of this.data.threads) {
      if (!thread || typeof thread !== "object") continue;
      let match = false;
      if (
        thread.title != null &&
        String(thread.title).toLowerCase().includes(needle)
      ) {
        match = true;
      }
      if (!match) {
        const msgs = this.data.messagesByThread[thread.id];
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            if (
              m &&
              m.text != null &&
              String(m.text).toLowerCase().includes(needle)
            ) {
              match = true;
              break;
            }
          }
        }
      }
      if (match) hits.push(thread);
    }
    hits.sort(
      (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0),
    );
    return hits.slice(0, 50);
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

  /**
   * @returns {object[]} deep clones of all workflow templates
   */
  listTemplates() {
    ensureWorkflowTemplates(this.data);
    return this.data.workflowTemplates.map((t) =>
      JSON.parse(JSON.stringify(t)),
    );
  }

  /**
   * Get one template by id (deep clone), or null.
   * @param {string} id
   */
  getTemplate(id) {
    ensureWorkflowTemplates(this.data);
    const t = this.data.workflowTemplates.find((x) => x && x.id === id);
    return t ? JSON.parse(JSON.stringify(t)) : null;
  }

  /**
   * Save a workflow template.
   * - No id: create with a new uuid, builtin false.
   * - Builtin id: create a COPY (new id, builtin false); name gets " (copy)"
   *   unless the caller supplied a different name from the builtin.
   * - Non-builtin id that exists: update in place.
   * - Unknown non-builtin id: create with that id.
   * Does not validate phase contents; services layer owns validation.
   * Does not save to disk; caller must save.
   *
   * @param {{ id?: string, name: string, phases: object[], builtin?: boolean }} template
   * @returns {object} the saved template (deep clone)
   */
  saveTemplate(template) {
    ensureWorkflowTemplates(this.data);
    if (!template || typeof template !== "object") {
      throw new Error("template is required");
    }
    const name = template.name != null ? String(template.name) : "";
    const phases = clonePhases(template.phases);
    const list = this.data.workflowTemplates;

    if (template.id == null || template.id === "") {
      const created = {
        id: randomUUID(),
        name,
        builtin: false,
        phases,
      };
      list.push(created);
      return JSON.parse(JSON.stringify(created));
    }

    const id = String(template.id);
    const existing = list.find((t) => t && t.id === id);

    if (existing && existing.builtin) {
      const renamed =
        name.length > 0 && name !== String(existing.name || "");
      const copy = {
        id: randomUUID(),
        name: renamed ? name : `${existing.name} (copy)`,
        builtin: false,
        phases: phases.length > 0 ? phases : clonePhases(existing.phases),
      };
      list.push(copy);
      return JSON.parse(JSON.stringify(copy));
    }

    if (existing) {
      existing.name = name;
      existing.phases = phases;
      existing.builtin = false;
      return JSON.parse(JSON.stringify(existing));
    }

    const created = {
      id,
      name,
      builtin: false,
      phases,
    };
    list.push(created);
    return JSON.parse(JSON.stringify(created));
  }

  /**
   * Remove a non-builtin template. Rejects builtin templates.
   * Does not save; caller must save.
   * @param {string} id
   */
  removeTemplate(id) {
    ensureWorkflowTemplates(this.data);
    const tid = String(id);
    const existing = this.data.workflowTemplates.find(
      (t) => t && t.id === tid,
    );
    if (!existing) {
      throw new Error(`Unknown template: ${tid}`);
    }
    if (existing.builtin) {
      throw new Error(`Cannot remove builtin template: ${tid}`);
    }
    this.data.workflowTemplates = this.data.workflowTemplates.filter(
      (t) => !t || t.id !== tid,
    );
  }
}

function cloneEmpty() {
  const data = {
    projects: [],
    threads: [],
    messagesByThread: {},
    workLogByThread: {},
    usageByThread: {},
    workflowTemplates: [],
    spendByDay: {},
    settings: { dailyBudgetUsd: null },
  };
  ensureWorkflowTemplates(data);
  return data;
}

module.exports = {
  Store,
  EMPTY,
  migrateThread,
  STANDARD_TEMPLATE,
  cloneStandardTemplate,
  ensureWorkflowTemplates,
  localDayKey,
  pruneSpendByDay,
  normalizeSettings,
  normalizeSpendByDay,
  SPEND_RETENTION_DAYS,
};
