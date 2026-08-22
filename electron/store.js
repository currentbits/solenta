"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  normalizeSubagentPool,
  validateSubagentPool,
} = require("./subagentPool");
const {
  normalizeIssueNumber,
  normalizePostMerge,
} = require("./postmerge.js");
const { normalizeAcceptedHunks } = require("./reviewItinerary.js");
const { normalizeBtwCards } = require("./btw.js");
const { normalizePendingQuestion } = require("./questions.js");
const { getDefaultSecrets } = require("./secrets.js");

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
// 15s, not 2s (#225 interim): each flush stringifies + rewrites the whole
// ~180MB store, and the crash-loss window is only the transcript tail, which
// the provider CLIs' own session logs restore on resume.
const SAVE_DEBOUNCE_MAX_MS = 15_000;

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
 * Default PR size cap in changed lines (additions + deletions vs the base
 * branch). DORA small-batches as a product default (issue #402): PRs larger
 * than this are refused at creation unless explicitly overridden. null in
 * settings disables the cap.
 */
const DEFAULT_PR_DIFF_CAP_LINES = 400;

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
 * subagentPool: absent/junk → { defaultAlias: null, force: false, entries: [] }.
 * Invalid entries are dropped (normalizeSubagentPool).
 *
 * defaultWorktree: absent/junk → false (new threads run in the checkout
 * unless the user opts in).
 *
 * defaultOrchestrate: absent/junk → false (plain "New thread" is not an
 * orchestrator unless the user opts in).
 *
 * onboardingSeen: absent/junk → false (first-run wizard still shows).
 * Only an explicit true marks the tour as finished or skipped.
 *
 * updateChannel: absent/junk → null (follow the channel stamped at package
 * time); "prod"/"nightly" override the stamp.
 *
 * notifications: only an explicit false turns desktop notifications off, so
 * absent/junk keeps the pre-setting behaviour (notify).
 *
 * quotaWaitAutoResume: only an explicit false turns auto-resume off, so
 * absent/junk keeps Claude's default (continue when the usage limit resets).
 *
 * prDiffCapLines: absent/junk → DEFAULT_PR_DIFF_CAP_LINES (400); only an
 * explicit null disables the PR-size cap (issue #402).
 *
 * autoSettleOnMerge: only an explicit false turns merge-settle off, so
 * absent/junk keeps the previous "MERGED = settled" behaviour.
 *
 * @param {unknown} raw
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, autoSettleOnMerge: boolean, prDiffCapLines: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean, updateChannel: "prod" | "nightly" | null, notifications: boolean, agentProfiles: Array<{ id: string, name: string, provider: string, model: string | null, reasoningEffort: string | null, permissionMode: string }> }}
 */
