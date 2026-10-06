"use strict";

const {
  normalizeIssueNumber,
  normalizePostMerge,
} = require("./postmerge.js");
const { normalizeAcceptedHunks } = require("./reviewItinerary.js");
const { normalizeBtwCards } = require("./btw.js");
const { normalizePendingQuestion } = require("./questions.js");
const { normalizeMessagePins } = require("./messagePins.js");
const {
  normalizeSetupCommand,
  normalizeQuickActions,
  normalizeThreadDefaults,
} = require("./projectCommands.js");

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
  // Scratch (#1411): the one projectless workspace. Strictly boolean.
  if (next.scratch === true) next.scratch = true;
  else delete next.scratch;
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
  const threadDefaults = normalizeThreadDefaults(next.threadDefaults);
  if (threadDefaults) next.threadDefaults = threadDefaults;
  else delete next.threadDefaults;
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

module.exports = {
  STANDARD_TEMPLATE,
  cloneStandardTemplate,
  clonePhases,
  ensureWorkflowTemplates,
  migrateTemplateKimiModels,
  migrateAutomation,
  DEFAULT_WORKTREE_RETENTION,
  migrateProject,
  backfillFromNotice,
  migrateThread,
};
