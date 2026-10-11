"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateSubagentPool } = require("./subagentPool");
const { clampUiScale } = require("./zoom.js");
const { validateMcpServers, mergeMcpSettingsPatch } = require("./mcp.js");
const { validateProviderInstances } = require("./providerInstances.js");
const { validateModelPrices } = require("./modelPrices.js");
const {
  isHttpUrl,
  validateAgentProfiles,
  matchingProfileId,
  parsePromptSnippets,
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  normalizeDefaultProvider,
  normalizeDefaultModel,
  validateQuotaFailover,
  normalizeSettings,
  normalizeOtel,
  normalizeWebhook,
  normalizeGithubHosts,
} = require("./store-normalize.js");

/**
 * Custom worktree root (#1531): null/empty = the default; otherwise an
 * absolute, existing, writable directory.
 * @param {unknown} v
 * @returns {string | null}
 */
function validateWorktreeRoot(v) {
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "string") {
    throw new Error("worktreeRoot must be a string or null");
  }
  const dir = v.trim();
  if (!path.isAbsolute(dir)) {
    throw new Error("Worktree location must be an absolute path");
  }
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`Worktree location is not a writable directory: ${dir}`);
  }
  return dir;
}

/** Store settings read/patch methods; store.js copies them onto Store.prototype. */
class StoreSettingsMethods {
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
      stripAgentCoauthors: n.stripAgentCoauthors,
      mcpServers: n.mcpServers,
      defaultWorktree: n.defaultWorktree,
      defaultOrchestrate: n.defaultOrchestrate,
      defaultProvider: n.defaultProvider,
      defaultModel: n.defaultModel,
      quotaFailover: n.quotaFailover,
      onboardingSeen: n.onboardingSeen,
      updateChannel: n.updateChannel,
      notifications: n.notifications,
      notificationSound: n.notificationSound,
      feltEstimatePrompt: n.feltEstimatePrompt,
      uiScale: n.uiScale,
      theme: n.theme,
      agentsPanelDefault: n.agentsPanelDefault,
      agentsPanelRememberLast: n.agentsPanelRememberLast,
      stayAwake: n.stayAwake,
      quotaWaitAutoResume: n.quotaWaitAutoResume,
      confirmQuitWithActiveWork: n.confirmQuitWithActiveWork,
      resumeInterruptedRuns: n.resumeInterruptedRuns,
      guardrailsEnabled: n.guardrailsEnabled,
      prDiffCapLines: n.prDiffCapLines,
      maxConcurrentRuns: n.maxConcurrentRuns,
      agentProfiles: n.agentProfiles,
      providerInstances: n.providerInstances,
      defaultOrchestratorProfileId: n.defaultOrchestratorProfileId,
      promptSnippets: n.promptSnippets,
      subagentPool: n.subagentPool,
      otel: n.otel,
      linearApiKey: n.linearApiKey,
      githubHosts: n.githubHosts,
      webhook: n.webhook,
      modelPrices: n.modelPrices,
      worktreeRoot: n.worktreeRoot,
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
    if (Object.prototype.hasOwnProperty.call(patch, "maxConcurrentRuns")) {
      const v = patch.maxConcurrentRuns;
      if (v !== null && !(Number.isInteger(v) && v > 0)) {
        throw new Error(
          `Max concurrent runs must be a positive integer or null (got ${String(v)})`,
        );
      }
      this.data.settings.maxConcurrentRuns = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoSettleOnMerge")) {      const v = patch.autoSettleOnMerge;
      if (typeof v !== "boolean") {
        throw new Error("autoSettleOnMerge must be a boolean");
      }
      this.data.settings.autoSettleOnMerge = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "stripAgentCoauthors")) {
      const v = patch.stripAgentCoauthors;
      if (typeof v !== "boolean") {
        throw new Error("stripAgentCoauthors must be a boolean");
      }
      this.data.settings.stripAgentCoauthors = v;
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
    if (Object.prototype.hasOwnProperty.call(patch, "providerInstances")) {
      this.data.settings.providerInstances = validateProviderInstances(
        patch.providerInstances,
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
    if (Object.prototype.hasOwnProperty.call(patch, "notificationSound")) {
      const v = patch.notificationSound;
      if (typeof v !== "boolean") {
        throw new Error("notificationSound must be a boolean");
      }
      this.data.settings.notificationSound = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "promptSnippets")) {
      this.data.settings.promptSnippets = parsePromptSnippets(
        patch.promptSnippets,
        true,
      );
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
    if (Object.prototype.hasOwnProperty.call(patch, "confirmQuitWithActiveWork")) {
      const v = patch.confirmQuitWithActiveWork;
      if (typeof v !== "boolean") {
        throw new Error("confirmQuitWithActiveWork must be a boolean");
      }
      this.data.settings.confirmQuitWithActiveWork = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "worktreeRoot")) {
      this.data.settings.worktreeRoot = validateWorktreeRoot(patch.worktreeRoot);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "resumeInterruptedRuns")) {
      const v = patch.resumeInterruptedRuns;
      if (typeof v !== "boolean") {
        throw new Error("resumeInterruptedRuns must be a boolean");
      }
      this.data.settings.resumeInterruptedRuns = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "guardrailsEnabled")) {
      const v = patch.guardrailsEnabled;
      if (typeof v !== "boolean") {
        throw new Error("guardrailsEnabled must be a boolean");
      }
      this.data.settings.guardrailsEnabled = v;
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
    if (Object.prototype.hasOwnProperty.call(patch, "githubHosts")) {
      // The renderer only sees hasToken, so a row without a `token` key keeps
      // the saved one; null or "" clears it.
      const prev = new Map(
        (this.data.settings.githubHosts || []).map((r) => [r.host, r.token]),
      );
      const rows = Array.isArray(patch.githubHosts)
        ? patch.githubHosts.map((r) => {
            if (!r || typeof r !== "object" || "token" in r) return r;
            const host = typeof r.host === "string" ? r.host.trim().toLowerCase() : "";
            return { ...r, token: prev.get(host) ?? null };
          })
        : patch.githubHosts;
      this.data.settings.githubHosts = normalizeGithubHosts(rows, true);
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
    if (Object.prototype.hasOwnProperty.call(patch, "modelPrices")) {
      // Whole-map replace: the editor sends every row, so a dropped row clears.
      this.data.settings.modelPrices = validateModelPrices(patch.modelPrices);
    }
    return this.getSettings();
  }
}

module.exports = StoreSettingsMethods;