function normalizeSettings(raw) {
  const settings = {
    dailyBudgetUsd: null,
    orchestrationBudgetUsd: null,
    autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
    autoSettleOnMerge: true,
    mcpServers: [],
    defaultWorktree: false,
    defaultOrchestrate: false,
    onboardingSeen: false,
    updateChannel: null,
    notifications: true,
    quotaWaitAutoResume: true,
    prDiffCapLines: DEFAULT_PR_DIFF_CAP_LINES,
    agentProfiles: [],
    subagentPool: { defaultAlias: null, force: false, entries: [] },
    otel: { endpoint: null, headers: {}, claudeMetrics: false },
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

  // prDiffCapLines (issue #402): absent → default 400; explicit null disables
  // the cap; junk heals to the default rather than disabling the guardrail.
  if (Object.prototype.hasOwnProperty.call(obj, "prDiffCapLines")) {
    const c = /** @type {{ prDiffCapLines?: unknown }} */ (obj).prDiffCapLines;
    if (c === null) {
      settings.prDiffCapLines = null;
    } else if (
      typeof c === "number" &&
      Number.isFinite(c) &&
      Number.isInteger(c) &&
      c > 0
    ) {
      settings.prDiffCapLines = c;
    } else {
      settings.prDiffCapLines = DEFAULT_PR_DIFF_CAP_LINES;
    }
  }

  settings.mcpServers = normalizeMcpServers(obj.mcpServers);
  settings.agentProfiles = normalizeAgentProfiles(
    /** @type {{ agentProfiles?: unknown }} */ (obj).agentProfiles,
  );
  settings.subagentPool = normalizeSubagentPool(
    /** @type {{ subagentPool?: unknown }} */ (obj).subagentPool,
  );
  settings.defaultWorktree =
    /** @type {{ defaultWorktree?: unknown }} */ (obj).defaultWorktree === true;
  settings.defaultOrchestrate =
    /** @type {{ defaultOrchestrate?: unknown }} */ (obj).defaultOrchestrate ===
    true;
  settings.onboardingSeen =
    /** @type {{ onboardingSeen?: unknown }} */ (obj).onboardingSeen === true;
  const ch = /** @type {{ updateChannel?: unknown }} */ (obj).updateChannel;
  settings.updateChannel = ch === "prod" || ch === "nightly" ? ch : null;
  settings.notifications =
    /** @type {{ notifications?: unknown }} */ (obj).notifications !== false;
  settings.quotaWaitAutoResume =
    /** @type {{ quotaWaitAutoResume?: unknown }} */ (obj)
      .quotaWaitAutoResume !== false;
  settings.autoSettleOnMerge =
    /** @type {{ autoSettleOnMerge?: unknown }} */ (obj).autoSettleOnMerge !==
    false;
  settings.otel = normalizeOtel(/** @type {{ otel?: unknown }} */ (obj).otel);
  return settings;
}

/**
 * Heal the OTel slice. Absent/junk → export off. An endpoint must be an
 * http(s) URL; anything else collapses to null so a corrupt store cannot
 * make the exporter POST somewhere unexpected.
 *
 * @param {unknown} raw
 * @returns {{ endpoint: string | null, headers: Record<string, string>, claudeMetrics: boolean }}
 */
function normalizeOtel(raw) {
  const out = { endpoint: null, headers: {}, claudeMetrics: false };
  if (!raw || typeof raw !== "object") return out;
  const obj = /** @type {{ endpoint?: unknown, headers?: unknown, claudeMetrics?: unknown }} */ (raw);
  if (typeof obj.endpoint === "string" && /^https?:\/\/\S+$/.test(obj.endpoint.trim())) {
    out.endpoint = obj.endpoint.trim().replace(/\/+$/, "");
  }
  if (obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)) {
    for (const [k, v] of Object.entries(obj.headers)) {
      if (k && typeof v === "string") out.headers[k] = v;
    }
  }
  out.claudeMetrics = obj.claudeMetrics === true;
  return out;
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
 * One usage cell. cachedInputTokens/cacheWriteTokens/wastedUsd are absent on
 * rows written before #556 and read back as 0.
 * @typedef {{ costUsd: number, inputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, outputTokens: number, turns: number, wastedUsd: number }} UsageCell
 * @typedef {UsageCell & { projectId: string, projectName: string, title: string, provider: string, model: string }} UsageThreadCell
 */

/** @returns {UsageCell} */
function emptyUsageCell() {
  return {
    costUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 0,
    wastedUsd: 0,
  };
}

/**
 * Coerce a stored cell, defaulting fields older rows never wrote.
 * @param {unknown} entry
 * @returns {UsageCell}
 */
function coerceUsageCell(entry) {
  const row = /** @type {Record<string, unknown>} */ (entry || {});
  return {
    costUsd: coerceFiniteNumber(row.costUsd),
    inputTokens: coerceFiniteNumber(row.inputTokens),
    cachedInputTokens: coerceFiniteNumber(row.cachedInputTokens),
    cacheWriteTokens: coerceFiniteNumber(row.cacheWriteTokens),
    outputTokens: coerceFiniteNumber(row.outputTokens),
    turns: coerceFiniteNumber(row.turns),
    wastedUsd: coerceFiniteNumber(row.wastedUsd),
  };
}

/**
 * Normalize usageByDay map and prune old buckets.
 * day -> provider -> model -> UsageCell
 * Malformed roots/entries are dropped; numbers are coerced.
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {Record<string, Record<string, Record<string, UsageCell>>>}
 */
function normalizeUsageByDay(raw, now = new Date()) {
  /** @type {Record<string, Record<string, Record<string, UsageCell>>>} */
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    pruneSpendByDay(map, now);
    return map;
  }
  for (const [day, providers] of Object.entries(raw)) {
    if (typeof day !== "string" || !providers || typeof providers !== "object" || Array.isArray(providers)) {
      continue;
    }
    /** @type {Record<string, Record<string, UsageCell>>} */
    const dayMap = {};
    for (const [provider, models] of Object.entries(providers)) {
      if (typeof provider !== "string" || !models || typeof models !== "object" || Array.isArray(models)) {
        continue;
      }
      /** @type {Record<string, UsageCell>} */
      const modelMap = {};
      for (const [model, entry] of Object.entries(models)) {
        if (typeof model !== "string" || !entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        modelMap[model] = coerceUsageCell(entry);
      }
      if (Object.keys(modelMap).length > 0) dayMap[provider] = modelMap;
    }
    if (Object.keys(dayMap).length > 0) map[day] = dayMap;
  }
  pruneSpendByDay(map, now);
  return map;
}

/**
 * Normalize the per-thread rollup and prune old buckets.
 * day -> threadId -> UsageThreadCell
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {Record<string, Record<string, UsageThreadCell>>}
 */
function normalizeUsageThreadsByDay(raw, now = new Date()) {
  /** @type {Record<string, Record<string, UsageThreadCell>>} */
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    pruneSpendByDay(map, now);
    return map;
  }
  for (const [day, threads] of Object.entries(raw)) {
    if (typeof day !== "string" || !threads || typeof threads !== "object" || Array.isArray(threads)) {
      continue;
    }
    /** @type {Record<string, UsageThreadCell>} */
    const dayMap = {};
    for (const [threadId, entry] of Object.entries(threads)) {
      if (typeof threadId !== "string" || !threadId || !entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const row = /** @type {Record<string, unknown>} */ (entry);
      dayMap[threadId] = {
        ...coerceUsageCell(entry),
        projectId: typeof row.projectId === "string" ? row.projectId : "",
        projectName: typeof row.projectName === "string" ? row.projectName : "",
        title: typeof row.title === "string" ? row.title : "",
        provider: typeof row.provider === "string" ? row.provider : "",
        model: typeof row.model === "string" ? row.model : "unknown",
      };
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
 * Settled worktrees each project keeps on disk (#559). Same number
 * worktrees.js uses for classification. 0 on a project is keep-everything.
 */
const DEFAULT_WORKTREE_RETENTION = 10;

/**
 * Projects: remoteHost/remotePath stay absent on old rows. Empty strings
 * (or other junk) are dropped so the keys remain optional, not null.
 * Spaces (#568): spaceId is dropped on load.
 * Worktree retention (#316 / #559): a finite number >= 0 stays. Missing
 * or junk becomes DEFAULT_WORKTREE_RETENTION (10). 0 is the explicit
 * keep-everything hatch — it must survive, or the default would wipe it.
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
  // Spaces (#568): retired. Drop any leftover spaceId so old stores flatten.
  delete next.spaceId;
  const retention = next.worktreeRetention;
  if (typeof retention === "number" && Number.isFinite(retention) && retention >= 0) {
    next.worktreeRetention = Math.floor(retention);
  } else {
    next.worktreeRetention = DEFAULT_WORKTREE_RETENTION;
  }
  // Derived at list time (#610). Never persist a data URL.
  delete next.iconUrl;
  if (typeof next.iconPath === "string" && next.iconPath.trim()) {
    next.iconPath = next.iconPath.trim().replace(/\\/g, "/");
  } else {
    delete next.iconPath;
  }
  return next;
}

/**
 * Heal a persisted felt estimate (issue #401). Only the two contract shapes
 * survive; anything else becomes null (never asked).
 */
function normalizeFeltEstimate(value) {
  if (!value || typeof value !== "object") return null;
  const at =
    typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  if (value.kind === "declined") return { kind: "declined", at };
  if (value.kind === "saved") {
    const savedMs = Number(value.savedMs);
    if (!Number.isFinite(savedMs) || savedMs < 0) return null;
    return { kind: "saved", savedMs, at };
  }
  return null;
}

function migrateThread(t) {
  if (!t || typeof t !== "object") return t;
  const next = {
    ...t,
    provider: t.provider != null ? t.provider : "claude",
    model: migrateKimiModel(t),
    // "cwd" was a per-directory resume sentinel; it bleeds across threads
    // that share a project folder (issue #220). Heal leftover rows to null.
    sessionId:
      t.sessionId && t.sessionId !== "cwd" ? t.sessionId : null,
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
    prMergeable:
      t.prMergeable === "MERGEABLE" ||
      t.prMergeable === "CONFLICTING" ||
      t.prMergeable === "UNKNOWN"
        ? t.prMergeable
        : null,
    // Round 43 unread: null = legacy (renderer treats as visited so upgrades
    // do not light up every old thread). Visiting is stamped in threads.get.
    lastVisitedAt: t.lastVisitedAt !== undefined ? t.lastVisitedAt : null,
    // Round 44 pin + snooze: null = unpinned / not snoozed.
    pinnedAt: t.pinnedAt !== undefined ? t.pinnedAt : null,
    snoozedUntil: t.snoozedUntil !== undefined ? t.snoozedUntil : null,
    snoozedAt: t.snoozedAt !== undefined ? t.snoozedAt : null,
    // Round 49 fork/hand-off: null = not a fork (provenance only).
    handoffFrom: t.handoffFrom !== undefined ? t.handoffFrom : null,
    // Issue #254 edit-and-resubmit: one-shot context replay after rewind.
    replayContext: t.replayContext === true,
    // Per-thread desktop-notification mute (issue #87): absent → not muted.
    muted: t.muted === true,
    // Per-thread user scratch pad (issue #194): absent → empty.
    notes: typeof t.notes === "string" ? t.notes : "",
    // One-tap felt estimate (issue #401): absent/invalid → never answered.
    feltEstimate: normalizeFeltEstimate(t.feltEstimate),
    // Type-ahead queue (issue #137): absent → nothing waiting.
    queued: t.queued !== undefined ? t.queued : null,
    // Verification gate (issue #296): absent / non-string → unarmed.
    verifyCommand: typeof t.verifyCommand === "string" ? t.verifyCommand : null,
    // Latest verify evidence (issue #296): absent → none yet.
    verify: t.verify !== undefined ? t.verify : null,
    // Planboard issue this thread was started from (issue #420).
    issueNumber: normalizeIssueNumber(t.issueNumber),
    // Delayed post-merge re-check (issue #420). Heal a crash mid-check.
    postMergeVerify: normalizePostMerge(t.postMergeVerify),
    // Review itinerary accepted hunks (issue #421).
    reviewAcceptedHunks: normalizeAcceptedHunks(t.reviewAcceptedHunks),
    // Provider quota-wait (#462). Absent on old rows.
    quotaWaitUntil:
      typeof t.quotaWaitUntil === "number" && Number.isFinite(t.quotaWaitUntil)
        ? t.quotaWaitUntil
        : null,
    quotaWaitResumed: t.quotaWaitResumed === true,
    quotaWaitAutoResume:
      t.quotaWaitAutoResume === true
        ? true
        : t.quotaWaitAutoResume === false
          ? false
          : null,
  };
  // Side questions (issue #471). Running cards become errors on load:
  // the completeAsk process is gone. Omit the field on old rows so
  // fixtures without `btw` still deepEqual.
  const cards = normalizeBtwCards(t.btw);
  if (cards) next.btw = cards;
  else delete next.btw;
  // Agent question awaiting an answer (issue #647). Unlike a claude
  // permission prompt this OUTLIVES the run — grok and kimi finish their turn
  // after asking — so it is persisted, and healed on load like any other
  // agent-supplied row. Omitted when absent so old fixtures still deepEqual.
  const question = normalizePendingQuestion(t.pendingQuestion);
  if (question) next.pendingQuestion = question;
  else delete next.pendingQuestion;
  if (
    t.crossThreadInbound === "queue-only" ||
    t.crossThreadInbound === "refuse"
  ) {
    next.crossThreadInbound = t.crossThreadInbound;
  } else {
    delete next.crossThreadInbound;
  }
  return next;
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
   * @param {{ secrets?: import("./secrets.js").Secrets }} [opts]
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this._secrets = (opts && opts.secrets) || getDefaultSecrets();
    this._secretsMigrated = 0;
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
    // Rolling .bak is off the constructor's sync path (#618). Tests may await it.
    this._bakCopy = Promise.resolve();
    this.data = this._load();
    if (this._secretsMigrated > 0) {
      this._secrets.emit(
        `[store] encrypted ${this._secretsMigrated} plaintext credential(s) at rest`,
      );
    }
    if (this._recoveredOnLoad) {
      this.save();
    }
  }

  /**
   * Stringify the live store with secret fields sealed. In-memory settings
   * stay plaintext; only the JSON payload is encrypted (issue #543).
   */
  _payloadJson() {
    const settings = this._secrets.concealSettings(this.data.settings);
    if (settings === this.data.settings) return JSON.stringify(this.data);
    return JSON.stringify({ ...this.data, settings });
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
    const data = {
      projects: rawProjects.map(migrateProject),
      // #568: Spaces retired. Keep the key so old files still parse; never load rows.
      spaces: [],
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
      usageThreadsByDay: normalizeUsageThreadsByDay(parsed.usageThreadsByDay),
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
    this._recoveredOnLoad = recoverInterruptedRuns(data) || hadSpaces;
    const revealed = this._secrets.revealSettings(data.settings);
    data.settings = revealed.settings;
    if (revealed.migrated > 0) {
      this._secretsMigrated = revealed.migrated;
      this._recoveredOnLoad = true;
    }
    this._lastAssistantByThread.clear();
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
    return cloneEmpty();
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
    // At most one exit hook no matter how often markDirty()/save() run.
    if (!this._exitHookArmed) {
      this._exitHookArmed = true;
      process.once("exit", this._flushOnExit);
    }
  }

  /**
   * Mark dirty and coalesce writes: the whole store is one JSON blob, so a
   * per-stream-event save would re-stringify everything every time. The
   * debounced flush stringifies once per burst (bounded by the per-thread
   * transcript caps) and writes tmp-then-rename off the event loop.
   * Callers that need the bytes on disk right now use saveNow().
   */
  save() {
    this.markDirty();
    this._scheduleFlush();
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
    // Compact JSON: the file is machine-read, and pretty-printing roughly
    // doubles both the stringify CPU and the bytes written on every flush
    // (which fires up to every 15s under sustained streaming).
    const payload = this._payloadJson();
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
          // cannot force a whole-store stringify every 250ms. Cap 15s; reset
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
    const payload = this._payloadJson();
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
    return dropped.length;
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
   * A named provider is enough — zeros stay zeros. Kimi reports no usage at
   * all; dropping those turns hid the provider (#556). Simulate is ignored
   * so fixture runs do not pollute the ledger.
   * When threadId is a non-empty string, the same numbers accumulate into
   * usageThreadsByDay; project/title/provider/model are last-seen labels.
   * @param {{ provider?: unknown, model?: unknown, costUsd?: unknown, inputTokens?: unknown, cachedInputTokens?: unknown, cacheWriteTokens?: unknown, outputTokens?: unknown, threadId?: unknown, projectId?: unknown, projectName?: unknown, title?: unknown }} input
   * @param {Date} [now] - injectable clock for tests
   */
  recordUsage(input, now = new Date()) {
    const provider =
      input && typeof input.provider === "string" ? input.provider : "";
    if (!provider || provider === "simulate") return;
    const costUsd = coerceFiniteNumber(input && input.costUsd);
    const inputTokens = coerceFiniteNumber(input && input.inputTokens);
    const cachedInputTokens = coerceFiniteNumber(input && input.cachedInputTokens);
    const cacheWriteTokens = coerceFiniteNumber(input && input.cacheWriteTokens);
    const outputTokens = coerceFiniteNumber(input && input.outputTokens);
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
    const prev = coerceUsageCell(providerMap[model]);
    providerMap[model] = {
      ...prev,
      costUsd: prev.costUsd + costUsd,
      inputTokens: prev.inputTokens + inputTokens,
      cachedInputTokens: prev.cachedInputTokens + cachedInputTokens,
      cacheWriteTokens: prev.cacheWriteTokens + cacheWriteTokens,
      outputTokens: prev.outputTokens + outputTokens,
      turns: prev.turns + 1,
    };

    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    if (threadId) {
      if (!this.data.usageThreadsByDay || typeof this.data.usageThreadsByDay !== "object") {
        this.data.usageThreadsByDay = {};
      }
      const threadsDay =
        this.data.usageThreadsByDay[day] && typeof this.data.usageThreadsByDay[day] === "object"
          ? this.data.usageThreadsByDay[day]
          : (this.data.usageThreadsByDay[day] = {});
      const prevThread = coerceUsageCell(threadsDay[threadId]);
      threadsDay[threadId] = {
        ...prevThread,
        costUsd: prevThread.costUsd + costUsd,
        inputTokens: prevThread.inputTokens + inputTokens,
        cachedInputTokens: prevThread.cachedInputTokens + cachedInputTokens,
        cacheWriteTokens: prevThread.cacheWriteTokens + cacheWriteTokens,
        outputTokens: prevThread.outputTokens + outputTokens,
        turns: prevThread.turns + 1,
        projectId: typeof input.projectId === "string" ? input.projectId : "",
        projectName: typeof input.projectName === "string" ? input.projectName : "",
        title: typeof input.title === "string" ? input.title : "",
        provider,
        model: typeof model === "string" ? model : "unknown",
      };
    }
  }

  /**
   * Of cost already recorded by recordUsage, attribute the share spent on a
   * run that ended failed or stopped. Not additive to costUsd.
   * Creates the provider/model (and thread) row if absent — turns stay 0.
   * @param {{ provider?: unknown, model?: unknown, threadId?: unknown, costUsd?: unknown, projectId?: unknown, projectName?: unknown, title?: unknown }} input
   * @param {Date} [now] - injectable clock for tests
   */
  recordWastedSpend(input, now = new Date()) {
    const provider =
      input && typeof input.provider === "string" ? input.provider : "";
    if (!provider || provider === "simulate") return;
    const costUsd = coerceFiniteNumber(input && input.costUsd);
    if (costUsd <= 0) return;
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
    const prev = coerceUsageCell(providerMap[model]);
    providerMap[model] = {
      ...prev,
      wastedUsd: prev.wastedUsd + costUsd,
    };

    const threadId =
      input && typeof input.threadId === "string" ? input.threadId : "";
    if (threadId) {
      if (!this.data.usageThreadsByDay || typeof this.data.usageThreadsByDay !== "object") {
        this.data.usageThreadsByDay = {};
      }
      const threadsDay =
        this.data.usageThreadsByDay[day] && typeof this.data.usageThreadsByDay[day] === "object"
          ? this.data.usageThreadsByDay[day]
          : (this.data.usageThreadsByDay[day] = {});
      const prevThread = coerceUsageCell(threadsDay[threadId]);
      const prevRow =
        threadsDay[threadId] && typeof threadsDay[threadId] === "object"
          ? /** @type {UsageThreadCell} */ (threadsDay[threadId])
          : null;
      // Keep labels the turn already recorded; fall back to the caller's when
      // the run burned cost without ever recording a turn, so the breakdown
      // shows a name instead of "Unknown project" and a raw thread id.
      const label = (fromRow, fromInput) =>
        (prevRow && typeof fromRow === "string" && fromRow) ||
        (typeof fromInput === "string" ? fromInput : "");
      threadsDay[threadId] = {
        ...prevThread,
        wastedUsd: prevThread.wastedUsd + costUsd,
        projectId: label(prevRow && prevRow.projectId, input.projectId),
        projectName: label(prevRow && prevRow.projectName, input.projectName),
        title: label(prevRow && prevRow.title, input.title),
        provider,
        model: typeof model === "string" ? model : "unknown",
      };
    }
  }

  /**
   * @returns {Record<string, Record<string, Record<string, UsageCell>>>}
   */
  getUsageByDay() {
    const raw = this.data.usageByDay;
    if (!raw || typeof raw !== "object") return {};
    return { ...raw };
  }

  /**
   * Per-thread usage rollup, the input to the project/thread breakdown (#556).
   * @returns {Record<string, Record<string, UsageThreadCell>>}
   */
  getUsageThreadsByDay() {
    const raw = this.data.usageThreadsByDay;
    if (!raw || typeof raw !== "object") return {};
    return { ...raw };
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
   * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, prDiffCapLines: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }}
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
      autoSettleOnMerge: n.autoSettleOnMerge,
      mcpServers: n.mcpServers,
      defaultWorktree: n.defaultWorktree,
      defaultOrchestrate: n.defaultOrchestrate,
      onboardingSeen: n.onboardingSeen,
      updateChannel: n.updateChannel,
      notifications: n.notifications,
      quotaWaitAutoResume: n.quotaWaitAutoResume,
      prDiffCapLines: n.prDiffCapLines,
      agentProfiles: n.agentProfiles,
      subagentPool: n.subagentPool,
      otel: n.otel,
    };
  }

  /**
   * Validate and merge settings. Does not touch threads.
   * Does not save; caller must save.
   * @param {Partial<{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, prDiffCapLines: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }>} patch
   * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, prDiffCapLines: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }}
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
    if (Object.prototype.hasOwnProperty.call(patch, "prDiffCapLines")) {
      const v = patch.prDiffCapLines;
      if (v !== null) {
        // Positive integer only (reject 0, negatives, fractions, NaN, strings).
        if (
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          !Number.isInteger(v) ||
          !(v > 0)
        ) {
          throw new Error(
            `PR diff cap must be a positive integer or null (got ${String(v)})`,
          );
        }
      }
      this.data.settings.prDiffCapLines = v === null ? null : v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoSettleOnMerge")) {      const v = patch.autoSettleOnMerge;
      if (typeof v !== "boolean") {
        throw new Error("autoSettleOnMerge must be a boolean");
      }
      this.data.settings.autoSettleOnMerge = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "mcpServers")) {
      this.data.settings.mcpServers = validateMcpServers(patch.mcpServers);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "agentProfiles")) {
      this.data.settings.agentProfiles = validateAgentProfiles(
        patch.agentProfiles,
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "subagentPool")) {
      this.data.settings.subagentPool = validateSubagentPool(
        patch.subagentPool,
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
    if (Object.prototype.hasOwnProperty.call(patch, "onboardingSeen")) {
      const v = patch.onboardingSeen;
      if (typeof v !== "boolean") {
        throw new Error("onboardingSeen must be a boolean");
      }
      this.data.settings.onboardingSeen = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "updateChannel")) {
      const v = patch.updateChannel;
      if (v !== null && v !== "prod" && v !== "nightly") {
        throw new Error('updateChannel must be "prod", "nightly", or null');
      }
      this.data.settings.updateChannel = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "otel")) {
      const v = /** @type {{ endpoint?: unknown }} */ (patch.otel);
      if (!v || typeof v !== "object") {
        throw new Error("otel must be an object");
      }
      if (
        v.endpoint != null &&
        !(typeof v.endpoint === "string" && /^https?:\/\/\S+$/.test(v.endpoint.trim()))
      ) {
        throw new Error("OTLP endpoint must be an http(s) URL or null");
      }
      this.data.settings.otel = normalizeOtel(v);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "notifications")) {
      const v = patch.notifications;
      if (typeof v !== "boolean") {
        throw new Error("notifications must be a boolean");
      }
      this.data.settings.notifications = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "quotaWaitAutoResume")) {
      const v = patch.quotaWaitAutoResume;
      if (typeof v !== "boolean") {
        throw new Error("quotaWaitAutoResume must be a boolean");
      }
      this.data.settings.quotaWaitAutoResume = v;
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
      // quota-wait keeps lastError so the card tooltip still explains why.
      if (
        Object.prototype.hasOwnProperty.call(p, "status") &&
        p.status !== "failed" &&
        p.status !== "quota-wait"
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
};
