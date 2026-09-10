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
const { normalizeMessagePins } = require("./messagePins.js");
const { getDefaultSecrets } = require("./secrets.js");
const {
  splitMessagesByThread,
  stringifyStore,
  indexMessagesObject,
  findThreadValue,
  peekLastAssistantValue,
  appendJsonArrayItem,
} = require("./jsonEnvelope.js");
const { clampUiScale, UI_SCALE_DEFAULT } = require("./zoom.js");
const { getProvider, honouredEfforts } = require("./providers.js");
const {
  normalizeSetupCommand,
  normalizeQuickActions,
} = require("./projectCommands.js");
const {
  normalizeMcpServers,
  validateMcpServers,
  mergeMcpSettingsPatch,
  RESERVED_MCP_NAMES,
} = require("./mcp.js");
const {
  collectMessageTexts,
  threadMatches,
  rankSearchHits,
} = require("./threadSearch.js");

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
  runArtifactsByThread: {},
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

/** ReasoningEffort in src/shared/ipc.ts. Keep in lockstep. */
const REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);

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
      "agentProfiles entry reasoningEffort must be one of low, medium, high, xhigh, max, ultra, ultracode, or null",
    );
  }
  if (effort !== null) {
    const providerEntry = getProvider(provider);
    if (providerEntry) {
      const modelId = typeof model === "string" ? model : null;
      const allowed = honouredEfforts(providerEntry, modelId);
      if (!allowed.includes(effort)) {
        return fail(
          `agentProfiles entry reasoningEffort "${effort}" is not honoured by ${providerEntry.name}`,
        );
      }
    }
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

/**
 * Keep a default-orchestrator id only when it names a profile in `profiles`.
 * Empty/junk/unknown → null. Used on disk read (heal) and after a profiles
 * patch (drop a dangling default).
 * @param {unknown} raw
 * @param {Array<{ id: string }>} profiles
 * @returns {string | null}
 */
function matchingProfileId(raw, profiles) {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id) return null;
  const list = Array.isArray(profiles) ? profiles : [];
  return list.some((p) => p.id === id) ? id : null;
}

const SPEND_RETENTION_DAYS = 90;

// Longest a save() may sit in memory before it hits disk.
// #225: per-thread shards make a flush cheap (one transcript, not the whole
// store), so the #124/#225-interim backoff cap is gone — flat 250ms.
const SAVE_DEBOUNCE_MS = 250;
const SAVE_DEBOUNCE_MAX_MS = SAVE_DEBOUNCE_MS;

/** Per-thread transcript files live next to coder-store.json (#225). */
const MESSAGES_DIR = "messages";
/** Per-thread work-log files live next to coder-store.json (#1204). */
const WORKLOGS_DIR = "worklogs";

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
 * Settings.defaultProvider (issue #711). Absent/junk → null (createThread
 * then uses "claude"). A non-empty string is kept; unknown ids are skipped
 * at create time so this file does not depend on the provider registry.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDefaultProvider(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id || null;
}

/**
 * Settings.defaultModel (issue #711). Absent/junk/empty → null (provider
 * default). Custom ids are allowed; the CLI is the allowlist.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeDefaultModel(raw) {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id) return null;
  return id.length > 100 ? id.slice(0, 100) : id;
}

/**
 * Settings.quotaFailover (issue #711). Ordered provider ids to try after a
 * quota-exhausted turn. Absent/junk → [] (no failover; park or fail as today).
 * Duplicates and empty strings dropped. Unknown ids are skipped at use time.
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeQuotaFailover(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Strict validation for settings:set. Throws on the first problem.
 * @param {unknown} raw
 * @returns {string[]}
 */
