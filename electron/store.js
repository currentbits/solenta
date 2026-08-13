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
  automations: [],
  // autoSettleAfterDays defaults to 3 (AUTO_SETTLE_AFTER_DAYS); null = disabled.
  settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3, mcpServers: [] },
};

/** User MCP server names: lowercase slug, same rule as skill names. */
const MCP_SERVER_NAME_RE = /^[a-z0-9-]+$/;

/** Built-in servers owned by the app; user entries may never use these. */
const RESERVED_MCP_NAMES = new Set(["coder-memory", "coder-threads"]);

/**
 * @param {unknown} u
 * @returns {boolean}
 */
function isHttpUrl(u) {
  if (typeof u !== "string" || !u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Lenient normalization for values read from disk: drops invalid entries,
 * coerces enabled (default true), dedupes by name. Never throws.
 * @param {unknown} raw
 * @returns {Array<{ name: string, url: string, token?: string, enabled: boolean }>}
 */
function normalizeMcpServers(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ name: string, url: string, token?: string, enabled: boolean }>} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name =
      typeof item.name === "string" ? item.name.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!MCP_SERVER_NAME_RE.test(name) || RESERVED_MCP_NAMES.has(name)) {
      continue;
    }
    if (!isHttpUrl(url) || seen.has(name)) continue;
    seen.add(name);
    const entry = { name, url, enabled: item.enabled !== false };
    if (typeof item.token === "string" && item.token) {
      entry.token = item.token;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Strict validation for settings:set patches: throws on the first problem so
 * the UI can show why a server list was refused.
 * @param {unknown} raw
 * @returns {Array<{ name: string, url: string, token?: string, enabled: boolean }>}
 */
function validateMcpServers(raw) {
  if (!Array.isArray(raw)) {
    throw new Error("mcpServers must be an array");
  }
  const seen = new Set();
  return raw.map((item) => {
    const name =
      item && typeof item.name === "string" ? item.name.trim() : "";
    if (!MCP_SERVER_NAME_RE.test(name)) {
      throw new Error(
        `MCP server name must be lowercase letters, digits, dashes (got "${name}")`,
      );
    }
    if (RESERVED_MCP_NAMES.has(name)) {
      throw new Error(
        `MCP server name "${name}" is reserved for a built-in server`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate MCP server name: ${name}`);
    }
    seen.add(name);
    const url = item && typeof item.url === "string" ? item.url.trim() : "";
    if (!isHttpUrl(url)) {
      throw new Error(`MCP server URL must be http(s) (got "${url}")`);
    }
    const entry = { name, url, enabled: item.enabled !== false };
    if (item.token !== undefined && item.token !== null) {
      if (typeof item.token !== "string") {
        throw new Error("MCP server token must be a string");
      }
      if (item.token) entry.token = item.token;
    }
    return entry;
  });
}

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
 * Default inactivity window (days). Must match src/threadSettle.ts
 * AUTO_SETTLE_AFTER_DAYS — old stores without the key heal here so null
 * remains "user disabled" and is never confused with "never configured".
 */
const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 3;

/**
 * Normalize settings from disk.
 *
 * autoSettleAfterDays tri-state at the store boundary:
 *   - key ABSENT on old stores → DEFAULT (3)  (contract: missing = constant)
 *   - null                      → null         (user disabled inactivity path)
 *   - positive integer          → kept
 *   - junk on disk              → DEFAULT (3)  (heal; setSettings rejects junk)
 *
 * dailyBudgetUsd still collapses absent/junk → null (no-cap).
 *
 * mcpServers: absent/junk → []; entries are healed entry-by-entry
 * (normalizeMcpServers), never throwing on a corrupt store.
 *
 * defaultWorktree: absent/junk → false (new threads run in the checkout
 * unless the user opts in).
 *
 * @param {unknown} raw
 * @returns {{ dailyBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean }}
 */
function normalizeSettings(raw) {
  const settings = {
    dailyBudgetUsd: null,
    autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
    mcpServers: [],
    defaultWorktree: false,
  };
  if (!raw || typeof raw !== "object") return settings;
  const obj = /** @type {{ dailyBudgetUsd?: unknown, autoSettleAfterDays?: unknown, mcpServers?: unknown }} */ (
    raw
  );
  const v = obj.dailyBudgetUsd;
  if (v === null || v === undefined) {
    settings.dailyBudgetUsd = null;
  } else if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    settings.dailyBudgetUsd = v;
  } else {
    settings.dailyBudgetUsd = null;
  }

  if (Object.prototype.hasOwnProperty.call(obj, "autoSettleAfterDays")) {
    const d = obj.autoSettleAfterDays;
    if (d === null) {
      settings.autoSettleAfterDays = null;
    } else if (
      typeof d === "number" &&
      Number.isFinite(d) &&
      Number.isInteger(d) &&
      d > 0
    ) {
      settings.autoSettleAfterDays = d;
    } else {
      // Junk on disk (string, 0, 1.5, NaN): heal to default, not null.
      settings.autoSettleAfterDays = DEFAULT_AUTO_SETTLE_AFTER_DAYS;
    }
  }
  // key absent → leave default 3

  settings.mcpServers = normalizeMcpServers(obj.mcpServers);
  settings.defaultWorktree =
    /** @type {{ defaultWorktree?: unknown }} */ (obj).defaultWorktree === true;
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
/**
 * Kimi model ids shipped briefly as bare config values ("k3"), but -m only
 * accepts the [models."..."] alias keys ("kimi-code/k3"); bare ids fail every
 * run with config.invalid. Prefix exactly the four ids we shipped — a custom
 * id the user typed is theirs to own.
 */
const BARE_KIMI_MODELS = new Set([
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
]);

function migrateKimiModel(t) {
  if (t.provider !== "kimi") return t.model !== undefined ? t.model : null;
  return typeof t.model === "string" && BARE_KIMI_MODELS.has(t.model)
    ? `kimi-code/${t.model}`
    : t.model !== undefined
      ? t.model
      : null;
}

/** Template phases carry {provider, model} and break the same way. */
function migrateTemplateKimiModels(tpl) {
  if (!tpl || !Array.isArray(tpl.phases)) return tpl;
  return {
    ...tpl,
    phases: tpl.phases.map((p) =>
      p &&
      p.provider === "kimi" &&
      typeof p.model === "string" &&
      BARE_KIMI_MODELS.has(p.model)
        ? { ...p, model: `kimi-code/${p.model}` }
        : p,
    ),
  };
}

/**
 * Normalize a persisted automation. Old stores lack the slice entirely
 * (defaulted to [] on load). A partial row heals missing fields so the
 * scheduler never sees undefined lastRunAt / nextRunAt.
 * @param {object} a
 */
function migrateAutomation(a) {
  if (!a || typeof a !== "object") return a;
  const preset =
    a.preset === "daily" || a.preset === "weekly" || a.preset === "hourly"
      ? a.preset
      : "hourly";
  let hour = null;
  if (preset !== "hourly") {
    hour =
      typeof a.hour === "number" &&
      Number.isInteger(a.hour) &&
      a.hour >= 0 &&
      a.hour <= 23
        ? a.hour
        : 0;
  }
  return {
    ...a,
    provider: a.provider != null ? a.provider : "claude",
    model: a.model !== undefined ? a.model : null,
    preset,
    hour,
    enabled: a.enabled != null ? Boolean(a.enabled) : true,
    lastRunAt: a.lastRunAt !== undefined ? a.lastRunAt : null,
    nextRunAt:
      typeof a.nextRunAt === "number" && Number.isFinite(a.nextRunAt)
        ? a.nextRunAt
        : 0,
    lastError: a.lastError !== undefined ? a.lastError : null,
  };
}

/**
 * Projects: remoteHost/remotePath stay absent on old rows. Empty strings
 * (or other junk) are dropped so the keys remain optional, not null.
 * @param {object} p
 */
function migrateProject(p) {
  if (!p || typeof p !== "object") return p;
  const next = { ...p };
  const host = typeof next.remoteHost === "string" ? next.remoteHost.trim() : "";
  const remotePath =
    typeof next.remotePath === "string" ? next.remotePath.trim() : "";
  if (host) next.remoteHost = host;
  else delete next.remoteHost;
  if (remotePath) next.remotePath = remotePath;
  else delete next.remotePath;
  return next;
}

function migrateThread(t) {
  if (!t || typeof t !== "object") return t;
  return {
    ...t,
    provider: t.provider != null ? t.provider : "claude",
    model: migrateKimiModel(t),
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
    // Round 39 settle lifecycle: null (not undefined) so resolution is stable.
    settledOverride:
      t.settledOverride !== undefined ? t.settledOverride : null,
    settledAt: t.settledAt !== undefined ? t.settledAt : null,
    prState: t.prState !== undefined ? t.prState : null,
    // Round 43 unread: null = legacy (renderer treats as visited so upgrades
    // do not light up every old thread). Visiting is stamped in threads.get.
    lastVisitedAt: t.lastVisitedAt !== undefined ? t.lastVisitedAt : null,
    // Round 44 pin + snooze: null = unpinned / not snoozed.
    pinnedAt: t.pinnedAt !== undefined ? t.pinnedAt : null,
    snoozedUntil: t.snoozedUntil !== undefined ? t.snoozedUntil : null,
    snoozedAt: t.snoozedAt !== undefined ? t.snoozedAt : null,
    // Round 49 fork/hand-off: null = not a fork (provenance only).
    handoffFrom: t.handoffFrom !== undefined ? t.handoffFrom : null,
  };
}

/**
 * CRASH / force-quit path only: threads still "working" on disk when the
 * process loads mean the previous process died mid-run (clean quits mark idle
 * via runner.stopAll first). A crash IS a failure of the run — stamp failed.
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
      text: "Run interrupted: the app crashed or was force-quit mid-run",
      createdAt: Date.now(),
    });
    data.messagesByThread[t.id] = list;
    recovered = true;
  }
  return recovered;
}

/**
 * JSON persistence for Solenta main-process state.
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
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.map(migrateProject)
          : [],
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
          ? parsed.workflowTemplates.map(migrateTemplateKimiModels)
          : [],
        spendByDay: normalizeSpendByDay(parsed.spendByDay),
        automations: Array.isArray(parsed.automations)
          ? parsed.automations.map(migrateAutomation)
          : [],
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
    this.data.projects = (projects || []).map(migrateProject);
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
   * @returns {{ dailyBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean }}
   */
  getSettings() {
    if (!this.data.settings || typeof this.data.settings !== "object") {
      this.data.settings = {
        dailyBudgetUsd: null,
        autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
        mcpServers: [],
      };
    }
    // Re-normalize so a partial in-memory shape still exposes every key.
    const n = normalizeSettings(this.data.settings);
    this.data.settings = n;
    return {
      dailyBudgetUsd: n.dailyBudgetUsd,
      autoSettleAfterDays: n.autoSettleAfterDays,
      mcpServers: n.mcpServers,
      defaultWorktree: n.defaultWorktree,
    };
  }

  /**
   * Validate and merge settings. Does not touch threads.
   * Does not save; caller must save.
   * @param {Partial<{ dailyBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean }>} patch
   * @returns {{ dailyBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean }}
   */
  setSettings(patch) {
    if (!patch || typeof patch !== "object") {
      return this.getSettings();
    }
    if (!this.data.settings || typeof this.data.settings !== "object") {
      this.data.settings = {
        dailyBudgetUsd: null,
        autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
        mcpServers: [],
      };
    }
    // Ensure both keys exist before partial patch.
    this.data.settings = normalizeSettings(this.data.settings);

    if (Object.prototype.hasOwnProperty.call(patch, "dailyBudgetUsd")) {
      const v = patch.dailyBudgetUsd;
      if (v !== null) {
        if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) {
          throw new Error(
            "Daily budget must be a positive number or null",
          );
        }
      }
      this.data.settings.dailyBudgetUsd = v === null ? null : v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoSettleAfterDays")) {
      const v = patch.autoSettleAfterDays;
      if (v !== null) {
        // Positive integer only (reject 0, negatives, fractions, NaN, strings).
        if (
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          !Number.isInteger(v) ||
          !(v > 0)
        ) {
          throw new Error(
            `Auto-settle days must be a positive integer or null (got ${String(v)})`,
          );
        }
      }
      this.data.settings.autoSettleAfterDays = v === null ? null : v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "mcpServers")) {
      this.data.settings.mcpServers = validateMcpServers(patch.mcpServers);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "defaultWorktree")) {
      const v = patch.defaultWorktree;
      if (typeof v !== "boolean") {
        throw new Error("defaultWorktree must be a boolean");
      }
      this.data.settings.defaultWorktree = v;
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
    automations: [],
    // autoSettleAfterDays defaults to 3 (AUTO_SETTLE_AFTER_DAYS); null = disabled.
  settings: { dailyBudgetUsd: null, autoSettleAfterDays: 3, mcpServers: [] },
  };
  ensureWorkflowTemplates(data);
  return data;
}

module.exports = {
  Store,
  EMPTY,
  migrateProject,
  migrateThread,
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
  SPEND_RETENTION_DAYS,
};
