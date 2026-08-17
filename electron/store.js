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
  spaces: [],
  threads: [],
  messagesByThread: {},
  workLogByThread: {},
  usageByThread: {},
  workflowTemplates: [],
  spendByDay: {},
  usageByDay: {},
  automations: [],
  digestSeenAt: null,
  // autoSettleAfterDays defaults to 3 (AUTO_SETTLE_AFTER_DAYS); null = disabled.
  settings: {
    dailyBudgetUsd: null,
    orchestrationBudgetUsd: null,
    autoSettleAfterDays: 3,
    mcpServers: [],
    agentProfiles: [],
  },
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

/** ReasoningEffort in src/shared/ipc.ts. Keep in lockstep. */
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** PermissionMode in src/shared/ipc.ts. Keep in lockstep. */
const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/**
 * Parse one AgentProfile. Lenient path returns null; strict throws.
 * @param {unknown} item
 * @param {boolean} strict
 * @returns {{ id: string, name: string, provider: string, model: string | null, reasoningEffort: string | null, permissionMode: string } | null}
 */
function parseAgentProfile(item, strict) {
  const fail = (msg) => {
    if (strict) throw new Error(msg);
    return null;
  };
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return fail("agentProfiles entry must be a plain object");
  }
  const rec = /** @type {Record<string, unknown>} */ (item);
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return fail("agentProfiles entry id must be a non-empty string");
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) return fail("agentProfiles entry name must be a non-empty string");
  if (name.length > 40) {
    return fail("agentProfiles entry name must be at most 40 characters");
  }
  const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
  if (!provider) {
    return fail("agentProfiles entry provider must be a non-empty string");
  }
  const model = rec.model;
  if (model !== null && typeof model !== "string") {
    return fail("agentProfiles entry model must be a string or null");
  }
  const effort = rec.reasoningEffort;
  if (effort !== null && !REASONING_EFFORTS.has(effort)) {
    return fail(
      "agentProfiles entry reasoningEffort must be one of low, medium, high, xhigh, max, or null",
    );
  }
  const permissionMode = rec.permissionMode;
  if (!PERMISSION_MODES.has(permissionMode)) {
    return fail(
      "agentProfiles entry permissionMode must be one of default, acceptEdits, plan, bypassPermissions",
    );
  }
  return {
    id,
    name,
    provider,
    model,
    reasoningEffort: /** @type {string | null} */ (effort),
    permissionMode: /** @type {string} */ (permissionMode),
  };
}

/**
 * Lenient normalization for values read from disk: drops invalid entries,
 * dedupes by id. Never throws.
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, provider: string, model: string | null, reasoningEffort: string | null, permissionMode: string }>}
 */
function normalizeAgentProfiles(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ id: string, name: string, provider: string, model: string | null, reasoningEffort: string | null, permissionMode: string }>} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const entry = parseAgentProfile(item, false);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/**
 * Strict validation for settings:set patches: throws on the first problem.
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string, provider: string, model: string | null, reasoningEffort: string | null, permissionMode: string }>}
 */