function validateQuotaFailover(raw) {
  if (!Array.isArray(raw)) {
    throw new Error("quotaFailover must be an array");
  }
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("quotaFailover entries must be non-empty strings");
    }
  }
  return normalizeQuotaFailover(raw);
}

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
 * defaultOrchestratorProfileId: absent/junk/empty → null. A string is kept
 * only when it matches a surviving agentProfiles id; unknown ids heal to
 * null so deleting a profile cannot leave a dangling default.
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
 * defaultProvider: absent/junk/empty → null (createThread uses "claude").
 * defaultModel: absent/junk/empty → null (provider default).
 * quotaFailover: absent/junk → [] (no cross-provider failover).
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
 * feltEstimatePrompt: absent/junk → false. The "how much time did this save
 * you?" card is opt-in; only an explicit true asks.
 *
 * uiScale: Electron webContents zoom factor (issue #652). Absent/junk → 1;
 * otherwise snapped to 0.1 between 0.8 and 1.6.
 * theme: absent/junk → "dark" (the app was dark-only; upgrades must not
 * flip to light because the OS is light). "system" | "light" | "dark".
 *
 * agentsPanelDefault: absent/junk → "closed" (issue #767). The right
 * sidebar starts collapsed unless the user picks "open".
 *
 * agentsPanelRememberLast: only an explicit true opts in (issue #769),
 * so absent/junk keeps last ⌘./rail toggle ephemeral.
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
 * webhook: absent/junk → { url: null, onDone/onFailed/onWaiting: true }.
 * A URL must be http(s); anything else collapses to null so a corrupt store
 * cannot POST somewhere unexpected. Only an explicit false turns an event
 * off, so a pasted URL fires all three until the user unchecks.
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
    defaultProvider: null,
    defaultModel: null,
    quotaFailover: [],
    onboardingSeen: false,
    updateChannel: null,
    notifications: true,
    feltEstimatePrompt: false,
    uiScale: UI_SCALE_DEFAULT,
    theme: "dark",
    agentsPanelDefault: "closed",
    agentsPanelRememberLast: false,
    stayAwake: "agent",
    quotaWaitAutoResume: true,
    prDiffCapLines: DEFAULT_PR_DIFF_CAP_LINES,
    agentProfiles: [],
    defaultOrchestratorProfileId: null,
    subagentPool: { defaultAlias: null, force: false, entries: [] },
    otel: { endpoint: null, headers: {}, claudeMetrics: false },
    linearApiKey: null,
    webhook: { url: null, onDone: true, onFailed: true, onWaiting: true },
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
  settings.defaultOrchestratorProfileId = matchingProfileId(
    /** @type {{ defaultOrchestratorProfileId?: unknown }} */ (obj)
      .defaultOrchestratorProfileId,
    settings.agentProfiles,
  );
  settings.subagentPool = normalizeSubagentPool(
    /** @type {{ subagentPool?: unknown }} */ (obj).subagentPool,
  );
  settings.defaultWorktree =
    /** @type {{ defaultWorktree?: unknown }} */ (obj).defaultWorktree === true;
  settings.defaultOrchestrate =
    /** @type {{ defaultOrchestrate?: unknown }} */ (obj).defaultOrchestrate ===
    true;
  settings.defaultProvider = normalizeDefaultProvider(
    /** @type {{ defaultProvider?: unknown }} */ (obj).defaultProvider,
  );
  settings.defaultModel = normalizeDefaultModel(
    /** @type {{ defaultModel?: unknown }} */ (obj).defaultModel,
  );
  settings.quotaFailover = normalizeQuotaFailover(
    /** @type {{ quotaFailover?: unknown }} */ (obj).quotaFailover,
  );
  settings.onboardingSeen =
    /** @type {{ onboardingSeen?: unknown }} */ (obj).onboardingSeen === true;
  const ch = /** @type {{ updateChannel?: unknown }} */ (obj).updateChannel;
  settings.updateChannel = ch === "prod" || ch === "nightly" ? ch : null;
  settings.notifications =
    /** @type {{ notifications?: unknown }} */ (obj).notifications !== false;
  settings.feltEstimatePrompt =
    /** @type {{ feltEstimatePrompt?: unknown }} */ (obj).feltEstimatePrompt ===
    true;
  settings.uiScale = clampUiScale(
    /** @type {{ uiScale?: unknown }} */ (obj).uiScale,
  );
  const theme = /** @type {{ theme?: unknown }} */ (obj).theme;
  settings.theme =
    theme === "system" || theme === "light" || theme === "dark" ? theme : "dark";
  // agentsPanelDefault (#767): absent/junk heals to "closed" so the right
  // sidebar starts collapsed unless the user opted into open.
  const agentsPanelDefault = /** @type {{ agentsPanelDefault?: unknown }} */ (
    obj
  ).agentsPanelDefault;
  settings.agentsPanelDefault =
    agentsPanelDefault === "open" || agentsPanelDefault === "closed"
      ? agentsPanelDefault
      : "closed";
  // agentsPanelRememberLast (#769): only an explicit true opts in so the
  // product default stays ephemeral session toggles + Closed/Open fallback.
  settings.agentsPanelRememberLast =
    /** @type {{ agentsPanelRememberLast?: unknown }} */ (obj)
      .agentsPanelRememberLast === true;
  // stayAwake (#364): absent/junk heals to "agent" — the safe default keeps
  // the machine awake during runs without pinning it awake while idle.
  const stayAwake = /** @type {{ stayAwake?: unknown }} */ (obj).stayAwake;
  settings.stayAwake =
    stayAwake === "on" || stayAwake === "off" || stayAwake === "agent"
      ? stayAwake
      : "agent";
  settings.quotaWaitAutoResume =
    /** @type {{ quotaWaitAutoResume?: unknown }} */ (obj)
      .quotaWaitAutoResume !== false;
  settings.autoSettleOnMerge =
    /** @type {{ autoSettleOnMerge?: unknown }} */ (obj).autoSettleOnMerge !==
    false;
  settings.otel = normalizeOtel(/** @type {{ otel?: unknown }} */ (obj).otel);
  const linearKey = /** @type {{ linearApiKey?: unknown }} */ (obj).linearApiKey;
  if (typeof linearKey === "string" && linearKey.trim()) {
    settings.linearApiKey = linearKey.trim();
  } else {
    settings.linearApiKey = null;
  }
  settings.webhook = normalizeWebhook(
    /** @type {{ webhook?: unknown }} */ (obj).webhook,
  );
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
 * Heal the webhook slice (issue #167). Absent/junk → no URL, every event on.
 *
 * @param {unknown} raw
 * @returns {{ url: string | null, onDone: boolean, onFailed: boolean, onWaiting: boolean }}
 */
function normalizeWebhook(raw) {
  const out = { url: null, onDone: true, onFailed: true, onWaiting: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = /** @type {{ url?: unknown, onDone?: unknown, onFailed?: unknown, onWaiting?: unknown }} */ (
    raw
  );
  if (typeof obj.url === "string") {
    const trimmed = obj.url.trim();
    if (isHttpUrl(trimmed)) out.url = trimmed;
  }
  out.onDone = obj.onDone !== false;
  out.onFailed = obj.onFailed !== false;
  out.onWaiting = obj.onWaiting !== false;
  return out;
}

/**
 * Normalize runArtifactsByThread: every thread id maps to an array of plain objects.
 * @param {unknown} raw
 * @returns {Record<string, object[]>}
 */
function normalizeRunArtifactsByThread(raw) {
  /** @type {Record<string, object[]>} */
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [threadId, artifacts] of Object.entries(raw)) {
    if (!Array.isArray(artifacts)) {
      map[threadId] = [];
      continue;
    }
    map[threadId] = artifacts
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({ ...item }));
  }
  return map;
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
  // Derived at list time (#610 / #521). Never persist a data URL or scm probe.
  delete next.iconUrl;
  delete next.scm;
  if (typeof next.iconPath === "string" && next.iconPath.trim()) {
    next.iconPath = next.iconPath.trim().replace(/\\/g, "/");
  } else {
    delete next.iconPath;
  }
  const setupCommand = normalizeSetupCommand(next.setupCommand);
  if (setupCommand) next.setupCommand = setupCommand;
  else delete next.setupCommand;
  const quickActions = normalizeQuickActions(next.quickActions);
  if (quickActions) next.quickActions = quickActions;
  else delete next.quickActions;
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

/**
 * Heal a persisted plan-approval card (issue #707). Empty/junk plans become
 * null — a card the user cannot approve would be a permanent stuck badge.
 * @param {unknown} value
 */
function normalizePendingPlan(value) {
  if (!value || typeof value !== "object") return null;
  const raw = /** @type {{ id?: unknown, plan?: unknown, askedAt?: unknown }} */ (
    value
  );
  const plan = typeof raw.plan === "string" ? raw.plan.trim() : "";
  if (!plan) return null;
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
  const askedAt =
    typeof raw.askedAt === "number" && Number.isFinite(raw.askedAt)
      ? raw.askedAt
      : 0;
  return {
    id: (rawId || "plan").slice(0, 64),
    plan: plan.length > 20000 ? plan.slice(0, 20000) : plan,
    askedAt,
  };
}

/**
 * Frozen pre-#955 noticePrompt last line. Retry classifies by the
 * persisted fromNotice flag (#955); this string is only the one-shot
 * backfill heuristic for transcripts written before that flag existed
 * (#957). Do not import this into src/retryTurn.ts.
 */
const LEGACY_NOTICE_FOOTER =
  "Continue orchestrating; thread_status has full details.";
const NOT_DELIVERED_SPLIT = /\n\nNot delivered:\s*/i;

/**
 * True when `text` matches a flushOrchNotices noticePrompt body: headed
 * with `[` and ending with the historical footer. Verify-fix prompts
 * start with `[verification failed]` and do not end with that footer.
 * @param {unknown} text
 * @returns {boolean}
 */
function isLegacyOrchNoticeText(text) {
  if (typeof text !== "string" || !text) return false;
  const suffix = "\n" + LEGACY_NOTICE_FOOTER;
  if (!text.endsWith(suffix)) return false;
  return text.includes("[");
}

/**
 * Set fromNotice on stored user rows and undeliverable events that look
 * like pre-flag flushOrchNotices output. Mutates in place. Skips
 * already-flagged rows and verify-fix "Not delivered" events.
 * @param {object[]} messages
 * @returns {boolean} true when any row was updated
 */
function backfillFromNotice(messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.fromNotice === true) continue;
    if (m.role === "user" && isLegacyOrchNoticeText(m.text)) {
      m.fromNotice = true;
      changed = true;
      continue;
    }
    if (m.role === "event" && typeof m.text === "string") {
      const idx = m.text.search(NOT_DELIVERED_SPLIT);
      if (idx < 0) continue;
      if (isLegacyOrchNoticeText(m.text.slice(0, idx))) {
        m.fromNotice = true;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Lead-side worker→lead integrate receipts (#954). Survive cleanupWorktree
 * and worker archive. Empty/junk omitted so old fixtures still deepEqual.
 * @param {unknown} raw
 * @returns {Array<object> | undefined}
 */
function normalizeIntegrationReceipts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const workerId = typeof r.workerId === "string" ? r.workerId.trim() : "";
    const sourceSha = typeof r.sourceSha === "string" ? r.sourceSha.trim() : "";
    const leadId = typeof r.leadId === "string" ? r.leadId.trim() : "";
    if (!workerId || !sourceSha || !leadId) continue;
    const included = [];
    if (Array.isArray(r.includedIssueIds)) {
      for (const raw of r.includedIssueIds) {
        const n = normalizeIssueNumber(raw);
        if (n && !included.includes(n)) included.push(n);
      }
    }
    out.push({
      workerId,
      sourceSha,
      leadId,
      leadShaAfter:
        typeof r.leadShaAfter === "string" ? r.leadShaAfter.trim() : "",
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
      issueNumber: normalizeIssueNumber(r.issueNumber),
      includedIssueIds: included,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Combined lead result actually reached the final target (#954).
 * @param {unknown} raw
 * @returns {{ at: number, sha: string | null, via: "merge" | "pr" } | undefined}
 */
function normalizeIntegrationLanded(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const via = raw.via === "pr" ? "pr" : "merge";
  const sha =
    typeof raw.sha === "string" && raw.sha.trim() ? raw.sha.trim() : null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0;
  return { at, sha, via };
}

/**
 * Serialized crew merge queue (#346). Worker IDs waiting to integrate
 * onto this lead. Omitted when empty so old fixtures still deepEqual.
 * @param {unknown} raw
 * @returns {string[] | undefined}
 */
function normalizeMergeQueue(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = [];
  for (const id of raw) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out.length ? out : undefined;
}

/**
 * Numbered merge-queue lane (#346). Omitted when invalid.
 * @param {unknown} raw
 * @returns {{ n: number, port: number, claimedAt: number, lastBeat: number } | undefined}
 */
function normalizeMergeLane(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const n = Number(raw.n);
  if (!Number.isInteger(n) || n < 1) return undefined;
  const port = Number(raw.port);
  return {
    n,
    port: Number.isInteger(port) && port > 0 ? port : n,
    claimedAt:
      typeof raw.claimedAt === "number" && Number.isFinite(raw.claimedAt)
        ? raw.claimedAt
        : 0,
    lastBeat:
      typeof raw.lastBeat === "number" && Number.isFinite(raw.lastBeat)
        ? raw.lastBeat
        : 0,
  };
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
    // Codex live web search (issue #174). Absent → off.
    webSearch: t.webSearch === true,
    worktreePath: t.worktreePath !== undefined ? t.worktreePath : null,
    runStartedAt: t.runStartedAt !== undefined ? t.runStartedAt : null,
    // Issue #183: stamp of a user stop mid-run; null = never stopped / running again.
    stoppedAt: t.stoppedAt !== undefined ? t.stoppedAt : null,
    // Older stores have no lastError; null (not undefined) so the badge is stable.
    lastError: t.lastError !== undefined ? t.lastError : null,
    lastErrorKind:
      t.lastErrorKind === "context-overflow" ||
      t.lastErrorKind === "cli-upgrade" ||
      t.lastErrorKind === "writer-lock"
        ? t.lastErrorKind
        : null,
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
    // Eject-to-terminal (#554): Solenta must not resume this sessionId.
    ejected: t.ejected === true,
    // Per-thread user scratch pad (issue #194): absent → empty.
    notes: typeof t.notes === "string" ? t.notes : "",
    // Transcript bookmarks (issue #1217): absent/invalid → none.
    messagePins: normalizeMessagePins(t.messagePins),
    // User-defined tags (issue #789): absent/invalid → none.
    tags: Array.isArray(t.tags)
      ? t.tags.filter((x) => typeof x === "string" && x.trim() !== "")
      : [],
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
  const failoverTried = Array.isArray(t.quotaFailoverTried)
    ? t.quotaFailoverTried.filter((id) => typeof id === "string" && id.trim())
    : [];
  if (failoverTried.length) next.quotaFailoverTried = failoverTried;
  else delete next.quotaFailoverTried;
  if (t.memoryConsolidate === true) next.memoryConsolidate = true;
  else delete next.memoryConsolidate;
  // Recently deleted (#940). Omitted when unset so old fixtures still deepEqual.
  if (typeof t.trashedAt === "number" && Number.isFinite(t.trashedAt)) {
    next.trashedAt = t.trashedAt;
  } else {
    delete next.trashedAt;
  }
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
  // Plan-mode approval for CLIs without ExitPlanMode (issue #707). Omitted
  // when absent so old fixtures still deepEqual.
  const pendingPlan = normalizePendingPlan(t.pendingPlan);
  if (pendingPlan) next.pendingPlan = pendingPlan;
  else delete next.pendingPlan;
  if (
    t.crossThreadInbound === "queue-only" ||
    t.crossThreadInbound === "refuse"
  ) {
    next.crossThreadInbound = t.crossThreadInbound;
  } else {
    delete next.crossThreadInbound;
  }
  // Lead-side integrate receipts (#954). Survive worker cleanup/archive.
  // Omitted when empty so old fixtures still deepEqual.
  const receipts = normalizeIntegrationReceipts(t.integrationReceipts);
  if (receipts) next.integrationReceipts = receipts;
  else delete next.integrationReceipts;
  const landed = normalizeIntegrationLanded(t.integrationLanded);
  if (landed) next.integrationLanded = landed;
  else delete next.integrationLanded;
  const mergeQueue = normalizeMergeQueue(t.mergeQueue);
  if (mergeQueue) next.mergeQueue = mergeQueue;
  else delete next.mergeQueue;
  const lane = normalizeMergeLane(t.lane);
  if (lane) next.lane = lane;
  else delete next.lane;
  // Model the CLI session started on. Codex exec resume hydrates this
  // from the rollout and ignores a later picker (#1215). Omitted when
  // unset so old fixtures still deepEqual.
  if (
    typeof t.sessionStartModel === "string" &&
    t.sessionStartModel.trim() !== ""
  ) {
    next.sessionStartModel = t.sessionStartModel.trim();
  } else {
    delete next.sessionStartModel;
  }
  return next;
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
    t.status = "failed";
    t.runStartedAt = null;
    t.lastError = "Run error: app quit while the run was in flight";
    t.lastErrorKind = null;
    t.updatedAt = Date.now();
    store._appendLazyMessage(t.id, {
      id: randomUUID(),
      role: "event",
      text: "Run interrupted: the app crashed or was force-quit mid-run",
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
 * @param {unknown} id
 * @returns {string | null} path-safe filename stem, or null if the id cannot
 *   be persisted as a single path segment under messages/
 */
function encodeThreadFileId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length >= 200) {
    return null;
  }
  if (id === "." || id === "..") return null;
  let encoded;
  try {
    encoded = encodeURIComponent(id).replace(/[!'()*]/g, (c) =>
      "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
    );
  } catch {
    return null;
  }
  if (
    encoded === "." ||
    encoded === ".." ||
    encoded.includes("/") ||
    encoded.includes("\\") ||
    encoded.includes("\0") ||
    encoded.length + ".json".length > 255
  ) {
    return null;
  }
  return encoded;
}

/**
 * @param {unknown} fileId
 * @returns {string | null}
 */
function decodeThreadFileId(fileId) {
  if (typeof fileId !== "string" || !fileId) return null;
  try {
    const id = decodeURIComponent(fileId);
    return encodeThreadFileId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} id
 * @returns {id is string}
 */
function isSafeThreadId(id) {
  return encodeThreadFileId(id) != null;
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
 * A flush writes only dirty shards plus the small envelope. Atomic save:
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
    // After the split this copy is envelope-only; transcripts live in messages/
    // and are not cloned into .bak. A still-inline legacy blob is copied to
    // .bak synchronously before the first migration write.
    this._bakCopy = Promise.resolve();
    // #639/#225: transcripts stay unparsed until a thread is opened.
    // Hydrated arrays live on _messagesHydrated; unparsed JSON strings on
    // _messagesRaw; still-lazy blob slices on _messagesLazy (legacy envelope
    // only, dropped after the shard split).
    this._messagesHydrated = {};
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
    this._atomicSeq = 0;
    this._searchGen = 0;
    this._searchWorker = null;
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
        if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];
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
   * Load worklogs/<id>.json over the envelope map. Existing shards win
   * against a leftover inline copy (interrupted migrate). Keeps arrays in
   * memory — activity and crash recovery need them, and a 500-row cap is
   * small compared to transcripts.
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
    for (const id of [...this._workLogShards]) {
      const raw = this._readWorkLogFile(id);
      if (raw == null) continue;
      let val;
      try {
        val = JSON.parse(raw);
      } catch {
        val = [];
      }
      if (!Array.isArray(val)) val = [];
      map[id] = val;
    }
    data.workLogByThread = map;
    this._attachWorkLogProxy(data);
    this._workLogsSplit = this._inlineWorkLogIds.size === 0;
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
    return val;
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
    const payload = settings === src.settings ? src : { ...src, settings };
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
      if (messagesMigrated || workLogsMigrated) {
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
   * Debounced flush: stringify the envelope plus dirty shards, then write
   * tmp + rename via fs.promises so the disk IO stays off the event loop.
   * A flush that turns stale mid-flight (a synchronous saveNow bumping
   * `_writeGen`) drops its tmp files instead of renaming over newer data.
   * An unrelated later `_dirty` does not invalidate this shard snapshot.
   * Never throws: failures re-mark dirty so the next save()/exit hook retries.
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
    const payload = this._serialize();
    const envelopeTmp = `${this.filePath}.${process.pid}.${++this._atomicSeq}.tmp`;
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
        await writeTmp(envelopeTmp, payload);
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
          if (failedDeletes.length === 0) {
            fs.renameSync(envelopeTmp, this.filePath);
          } else {
            this._dirty = true;
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
        await fs.promises.unlink(envelopeTmp).catch(() => {});
        for (const s of shardTmps) {
          await fs.promises.unlink(s.tmp).catch(() => {});
        }
        this._inflightShardIds = null;
        this._inflightDeletedIds = null;
        this._inflightWorkLogIds = null;
        this._inflightDeletedWorkLogIds = null;
        this._flushing = false;
        this._flushPromise = null;
        if (this._dirty) this._scheduleFlush();
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
      if (!deletesPending) {
        writeAtomicSync(this.filePath, this._serialize(), ++this._atomicSeq);
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
      defaultProvider: n.defaultProvider,
      defaultModel: n.defaultModel,
      quotaFailover: n.quotaFailover,
      onboardingSeen: n.onboardingSeen,
      updateChannel: n.updateChannel,
      notifications: n.notifications,
      feltEstimatePrompt: n.feltEstimatePrompt,
      uiScale: n.uiScale,
      theme: n.theme,
      agentsPanelDefault: n.agentsPanelDefault,
      agentsPanelRememberLast: n.agentsPanelRememberLast,
      stayAwake: n.stayAwake,
      quotaWaitAutoResume: n.quotaWaitAutoResume,
      prDiffCapLines: n.prDiffCapLines,
      agentProfiles: n.agentProfiles,
      defaultOrchestratorProfileId: n.defaultOrchestratorProfileId,
      subagentPool: n.subagentPool,
      otel: n.otel,
      linearApiKey: n.linearApiKey,
      webhook: n.webhook,
    };
  }

  /**
   * Validate and merge settings. Does not touch threads.
   * Does not save; caller must save.
   * @param {Partial<{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, prDiffCapLines: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }>} patch
   * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, prDiffCapLines: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean }}
   */
  setSettings(patch, opts = {}) {
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
      this.data.settings.mcpServers = validateMcpServers(
        opts.replaceMcpServers
          ? patch.mcpServers
          : mergeMcpSettingsPatch(
              this.data.settings.mcpServers,
              patch.mcpServers,
            ),
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "agentProfiles")) {
      this.data.settings.agentProfiles = validateAgentProfiles(
        patch.agentProfiles,
      );
      this.data.settings.defaultOrchestratorProfileId = matchingProfileId(
        this.data.settings.defaultOrchestratorProfileId,
        this.data.settings.agentProfiles,
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "defaultOrchestratorProfileId")) {
      const v = patch.defaultOrchestratorProfileId;
      if (v !== null && typeof v !== "string") {
        throw new Error(
          "defaultOrchestratorProfileId must be a string or null",
        );
      }
      const id = matchingProfileId(v, this.data.settings.agentProfiles);
      if (v != null && String(v).trim() && id == null) {
        throw new Error(
          "defaultOrchestratorProfileId must match an agent profile or be null",
        );
      }
      this.data.settings.defaultOrchestratorProfileId = id;
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
    if (Object.prototype.hasOwnProperty.call(patch, "defaultProvider")) {
      const v = patch.defaultProvider;
      if (v !== null && typeof v !== "string") {
        throw new Error("defaultProvider must be a string or null");
      }
      this.data.settings.defaultProvider = normalizeDefaultProvider(v);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "defaultModel")) {
      const v = patch.defaultModel;
      if (v !== null && typeof v !== "string") {
        throw new Error("defaultModel must be a string or null");
      }
      this.data.settings.defaultModel = normalizeDefaultModel(v);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "quotaFailover")) {
      this.data.settings.quotaFailover = validateQuotaFailover(
        patch.quotaFailover,
      );
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
    if (Object.prototype.hasOwnProperty.call(patch, "feltEstimatePrompt")) {
      const v = patch.feltEstimatePrompt;
      if (typeof v !== "boolean") {
        throw new Error("feltEstimatePrompt must be a boolean");
      }
      this.data.settings.feltEstimatePrompt = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "uiScale")) {
      const v = patch.uiScale;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error("uiScale must be a number");
      }
      this.data.settings.uiScale = clampUiScale(v);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "theme")) {
      const v = patch.theme;
      if (v !== "system" && v !== "light" && v !== "dark") {
        throw new Error('theme must be "system", "light", or "dark"');
      }
      this.data.settings.theme = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "agentsPanelDefault")) {
      const v = patch.agentsPanelDefault;
      if (v !== "closed" && v !== "open") {
        throw new Error('agentsPanelDefault must be "closed" or "open"');
      }
      this.data.settings.agentsPanelDefault = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "agentsPanelRememberLast")) {
      const v = patch.agentsPanelRememberLast;
      if (typeof v !== "boolean") {
        throw new Error("agentsPanelRememberLast must be a boolean");
      }
      this.data.settings.agentsPanelRememberLast = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "stayAwake")) {
      const v = patch.stayAwake;
      if (v !== "agent" && v !== "on" && v !== "off") {
        throw new Error('stayAwake must be "agent", "on", or "off"');
      }
      this.data.settings.stayAwake = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "quotaWaitAutoResume")) {
      const v = patch.quotaWaitAutoResume;
      if (typeof v !== "boolean") {
        throw new Error("quotaWaitAutoResume must be a boolean");
      }
      this.data.settings.quotaWaitAutoResume = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "linearApiKey")) {
      const v = patch.linearApiKey;
      if (v === null || v === "") {
        this.data.settings.linearApiKey = null;
      } else if (typeof v === "string") {
        const t = v.trim();
        this.data.settings.linearApiKey = t || null;
      } else {
        throw new Error("linearApiKey must be a string or null");
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "webhook")) {
      const v = patch.webhook;
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw new Error("webhook must be an object");
      }
      if (Object.prototype.hasOwnProperty.call(v, "url")) {
        if (v.url != null && v.url !== "") {
          if (!(typeof v.url === "string" && isHttpUrl(v.url.trim()))) {
            throw new Error("Webhook URL must be an http(s) URL or empty");
          }
        }
      }
      for (const key of ["onDone", "onFailed", "onWaiting"]) {
        if (
          Object.prototype.hasOwnProperty.call(v, key) &&
          typeof v[key] !== "boolean"
        ) {
          throw new Error(`${key} must be a boolean`);
        }
      }
      this.data.settings.webhook = normalizeWebhook({
        ...this.data.settings.webhook,
        ...v,
      });
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
    runArtifactsByThread: {},
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
};
