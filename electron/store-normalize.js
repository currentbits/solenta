"use strict";

const path = require("node:path");
const { normalizeSubagentPool } = require("./subagentPool");
const { clampUiScale, UI_SCALE_DEFAULT } = require("./zoom.js");
const { getProvider, honouredEfforts } = require("./providers.js");
const { normalizeMcpServers } = require("./mcp.js");
const { normalizeProviderInstances, parseProviderModels } = require("./providerInstances.js");
const { normalizeModelPrices } = require("./modelPrices.js");
const { normalizePrivacyGateway } = require("./privacyGateway.js");
const { parsePolicy } = require("./governance.js");
const { normalizeAutoApprove } = require("./autoApprove.js");
const { normalizeBudget } = require("./budgetCaps.js");

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
  "auto",
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
    const providerEntry = getProvider(provider.split(":")[0]);
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
  // Plan model (#1716): optional, absent stays absent so fixtures deepEqual.
  // Only providers that resume one session across models take it.
  /** @type {{ planModel?: string, planReasoningEffort?: string }} */
  const plan = {};
  if (rec.planModel != null) {
    const id = typeof rec.planModel === "string" ? rec.planModel.trim() : "";
    if (!id || id.length > 100) {
      return fail(
        "agentProfiles entry planModel must be a model id of at most 100 characters, or null",
      );
    }
    const providerEntry = getProvider(provider.split(":")[0]);
    if (!providerEntry || providerEntry.supportsPlanModel !== true) {
      return fail(
        `agentProfiles entry planModel is not supported by ${providerEntry ? providerEntry.name : provider}`,
      );
    }
    plan.planModel = id;
    const planEffort = rec.planReasoningEffort;
    if (planEffort != null) {
      if (!honouredEfforts(providerEntry, id).includes(planEffort)) {
        return fail(
          `agentProfiles entry planReasoningEffort "${planEffort}" is not honoured by ${providerEntry.name} for ${id}`,
        );
      }
      plan.planReasoningEffort = /** @type {string} */ (planEffort);
    }
  }
  const permissionMode = rec.permissionMode;
  if (!PERMISSION_MODES.has(permissionMode)) {
    return fail(
      "agentProfiles entry permissionMode must be one of default, acceptEdits, plan, auto, bypassPermissions",
    );
  }
  // Governance matrix (#262). Junk heals to absent on read (the profile
  // stays); settings:set throws. Absent stays absent so fixtures deepEqual.
  const policy =
    rec.policy === undefined ? null : parsePolicy(rec.policy, strict);
  // Default hard cap for threads this profile is applied to (#286). Same
  // heal-on-read / throw-on-set split; absent stays absent.
  const budget = normalizeBudget(rec.budget, strict);
  // Auto-approve toggles (#1721) copied onto threads the profile is applied
  // to. Junk heals to absent; absent stays absent.
  const autoApprove = normalizeAutoApprove(rec.autoApprove);
  return {
    id,
    name,
    provider,
    model,
    reasoningEffort: /** @type {string | null} */ (effort),
    ...plan,
    permissionMode: /** @type {string} */ (permissionMode),
    ...(policy ? { policy } : {}),
    ...(budget ? { budget } : {}),
    ...(autoApprove ? { autoApprove } : {}),
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

const SNIPPET_NAME_RE = /^[\w.-]{1,40}$/;
const SNIPPET_TEXT_MAX = 8000;

/** Thread-title prompt instructions cap (issue #1765). */
const TITLE_INSTRUCTIONS_MAX = 500;

/** Commit message / PR prompt instructions caps (issue #1774). */
const COMMIT_MESSAGE_INSTRUCTIONS_MAX = 1000;
const PR_INSTRUCTIONS_MAX = 1000;

/**
 * Prompt snippets (issue #189): named text the composer inserts via `@name`.
 * strict (settings:set) throws on the first problem; lenient (disk read)
 * drops bad entries and duplicate names. Names stay one token so the
 * @-mention query can match them.
 * @param {unknown} raw
 * @param {boolean} strict
 * @returns {Array<{ name: string, text: string }>}
 */
function parsePromptSnippets(raw, strict) {
  if (!Array.isArray(raw)) {
    if (strict) throw new Error("promptSnippets must be an array");
    return [];
  }
  /** @type {Array<{ name: string, text: string }>} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const text = typeof item?.text === "string" ? item.text : "";
    let problem = null;
    if (!SNIPPET_NAME_RE.test(name)) {
      problem = `Snippet name "${name}" must be 1-40 letters, digits, ".", "-" or "_"`;
    } else if (!text.trim() || text.length > SNIPPET_TEXT_MAX) {
      problem = `Snippet "${name}" text must be 1-${SNIPPET_TEXT_MAX} characters`;
    } else if (seen.has(name)) {
      problem = `Duplicate snippet name: ${name}`;
    }
    if (problem) {
      if (strict) throw new Error(problem);
      continue;
    }
    seen.add(name);
    out.push({ name, text });
  }
  return out;
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
 * Default cap on simultaneous agent runs (issue #166). Starts beyond it wait
 * in a FIFO run queue and are admitted as runs settle. null disables the cap.
 */
const DEFAULT_MAX_CONCURRENT_RUNS = 4;

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
 * Settings.gitTextModel (#1780): provider/model for commit message and PR
 * text generation (electron/commitmsg.js). Absent/junk/empty provider →
 * null, the thread's own provider/model (today's behaviour).
 * @param {unknown} raw
 * @returns {{ provider: string, model: string | null } | null}
 */
function normalizeGitTextModel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = /** @type {{ provider?: unknown, model?: unknown }} */ (raw);
  const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
  if (!provider) return null;
  const model = typeof rec.model === "string" && rec.model.trim() ? rec.model.trim().slice(0, 100) : null;
  return { provider, model };
}

/**
 * Strict validation for settings:set. Throws on the first problem.
 * @param {unknown} raw
 * @returns {{ provider: string, model: string | null } | null}
 */
function validateGitTextModel(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("gitTextModel must be an object with provider and model, or null");
  }
  const rec = /** @type {{ provider?: unknown, model?: unknown }} */ (raw);
  if (typeof rec.provider !== "string" || !rec.provider.trim()) {
    throw new Error("gitTextModel.provider must be a non-empty string");
  }
  if (rec.model != null && typeof rec.model !== "string") {
    throw new Error("gitTextModel.model must be a string or null");
  }
  return normalizeGitTextModel(rec);
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
 * notificationSound: absent/junk → false. The focused-window alert sound
 * (#1506) is opt-in; only an explicit true plays it.
 *
 * notificationProjects: absent/junk → [] (every project notifies, #1746).
 * Same id-list shape as quotaFailover.
 *
 * promptSnippets: absent/junk → []; bad entries and duplicate names drop.
 *
 * feltEstimatePrompt: absent/junk → false. The "how much time did this save
 * you?" card is opt-in; only an explicit true asks.
 *
 * suggestNextPrompt: absent/junk → false (issue #1806, Labs). The next-prompt
 * ghost suggestion costs one extra fm completion per finished turn; off by
 * default.
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
 * confirmQuitWithActiveWork: only an explicit false opts out of the
 * accidental-quit dialog (issue #1195). Absent/junk keeps the confirm.
 *
 * resumeInterruptedRuns: shipped opt-in (#1512 I3), then defaulted on
 * (#1788) for anyone who never chose. normalizeSettings cannot tell an
 * unset value from an explicit `false` once a store round-trips through
 * save (every save backfills every default, this one included), so the
 * on/off switch here is `resumeInterruptedRunsSet`, a marker setSettings
 * stamps the moment the user ever patches this key (either direction).
 * No marker on disk -> the user never touched it -> true, regardless of
 * what a pre-#1788 save happened to backfill. Marker present -> honour
 * whatever the user last chose, true or false.
 *

 * agentBugReports: default on (#1703); only an explicit false hides the
 * solenta_bug_report tool and its prompt hint.
 *
 * combineQueuedFollowUps: default on (#468); only an explicit false drains
 * the type-ahead queue one item per turn.
 *
 * prDiffCapLines: absent/junk → DEFAULT_PR_DIFF_CAP_LINES (400); only an
 * explicit null disables the PR-size cap (issue #402).
 *
 * maxConcurrentRuns: same tri-state as prDiffCapLines, default
 * DEFAULT_MAX_CONCURRENT_RUNS (4); explicit null disables the cap (#166).
 *
 * autoSettleOnMerge: only an explicit false turns merge-settle off, so
 * absent/junk keeps the previous "MERGED = settled" behaviour.
 *
 * deleteBranchOnMergeOrClose: default on; only an explicit false opts out
 * of deleting the GitHub head branch after the app merges or closes a PR.
 *
 * defaultMergeMethod: default null (follow the repo's own default via
 * resolveMergeMethod). Anything but "squash"/"merge"/"rebase" collapses to
 * null (issue #1781).
 *
 * worktreeRoot: where new thread worktrees go (#1531). Absent/junk/relative
 * → null, the default userData/worktrees. Existence is checked on save.
 *
 * webhook: absent/junk → { url: null, onDone/onFailed/onWaiting: true }.
 * A URL must be http(s); anything else collapses to null so a corrupt store
 * cannot POST somewhere unexpected. Only an explicit false turns an event
 * off, so a pasted URL fires all three until the user unchecks.
 *
 * @param {unknown} raw
 * @returns {{ dailyBudgetUsd: number | null, orchestrationBudgetUsd: number | null, autoSettleAfterDays: number | null, autoSettleOnMerge: boolean, prDiffCapLines: number | null, mcpServers: Array<{ name: string, url: string, token?: string, enabled: boolean }>, defaultWorktree: boolean, defaultOrchestrate: boolean, updateChannel: "prod" | "nightly" | null, notifications: boolean, notificationSound: boolean, agentProfiles: Array<{ id: string, name: string, provider: string, model: string | null, reasoningEffort: string | null, permissionMode: string }> }}
 */
function normalizeSettings(raw) {
  const settings = {
    dailyBudgetUsd: null,
    orchestrationBudgetUsd: null,
    autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
    autoSettleOnMerge: true,
    stripAgentCoauthors: false,
    prCrossReview: false,
    deleteBranchOnMergeOrClose: true,
    defaultMergeMethod: null,
    mcpServers: [],
    defaultWorktree: false,
    defaultOrchestrate: false,
    defaultProvider: null,
    defaultModel: null,
    quotaFailover: [],
    onboardingSeen: false,
    updateChannel: null,
    notifications: true,
    notificationSound: false,
    notifyEvents: normalizeNotifyEvents(null),
    notificationProjects: [],
    feltEstimatePrompt: false,
    suggestNextPrompt: false,
    uiScale: UI_SCALE_DEFAULT,
    theme: "dark",
    agentsPanelDefault: "closed",
    agentsPanelRememberLast: false,
    stayAwake: "agent",
    quotaWaitAutoResume: true,
    confirmQuitWithActiveWork: true,
    resumeInterruptedRuns: true,
    resumeInterruptedRunsSet: false,
    combineQueuedFollowUps: true,
    agentBugReports: true,
    guardrailsEnabled: true,
    idleCompactClaudeThreads: false,
    titleInstructions: "",
    commitMessageInstructions: "",
    prInstructions: "",
    gitTextModel: null,
    prDiffCapLines: DEFAULT_PR_DIFF_CAP_LINES,
    maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS,
    agentProfiles: [],
    providerInstances: [],
    providerModels: {},
    defaultOrchestratorProfileId: null,
    promptSnippets: [],
    subagentPool: { defaultAlias: null, force: false, entries: [] },
    otel: { endpoint: null, headers: {}, claudeMetrics: false },
    linearApiKey: null,
    sentryAuthToken: null,
    speech: normalizeSpeechSettings(null),
    githubHosts: [],
    webhook: { url: null, onDone: true, onFailed: true, onWaiting: true },
    ...Object.fromEntries(CHANNEL_KINDS.map((k) => [k, normalizeChannel(k, null, false)])),
    modelPrices: {},
    worktreeRoot: null,
    privacyGateway: normalizePrivacyGateway(null),
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
  if (Object.prototype.hasOwnProperty.call(obj, "maxConcurrentRuns")) {
    const c = /** @type {{ maxConcurrentRuns?: unknown }} */ (obj)
      .maxConcurrentRuns;
    settings.maxConcurrentRuns =
      c === null
        ? null
        : Number.isInteger(c) && /** @type {number} */ (c) > 0
          ? /** @type {number} */ (c)
          : DEFAULT_MAX_CONCURRENT_RUNS;
  }

  settings.mcpServers = normalizeMcpServers(obj.mcpServers);
  settings.agentProfiles = normalizeAgentProfiles(
    /** @type {{ agentProfiles?: unknown }} */ (obj).agentProfiles,
  );
  settings.providerInstances = normalizeProviderInstances(
    /** @type {{ providerInstances?: unknown }} */ (obj).providerInstances,
  );
  settings.providerModels = parseProviderModels(
    /** @type {{ providerModels?: unknown }} */ (obj).providerModels,
    false,
  );
  settings.defaultOrchestratorProfileId = matchingProfileId(
    /** @type {{ defaultOrchestratorProfileId?: unknown }} */ (obj)
      .defaultOrchestratorProfileId,
    settings.agentProfiles,
  );
  settings.promptSnippets = parsePromptSnippets(
    /** @type {{ promptSnippets?: unknown }} */ (obj).promptSnippets,
    false,
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
  settings.notificationSound =
    /** @type {{ notificationSound?: unknown }} */ (obj).notificationSound ===
    true;
  settings.notifyEvents = normalizeNotifyEvents(
    /** @type {{ notifyEvents?: unknown }} */ (obj).notifyEvents,
  );
  settings.notificationProjects = normalizeQuotaFailover(
    /** @type {{ notificationProjects?: unknown }} */ (obj).notificationProjects,
  );
  settings.feltEstimatePrompt =
    /** @type {{ feltEstimatePrompt?: unknown }} */ (obj).feltEstimatePrompt ===
    true;
  settings.suggestNextPrompt =
    /** @type {{ suggestNextPrompt?: unknown }} */ (obj).suggestNextPrompt ===
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
  settings.confirmQuitWithActiveWork =
    /** @type {{ confirmQuitWithActiveWork?: unknown }} */ (obj)
      .confirmQuitWithActiveWork !== false;
  // #1788: `resumeInterruptedRunsSet` only ever becomes true via setSettings
  // (store-settings-methods.js), the moment a human actually patches this
  // key. Absent -> never touched -> default true, whatever a prior save
  // backfilled. Present -> the stored boolean is a real choice, keep it.
  const resumeTouched =
    /** @type {{ resumeInterruptedRunsSet?: unknown }} */ (obj)
      .resumeInterruptedRunsSet === true;
  settings.resumeInterruptedRunsSet = resumeTouched;
  settings.resumeInterruptedRuns = resumeTouched
    ? /** @type {{ resumeInterruptedRuns?: unknown }} */ (obj)
        .resumeInterruptedRuns === true
    : true;
  settings.combineQueuedFollowUps =
    /** @type {{ combineQueuedFollowUps?: unknown }} */ (obj)
      .combineQueuedFollowUps !== false;
  settings.agentBugReports =
    /** @type {{ agentBugReports?: unknown }} */ (obj).agentBugReports !== false;
  settings.guardrailsEnabled =
    /** @type {{ guardrailsEnabled?: unknown }} */ (obj).guardrailsEnabled !== false;
  settings.idleCompactClaudeThreads =
    /** @type {{ idleCompactClaudeThreads?: unknown }} */ (obj)
      .idleCompactClaudeThreads === true;
  const titleInstructions =
    /** @type {{ titleInstructions?: unknown }} */ (obj).titleInstructions;
  settings.titleInstructions =
    typeof titleInstructions === "string"
      ? titleInstructions.trim().slice(0, TITLE_INSTRUCTIONS_MAX)
      : "";
  const commitMessageInstructions =
    /** @type {{ commitMessageInstructions?: unknown }} */ (obj)
      .commitMessageInstructions;
  settings.commitMessageInstructions =
    typeof commitMessageInstructions === "string"
      ? commitMessageInstructions.trim().slice(0, COMMIT_MESSAGE_INSTRUCTIONS_MAX)
      : "";
  const prInstructions =
    /** @type {{ prInstructions?: unknown }} */ (obj).prInstructions;
  settings.prInstructions =
    typeof prInstructions === "string"
      ? prInstructions.trim().slice(0, PR_INSTRUCTIONS_MAX)
      : "";
  settings.gitTextModel = normalizeGitTextModel(
    /** @type {{ gitTextModel?: unknown }} */ (obj).gitTextModel,
  );
  settings.autoSettleOnMerge =
    /** @type {{ autoSettleOnMerge?: unknown }} */ (obj).autoSettleOnMerge !==
    false;
  settings.stripAgentCoauthors =
    /** @type {{ stripAgentCoauthors?: unknown }} */ (obj).stripAgentCoauthors ===
    true;
  settings.prCrossReview =
    /** @type {{ prCrossReview?: unknown }} */ (obj).prCrossReview === true;
  settings.deleteBranchOnMergeOrClose =
    /** @type {{ deleteBranchOnMergeOrClose?: unknown }} */ (obj)
      .deleteBranchOnMergeOrClose !== false;
  const defaultMergeMethod = /** @type {{ defaultMergeMethod?: unknown }} */ (obj)
    .defaultMergeMethod;
  settings.defaultMergeMethod =
    defaultMergeMethod === "squash" ||
    defaultMergeMethod === "merge" ||
    defaultMergeMethod === "rebase"
      ? defaultMergeMethod
      : null;
  settings.otel = normalizeOtel(/** @type {{ otel?: unknown }} */ (obj).otel);
  const linearKey = /** @type {{ linearApiKey?: unknown }} */ (obj).linearApiKey;
  if (typeof linearKey === "string" && linearKey.trim()) {
    settings.linearApiKey = linearKey.trim();
  } else {
    settings.linearApiKey = null;
  }
  const sentryTok = /** @type {{ sentryAuthToken?: unknown }} */ (obj).sentryAuthToken;
  if (typeof sentryTok === "string" && sentryTok.trim()) {
    settings.sentryAuthToken = sentryTok.trim();
  } else {
    settings.sentryAuthToken = null;
  }
  settings.modelPrices = normalizeModelPrices(
    /** @type {{ modelPrices?: unknown }} */ (obj).modelPrices,
  );
  settings.githubHosts = normalizeGithubHosts(
    /** @type {{ githubHosts?: unknown }} */ (obj).githubHosts,
    false,
  );
  settings.webhook = normalizeWebhook(
    /** @type {{ webhook?: unknown }} */ (obj).webhook,
  );
  settings.speech = normalizeSpeechSettings(
    /** @type {{ speech?: unknown }} */ (obj).speech,
  );
  for (const k of CHANNEL_KINDS) {
    /** @type {any} */ (settings)[k] = normalizeChannel(k, /** @type {any} */ (obj)[k], false);
  }
  const root = /** @type {{ worktreeRoot?: unknown }} */ (obj).worktreeRoot;
  settings.worktreeRoot =
    typeof root === "string" && path.isAbsolute(root.trim()) ? root.trim() : null;
  settings.privacyGateway = normalizePrivacyGateway(
    /** @type {{ privacyGateway?: unknown }} */ (obj).privacyGateway,
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
 * Per-event desktop notification switches (#1725). Absent/junk keys take
 * NOTIFY_EVENT_DEFAULTS, so a store written before them notifies as it did.
 *
 * @param {unknown} raw
 * @returns {{ approval: boolean, turnFinished: boolean, turnFailed: boolean, automationFinished: boolean, ciFailed: boolean }}
 */
function normalizeNotifyEvents(raw) {
  const { NOTIFY_EVENT_DEFAULTS } = require("./notify.js");
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
  const out = { ...NOTIFY_EVENT_DEFAULTS };
  for (const key of Object.keys(out)) {
    if (typeof obj[key] === "boolean") out[key] = obj[key];
  }
  return out;
}

const SPEECH_PROVIDERS = ["local", "openai", "elevenlabs"];

/**
 * Voice input provider (#1725). Absent/junk → local, no keys. Keys are
 * sealed at rest (secrets.js) and never sent to the renderer (mcp.js).
 *
 * @param {unknown} raw
 * @returns {{ provider: "local" | "openai" | "elevenlabs", openaiApiKey: string | null, elevenlabsApiKey: string | null }}
 */
function normalizeSpeechSettings(raw) {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
  const key = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    provider: /** @type {"local" | "openai" | "elevenlabs"} */ (
      SPEECH_PROVIDERS.includes(/** @type {string} */ (obj.provider))
        ? obj.provider
        : "local"
    ),
    openaiApiKey: key(obj.openaiApiKey),
    elevenlabsApiKey: key(obj.elevenlabsApiKey),
  };
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
 * Chat channels (#1718), one settings key per kind. `allowedSenderIds` are
 * the platform's user ids as strings; nothing runs until one is set.
 * strict (settings:set) throws on junk; lenient (load) drops it. Token
 * prefixes are only checked on set: a load may still see sealed values.
 */
const CHANNEL_SPECS = {
  telegram: {
    label: "Telegram",
    tokens: /** @type {Record<string, string | null>} */ ({ botToken: null }),
    id: /^\d{1,20}$/,
    idError: "Telegram sender id must be a number",
  },
  slack: {
    label: "Slack",
    tokens: /** @type {Record<string, string | null>} */ ({ appToken: "xapp-", botToken: "xoxb-" }),
    id: /^[UW][A-Z0-9]{2,20}$/,
    idError: "Slack member id must look like U012AB3CD",
  },
  discord: {
    label: "Discord",
    tokens: /** @type {Record<string, string | null>} */ ({ botToken: null }),
    id: /^\d{1,20}$/,
    idError: "Discord user id must be a number",
  },
};
const CHANNEL_KINDS = Object.keys(CHANNEL_SPECS);

/**
 * @param {string} kind a CHANNEL_KINDS entry
 * @param {unknown} raw
 * @param {boolean} strict
 * @returns {{ enabled: boolean, allowedSenderIds: string[], projectId: string | null, agentProfileId: string | null } & Record<string, any>}
 */
function normalizeChannel(kind, raw, strict) {
  const spec = CHANNEL_SPECS[/** @type {keyof typeof CHANNEL_SPECS} */ (kind)];
  /** @type {any} */
  const out = { enabled: false };
  for (const f of Object.keys(spec.tokens)) out[f] = null;
  Object.assign(out, { allowedSenderIds: [], projectId: null, agentProfileId: null });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) throw new Error(`${kind} must be an object`);
    return out;
  }
  const r = /** @type {Record<string, unknown>} */ (raw);
  const str = (/** @type {string} */ name) => {
    const v = r[name];
    if (v == null || v === "") return null;
    if (typeof v !== "string") {
      if (strict) throw new Error(`${kind}.${name} must be a string or null`);
      return null;
    }
    return v.trim() || null;
  };
  out.enabled = r.enabled === true;
  for (const [f, prefix] of Object.entries(spec.tokens)) {
    out[f] = str(f);
    if (strict && prefix && out[f] && !out[f].startsWith(prefix)) {
      throw new Error(`${spec.label} ${f === "appToken" ? "app-level token" : "bot token"} must start with ${prefix}`);
    }
  }
  out.projectId = str("projectId");
  out.agentProfileId = str("agentProfileId");
  const ids = Array.isArray(r.allowedSenderIds) ? r.allowedSenderIds : [];
  if (strict && r.allowedSenderIds != null && !Array.isArray(r.allowedSenderIds)) {
    throw new Error(`${kind}.allowedSenderIds must be an array`);
  }
  for (const v of ids) {
    let id = String(v ?? "").trim();
    if (kind === "slack") id = id.toUpperCase();
    if (!spec.id.test(id)) {
      if (strict) throw new Error(`${spec.idError}: ${id || "(empty)"}`);
      continue;
    }
    if (!out.allowedSenderIds.includes(id)) out.allowedSenderIds.push(id);
  }
  return out;
}

/**
 * Per-host GitHub account choice and saved token (#1528). `account` picks a
 * `gh` login for the host; `token` is used instead of gh entirely. Rows with
 * neither are dropped. strict (settings:set) throws; lenient (load) drops junk.
 * @param {unknown} raw
 * @param {boolean} strict
 * @returns {Array<{ host: string, account: string | null, token: string | null }>}
 */
function normalizeGithubHosts(raw, strict) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    if (strict) throw new Error("githubHosts must be an array");
    return [];
  }
  /** @type {Map<string, { host: string, account: string | null, token: string | null }>} */
  const byHost = new Map();
  for (const row of raw) {
    const r = /** @type {{ host?: unknown, account?: unknown, token?: unknown }} */ (row || {});
    const host = typeof r.host === "string" ? r.host.trim().toLowerCase() : "";
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) {
      if (strict) throw new Error("githubHosts[].host must be a hostname like github.com");
      continue;
    }
    const pick = (/** @type {unknown} */ v, /** @type {string} */ name) => {
      if (v == null || v === "") return null;
      if (typeof v !== "string") {
        if (strict) throw new Error(`githubHosts[].${name} must be a string or null`);
        return null;
      }
      return v.trim() || null;
    };
    const account = pick(r.account, "account");
    const token = pick(r.token, "token");
    if (!account && !token) continue;
    byHost.set(host, { host, account, token });
  }
  return [...byHost.values()];
}

module.exports = {
  isHttpUrl,
  validateAgentProfiles,
  matchingProfileId,
  parsePromptSnippets,
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  normalizeDefaultProvider,
  normalizeDefaultModel,
  normalizeGitTextModel,
  validateGitTextModel,
  validateQuotaFailover,
  normalizeQuotaFailover,
  normalizeSettings,
  normalizeOtel,
  normalizeWebhook,
  normalizeNotifyEvents,
  normalizeSpeechSettings,
  SPEECH_PROVIDERS,
  normalizeGithubHosts,
  normalizeChannel,
  CHANNEL_KINDS,
  TITLE_INSTRUCTIONS_MAX,
  COMMIT_MESSAGE_INSTRUCTIONS_MAX,
  PR_INSTRUCTIONS_MAX,
};