function validateAgentProfiles(raw) {
  if (!Array.isArray(raw)) {
    throw new Error("agentProfiles must be an array");
  }
  const seen = new Set();
  return raw.map((item) => {
    const entry = parseAgentProfile(item, true);
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate agentProfiles id: ${entry.id}`);
    }
    seen.add(entry.id);
    return entry;
  });
}

const SPEND_RETENTION_DAYS = 90;

// Longest a save() may sit in memory before it hits disk, when idle.
const SAVE_DEBOUNCE_MS = 250;
// Under sustained save() (N streaming threads), double the delay each
// dirty flush up to this cap so we do not stringify the whole store at 4 Hz.
const SAVE_DEBOUNCE_MAX_MS = 2000;

/**
 * Per-thread transcript retention (issue #89). Threads never shrank, so a few
 * heavy long-lived threads grew the one-JSON-blob store to megabytes and every
 * debounced flush re-stringified all of it on the main process. Appends may
 * overshoot the cap by the slack; crossing cap + slack drops the oldest
 * entries back to the cap. The slack keeps the drop (which shifts every index,
 * invalidates the runner's prefix diff and forces one full transcript push)
 * amortized over ~slack appends instead of every append.
 */
const MAX_MESSAGES_PER_THREAD = 1000;
const MESSAGE_OVERFLOW_SLACK = 100;
const MAX_WORKLOG_ITEMS_PER_THREAD = 500;
const WORKLOG_OVERFLOW_SLACK = 50;

/**
 * Bound a per-thread list to its retention cap, dropping the oldest entries
 * on overflow. Message lists get an event marker in the oldest kept slot so
 * the gap is visible in the transcript instead of silent.
 * @param {unknown} list
 * @param {number} max
 * @param {number} slack
 * @param {string | null} markerText
 * @returns {object[]}
 */
function capList(list, max, slack, markerText) {
  if (!Array.isArray(list)) return [];
  if (list.length <= max + slack) return list;
  const kept = list.slice(-max);
  if (markerText) {
    const first = kept[0] && typeof kept[0] === "object" ? kept[0] : {};
    kept[0] = {
      id: typeof first.id === "string" ? first.id : randomUUID(),
      role: "event",
      text: markerText,
      createdAt: Number(first.createdAt) || Date.now(),
    };
  }
  return kept;
}

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
 * Drop day-keyed map entries older than retention days relative to `now`.
 * Shared by spendByDay and usageByDay so the cutoff maths lives in one place.
 * Mutates the map in place.
 * @param {Record<string, unknown>} spendByDay
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
 * dailyBudgetUsd and orchestrationBudgetUsd still collapse absent/junk →
 * null (no-cap).
 *
 * mcpServers: absent/junk → []; entries are healed entry-by-entry
 * (normalizeMcpServers), never throwing on a corrupt store.
 *
 * agentProfiles: absent/junk/non-array → []; entries are healed
 * entry-by-entry (normalizeAgentProfiles), never throwing on a corrupt store.
 *
 * defaultWorktree: absent/junk → false (new threads run in the checkout
 * unless the user opts in).
 *
 * defaultOrchestrate: absent/junk → false (plain "New thread" is not an
 * orchestrator unless the user opts in).
 *
 * updateChannel: absent/junk → null (follow the channel stamped at package
 * time); "prod"/"nightly" override the stamp.
 *
 * notifications: only an explicit false turns desktop notifications off, so
 * absent/junk keeps the pre-setting behaviour (notify).
 *
 * @param {unknown} raw
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean, updateChannel: "prod" | "nightly" | null, notifications: boolean, agentProfiles: Array<{ id: string, name: string, provider: string, model: string | null, reasoningEffort: string | null, permissionMode: string }> }}
 */
function normalizeSettings(raw) {
  const settings = {
    dailyBudgetUsd: null,
    orchestrationBudgetUsd: null,
    autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
    mcpServers: [],
    defaultWorktree: false,
    defaultOrchestrate: false,
    updateChannel: null,
    notifications: true,
    agentProfiles: [],
  };
  if (!raw || typeof raw !== "object") return settings;
  const obj = /** @type {{ dailyBudgetUsd?: unknown, orchestrationBudgetUsd?: unknown, autoSettleAfterDays?: unknown, mcpServers?: unknown }} */ (
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

  const ov = obj.orchestrationBudgetUsd;
  if (typeof ov === "number" && Number.isFinite(ov) && ov > 0) {
    settings.orchestrationBudgetUsd = ov;
  } else {
    settings.orchestrationBudgetUsd = null;
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
  settings.agentProfiles = normalizeAgentProfiles(
    /** @type {{ agentProfiles?: unknown }} */ (obj).agentProfiles,
  );
  settings.defaultWorktree =
    /** @type {{ defaultWorktree?: unknown }} */ (obj).defaultWorktree === true;
  settings.defaultOrchestrate =
    /** @type {{ defaultOrchestrate?: unknown }} */ (obj).defaultOrchestrate ===
    true;
  const ch = /** @type {{ updateChannel?: unknown }} */ (obj).updateChannel;
  settings.updateChannel = ch === "prod" || ch === "nightly" ? ch : null;
  settings.notifications =
    /** @type {{ notifications?: unknown }} */ (obj).notifications !== false;
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
 * @param {unknown} n
 * @returns {number}
 */
function coerceFiniteNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Normalize usageByDay map and prune old buckets.
 * day -> provider -> model -> { costUsd, inputTokens, outputTokens, turns }
 * Malformed roots/entries are dropped; numbers are coerced.
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {Record<string, Record<string, Record<string, { costUsd: number, inputTokens: number, outputTokens: number, turns: number }>>>}
 */
function normalizeUsageByDay(raw, now = new Date()) {
  /** @type {Record<string, Record<string, Record<string, { costUsd: number, inputTokens: number, outputTokens: number, turns: number }>>>} */
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    pruneSpendByDay(map, now);
    return map;
  }
  for (const [day, providers] of Object.entries(raw)) {
    if (typeof day !== "string" || !providers || typeof providers !== "object" || Array.isArray(providers)) {
      continue;
    }
    /** @type {Record<string, Record<string, { costUsd: number, inputTokens: number, outputTokens: number, turns: number }>>} */
    const dayMap = {};
    for (const [provider, models] of Object.entries(providers)) {
      if (typeof provider !== "string" || !models || typeof models !== "object" || Array.isArray(models)) {
        continue;
      }
      /** @type {Record<string, { costUsd: number, inputTokens: number, outputTokens: number, turns: number }>} */
      const modelMap = {};
      for (const [model, entry] of Object.entries(models)) {
        if (typeof model !== "string" || !entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const row = /** @type {{ costUsd?: unknown, inputTokens?: unknown, outputTokens?: unknown, turns?: unknown }} */ (entry);
        modelMap[model] = {
          costUsd: coerceFiniteNumber(row.costUsd),
          inputTokens: coerceFiniteNumber(row.inputTokens),
          outputTokens: coerceFiniteNumber(row.outputTokens),
          turns: coerceFiniteNumber(row.turns),
        };
      }
      if (Object.keys(modelMap).length > 0) dayMap[provider] = modelMap;
    }
    if (Object.keys(dayMap).length > 0) map[day] = dayMap;
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
 * Spaces (#159): spaceId is the same optional-key shape.
 * Worktree retention (#316): keep a finite number > 0; drop otherwise.
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
  // Spaces (#159): empty/junk spaceId must stay absent, not null.
  const spaceId = typeof next.spaceId === "string" ? next.spaceId.trim() : "";
  if (spaceId) next.spaceId = spaceId;
  else delete next.spaceId;
  const retention = next.worktreeRetention;
  if (typeof retention === "number" && Number.isFinite(retention) && retention > 0) {
    next.worktreeRetention = retention;
  } else {
    delete next.worktreeRetention;
  }
  return next;
}

/**
 * A space row is { id, name }. Drop anything else so a corrupt store
 * cannot invent groups; old files without `spaces` load as [].
 * @param {unknown} s
 * @returns {{ id: string, name: string } | null}
 */
function migrateSpace(s) {
  if (!s || typeof s !== "object") return null;
  const id = typeof s.id === "string" ? s.id.trim() : "";
  if (!id || typeof s.name !== "string") return null;
  return { id, name: s.name };
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
    // Older stores have no lastError; null (not undefined) so the badge is stable.
    lastError: t.lastError !== undefined ? t.lastError : null,
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
    // Per-thread desktop-notification mute (issue #87): absent → not muted.
    muted: t.muted === true,
    // Per-thread user scratch pad (issue #194): absent → empty.
    notes: typeof t.notes === "string" ? t.notes : "",
    // Type-ahead queue (issue #137): absent → nothing waiting.
    queued: t.queued !== undefined ? t.queued : null,
    // Verification gate (issue #296): absent / non-string → unarmed.
    verifyCommand: typeof t.verifyCommand === "string" ? t.verifyCommand : null,
    // Latest verify evidence (issue #296): absent → none yet.
    verify: t.verify !== undefined ? t.verify : null,
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
    t.lastError = "Run error: app quit while the run was in flight";
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
 * An unreadable main file is renamed to *.corrupt-<ts> (never discarded)
 * and a sibling *.bak (last good snapshot from a prior successful load)
 * is tried before falling back to empty. Atomic save: write tmp, fsync,
 * then rename. Debounced flushes (save()) write off the event loop;
 * saveNow() is the synchronous exit/shutdown/test path.
 */
class Store {
  /**
   * @param {string} filePath
   */
  constructor(filePath) {
    this.filePath = filePath;
    this._dirty = false;
    this._timer = null;
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
    this.data = this._load();
    if (this._recoveredOnLoad) {
      this.save();
    }
  }

  /**
   * Read, parse and normalize one store file. Throws on missing, unreadable
   * or unparseable input so callers can quarantine or fall through to backup.
   * @param {string} filePath
   * @returns {object}
   */
  _readFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const threads = Array.isArray(parsed.threads)
      ? parsed.threads.map(migrateThread)
      : [];
    const data = {
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.map(migrateProject)
        : [],
      spaces: Array.isArray(parsed.spaces)
        ? parsed.spaces.map(migrateSpace).filter(Boolean)
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
      usageByDay: normalizeUsageByDay(parsed.usageByDay),
      automations: Array.isArray(parsed.automations)
        ? parsed.automations.map(migrateAutomation)
        : [],
      digestSeenAt:
        typeof parsed.digestSeenAt === "number" &&
        Number.isFinite(parsed.digestSeenAt)
          ? parsed.digestSeenAt
          : null,
      settings: normalizeSettings(parsed.settings),
    };
    ensureWorkflowTemplates(data);
    this._recoveredOnLoad = recoverInterruptedRuns(data);
    this._lastAssistantByThread.clear();
    return data;
  }

  _load() {
    this._recoveredOnLoad = false;
    const bakPath = `${this.filePath}.bak`;
    const mainExists = fs.existsSync(this.filePath);
    if (mainExists) {
      try {
        const data = this._readFile(this.filePath);
        // Last-known-good snapshot from this successful start. Best-effort.
        try {
          fs.copyFileSync(this.filePath, bakPath);
        } catch {
          // Never fail a load over the rolling backup.
        }
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
    return cloneEmpty();
  }

  /**
   * Mark dirty and coalesce writes: the whole store is one JSON blob, so a
   * per-stream-event save would re-stringify everything every time. The
   * debounced flush stringifies once per burst (bounded by the per-thread
   * transcript caps) and writes tmp-then-rename off the event loop.
   * Callers that need the bytes on disk right now use saveNow().
   */
  save() {
    this._dirty = true;
    this._scheduleFlush();
    // At most one exit hook no matter how often save() is called.
    if (!this._exitHookArmed) {
      this._exitHookArmed = true;
      process.once("exit", this._flushOnExit);
    }
  }

  _scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flushAsync();
    }, this._flushDelayMs);
    // Never hold the event loop open; the exit hook is what guarantees the write.
    this._timer.unref?.();
  }

  /**
   * Debounced flush: stringify (bounded by the transcript caps), then write
   * tmp + rename via fs.promises so the disk IO stays off the event loop.
   * A flush that turns stale mid-flight (newer mutations pending their own
   * flush, or a synchronous saveNow) drops its tmp file instead of renaming
   * over newer data. Never throws: failures re-mark dirty so the next
   * save()/exit hook retries.
   */
  _flushAsync() {
    if (this._flushing) {
      // The in-flight flush re-checks dirty on completion and reschedules.
      if (this._dirty) this._scheduleFlush();
      return;
    }
    if (!this._dirty) return;
    this._flushing = true;
    this._dirty = false;
    const gen = this._writeGen;
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    this._flushPromise = (async () => {
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        const handle = await fs.promises.open(tmp, "w");
        try {
          await handle.writeFile(payload, "utf8");
          try {
            await handle.sync();
          } catch {
            // fsync is best-effort; still rename so the write is not lost.
          }
        } finally {
          await handle.close();
        }
        if (this._writeGen === gen && !this._dirty) {
          await fs.promises.rename(tmp, this.filePath);
        }
        // else: stale payload; the tmp unlink below discards it.
      } catch (err) {
        this._dirty = true;
        console.error(
          `[store] async flush failed (will retry): ${err && err.message}`,
        );
      } finally {
        // No-op after a successful rename (tmp path is gone).
        await fs.promises.unlink(tmp).catch(() => {});
        this._flushing = false;
        this._flushPromise = null;
        if (this._dirty) {
          // ponytail: backoff under sustained save() so N streaming threads
          // cannot force a whole-store stringify every 250ms. Cap 2s; reset
          // on a quiet flush. Per-thread files if the store stays >50MB.
          this._flushDelayMs = Math.min(
            this._flushDelayMs * 2,
            SAVE_DEBOUNCE_MAX_MS,
          );
          this._scheduleFlush();
        } else {
          this._flushDelayMs = SAVE_DEBOUNCE_MS;
        }
      }
    })();
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
    // "fix" this into async; the debounce path is the hot one.
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._flushDelayMs = SAVE_DEBOUNCE_MS;
    if (this._exitHookArmed) {
      this._exitHookArmed = false;
      process.off("exit", this._flushOnExit);
    }
    this._dirty = false;
    this._writeGen += 1;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(tmp, payload, "utf8");
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
    fs.renameSync(tmp, this.filePath);
  }

  getProjects() {
    return this.data.projects;
  }

  setProjects(projects) {
    this.data.projects = (projects || []).map(migrateProject);
  }

  getSpaces() {
    return this.data.spaces;
  }

  setSpaces(spaces) {
    this.data.spaces = (spaces || []).map(migrateSpace).filter(Boolean);
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
    const msgs = this.getMessages(threadId);
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

  setMessages(threadId, messages) {
    this._lastAssistantByThread.delete(threadId);
    this.data.messagesByThread[threadId] = capList(
      messages,
      MAX_MESSAGES_PER_THREAD,
      MESSAGE_OVERFLOW_SLACK,
      `Older messages were dropped to cap this transcript at ${MAX_MESSAGES_PER_THREAD}.`,
    );
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
   * Add a per-turn usage delta into today's local-day / provider / model bucket.
   * Tokens are recorded even when costUsd is 0 (subscription providers).
   * Ignored when provider is missing/empty, or when all three numeric deltas
   * are 0 / non-finite.
   * @param {{ provider?: unknown, model?: unknown, costUsd?: unknown, inputTokens?: unknown, outputTokens?: unknown }} input
   * @param {Date} [now] - injectable clock for tests
   */
  recordUsage(input, now = new Date()) {
    const provider =
      input && typeof input.provider === "string" ? input.provider : "";
    if (!provider) return;
    const costUsd = coerceFiniteNumber(input && input.costUsd);
    const inputTokens = coerceFiniteNumber(input && input.inputTokens);
    const outputTokens = coerceFiniteNumber(input && input.outputTokens);
    if (costUsd === 0 && inputTokens === 0 && outputTokens === 0) return;
    if (!this.data.usageByDay || typeof this.data.usageByDay !== "object") {
      this.data.usageByDay = {};
    }
    const day = localDayKey(now);
    const dayMap = this.data.usageByDay[day] && typeof this.data.usageByDay[day] === "object"
      ? this.data.usageByDay[day]
      : (this.data.usageByDay[day] = {});
    const providerMap = dayMap[provider] && typeof dayMap[provider] === "object"
      ? dayMap[provider]
      : (dayMap[provider] = {});
    const model = (input && input.model) || "unknown";
    const prev = providerMap[model] && typeof providerMap[model] === "object"
      ? providerMap[model]
      : { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    providerMap[model] = {
      costUsd: coerceFiniteNumber(prev.costUsd) + costUsd,
      inputTokens: coerceFiniteNumber(prev.inputTokens) + inputTokens,
      outputTokens: coerceFiniteNumber(prev.outputTokens) + outputTokens,
      turns: coerceFiniteNumber(prev.turns) + 1,
    };
  }

  /**
   * @returns {Record<string, Record<string, Record<string, { costUsd: number, inputTokens: number, outputTokens: number, turns: number }>>>}
   */
  getUsageByDay() {
    const raw = this.data.usageByDay;
    if (!raw || typeof raw !== "object") return {};
    return { ...raw };
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
   * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }}
   */
  getSettings() {
    if (!this.data.settings || typeof this.data.settings !== "object") {
      this.data.settings = {
        dailyBudgetUsd: null,
        orchestrationBudgetUsd: null,
        autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
        mcpServers: [],
        agentProfiles: [],
      };
    }
    // Re-normalize so a partial in-memory shape still exposes every key.
    const n = normalizeSettings(this.data.settings);
    this.data.settings = n;
    return {
      dailyBudgetUsd: n.dailyBudgetUsd,
      orchestrationBudgetUsd: n.orchestrationBudgetUsd,
      autoSettleAfterDays: n.autoSettleAfterDays,
      mcpServers: n.mcpServers,
      defaultWorktree: n.defaultWorktree,
      defaultOrchestrate: n.defaultOrchestrate,
      updateChannel: n.updateChannel,
      notifications: n.notifications,
      agentProfiles: n.agentProfiles,
    };
  }

  /**
   * Validate and merge settings. Does not touch threads.
   * Does not save; caller must save.
   * @param {Partial<{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }>} patch
   * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }}
   */
  setSettings(patch) {
    if (!patch || typeof patch !== "object") {
      return this.getSettings();
    }
    if (!this.data.settings || typeof this.data.settings !== "object") {
      this.data.settings = {
        dailyBudgetUsd: null,
        orchestrationBudgetUsd: null,
        autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
        mcpServers: [],
        agentProfiles: [],
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
    if (Object.prototype.hasOwnProperty.call(patch, "orchestrationBudgetUsd")) {
      const v = patch.orchestrationBudgetUsd;
      if (v !== null) {
        if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) {
          throw new Error(
            "Orchestration budget must be a positive number or null",
          );
        }
      }
      this.data.settings.orchestrationBudgetUsd = v === null ? null : v;
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
    if (Object.prototype.hasOwnProperty.call(patch, "agentProfiles")) {
      this.data.settings.agentProfiles = validateAgentProfiles(
        patch.agentProfiles,
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "defaultWorktree")) {
      const v = patch.defaultWorktree;
      if (typeof v !== "boolean") {
        throw new Error("defaultWorktree must be a boolean");
      }
      this.data.settings.defaultWorktree = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "defaultOrchestrate")) {
      const v = patch.defaultOrchestrate;
      if (typeof v !== "boolean") {
        throw new Error("defaultOrchestrate must be a boolean");
      }
      this.data.settings.defaultOrchestrate = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "updateChannel")) {
      const v = patch.updateChannel;
      if (v !== null && v !== "prod" && v !== "nightly") {
        throw new Error('updateChannel must be "prod", "nightly", or null');
      }
      this.data.settings.updateChannel = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "notifications")) {
      const v = patch.notifications;
      if (typeof v !== "boolean") {
        throw new Error("notifications must be a boolean");
      }
      this.data.settings.notifications = v;
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
      }
      // A retry/new run is any non-failed status — drop a stale reason.
      if (
        Object.prototype.hasOwnProperty.call(p, "status") &&
        p.status !== "failed"
      ) {
        p = { ...p, lastError: null };
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
   * Full-content thread search: titles + notes + message text,
   * case-insensitive substring. Includes archived. Ordered by updatedAt
   * DESC, max 50. Empty / 1-char queries return [] (renderer only calls
   * with 2+ chars).
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
      if (
        !match &&
        thread.notes != null &&
        String(thread.notes).toLowerCase().includes(needle)
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
    spaces: [],
    threads: [],
    messagesByThread: {},
    workLogByThread: {},
    usageByThread: {},
    workflowTemplates: [],
    spendByDay: {},
    usageByDay: {},
    automations: [],
    digestSeenAt: null,
    // autoSettleAfterDays defaults to 3 (AUTO_SETTLE_AFTER_DAYS); null = disabled.
    settings: {
      dailyBudgetUsd: null,
      orchestrationBudgetUsd: null,
      autoSettleAfterDays: 3,
      mcpServers: [],
      agentProfiles: [],
    },
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
  normalizeUsageByDay,
  SPEND_RETENTION_DAYS,
  MAX_MESSAGES_PER_THREAD,
  MESSAGE_OVERFLOW_SLACK,
  MAX_WORKLOG_ITEMS_PER_THREAD,
  WORKLOG_OVERFLOW_SLACK,
  SAVE_DEBOUNCE_MS,
  SAVE_DEBOUNCE_MAX_MS,
};
