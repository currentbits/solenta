/** App settings for the browser-dev fixture (Settings modal). */
import type {
  AppSettings,
  CoderApi,
  AgentProfile,
  ProviderInstance,
  McpServerInfo,
  PairingCreated,
  PairingCreateInput,
  PairingInfo,
  PairingList,
  SubagentPool,
  OtelSettings,
  WebhookSettings,
  ThreadInfo,
} from "../shared/ipc";
import {
  mergeMcpSettingsPatch,
  redactSettings,
  validateMcpServers,
} from "../shared/mcpModel.ts";
import type { DevCtx } from "./context.ts";
import { redactDevMcp } from "./mcp.ts";

export const SETTINGS_BUDGET_ERROR =
  "Daily budget must be a positive number or null";
export const SETTINGS_ORCH_BUDGET_ERROR =
  "Orchestration budget must be a positive number or null";

export function createSettings(ctx: DevCtx): Pick<CoderApi, "settings" | "stayAwake"> {
  /** Per-orchestration crew spend ceiling (Settings); null = no cap. */
  let orchestrationBudgetUsd: number | null = null;
  /** Default 3 = AUTO_SETTLE_AFTER_DAYS; null disables. */
  let autoSettleAfterDays: number | null = 3;
  /** Default true = MERGED PRs auto-settle. */
  let autoSettleOnMerge = true;
  /** PR size cap in lines (issue #402); default 400, null disables. */
  let prDiffCapLines: number | null = 400;
  /** Default new threads into a fake worktree (Settings toggle). */
  let defaultWorktree = false;
  /** Default new threads as orchestrators (Settings toggle). */
  let defaultOrchestrate = false;
  let defaultProvider: string | null = null;
  let defaultModel: string | null = null;
  let quotaFailover: string[] = [];
  /** First-run onboarding wizard finished or skipped. */
  let onboardingSeen = false;
  /** Update channel override; null follows the (absent) dev stamp. */
  let updateChannel: "prod" | "nightly" | null = null;
  let notifications = true;
  let notificationSound = false;
  let feltEstimatePrompt = false;
  let uiScale = 1;
  let theme: AppSettings["theme"] = "dark";
  let agentsPanelDefault: AppSettings["agentsPanelDefault"] = "closed";
  let agentsPanelRememberLast = false;
  let stayAwake: AppSettings["stayAwake"] = "agent";
  let confirmQuitWithActiveWork = true;
  let guardrailsEnabled = true;
  let otel: OtelSettings = { endpoint: null, headers: {}, claudeMetrics: false };
  let webhook: WebhookSettings = {
    url: null,
    onDone: true,
    onFailed: true,
    onWaiting: true,
  };
  /** Saved agent profiles (Settings tab), in-memory. */
  let agentProfiles: AgentProfile[] = [];
  let providerInstances: ProviderInstance[] = [];
  /** Planboard Orchestrator: Default (#725). */
  let defaultOrchestratorProfileId: string | null = null;
  /** Described worker-model pool (Settings), in-memory. */
  let subagentPool: SubagentPool = {
    defaultAlias: null,
    force: false,
    entries: [],
  };
  const parseBudgetPatch = (patch: Partial<AppSettings>): number | null => {
    if (!Object.prototype.hasOwnProperty.call(patch, "dailyBudgetUsd")) {
      return ctx.dailyBudgetUsd;
    }
    const v = patch.dailyBudgetUsd;
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(SETTINGS_BUDGET_ERROR);
    }
    return v;
  };

  const parseOrchBudgetPatch = (patch: Partial<AppSettings>): number | null => {
    if (!Object.prototype.hasOwnProperty.call(patch, "orchestrationBudgetUsd")) {
      return orchestrationBudgetUsd;
    }
    const v = patch.orchestrationBudgetUsd;
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(SETTINGS_ORCH_BUDGET_ERROR);
    }
    return v;
  };

  const SETTINGS_SETTLE_ERROR =
    "Auto-settle days must be a positive integer or null";

  const parseSettleDaysPatch = (
    patch: Partial<AppSettings>,
  ): number | null => {
    if (!Object.prototype.hasOwnProperty.call(patch, "autoSettleAfterDays")) {
      return autoSettleAfterDays;
    }
    const v = patch.autoSettleAfterDays;
    if (v === null) return null;
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      !Number.isInteger(v) ||
      !(v > 0)
    ) {
      throw new Error(`${SETTINGS_SETTLE_ERROR} (got ${String(v)})`);
    }
    return v;
  };

  return {
    settings: {
      async get(): Promise<AppSettings> {
        return redactSettings({
          dailyBudgetUsd: ctx.dailyBudgetUsd,
          orchestrationBudgetUsd,
          autoSettleAfterDays,
          autoSettleOnMerge,
          prDiffCapLines,
          mcpServers: ctx.mcpServers,
          defaultWorktree,
          defaultOrchestrate,
          defaultProvider,
          defaultModel,
          quotaFailover: quotaFailover.slice(),
          onboardingSeen,
          updateChannel,
          notifications,
          notificationSound,
          feltEstimatePrompt,
          uiScale,
          theme,
          agentsPanelDefault,
          agentsPanelRememberLast,
          stayAwake,
          quotaWaitAutoResume: ctx.quotaWaitAutoResume,
          confirmQuitWithActiveWork,
          guardrailsEnabled,
          agentProfiles: agentProfiles.map((p) => ({ ...p })),
          providerInstances: providerInstances.map((p) => ({ ...p, env: { ...p.env } })),
          defaultOrchestratorProfileId,
          subagentPool: {
            ...subagentPool,
            entries: subagentPool.entries.map((e) => ({ ...e })),
          },
          otel: { ...otel, headers: { ...otel.headers } },
          webhook: { ...webhook },
        }) as AppSettings;
      },
      async set(patch: Partial<AppSettings>): Promise<AppSettings> {
        ctx.dailyBudgetUsd = parseBudgetPatch(patch);
        orchestrationBudgetUsd = parseOrchBudgetPatch(patch);
        autoSettleAfterDays = parseSettleDaysPatch(patch);
        if (Object.prototype.hasOwnProperty.call(patch, "autoSettleOnMerge")) {
          if (typeof patch.autoSettleOnMerge !== "boolean") {
            throw new Error("autoSettleOnMerge must be a boolean");
          }
          autoSettleOnMerge = patch.autoSettleOnMerge;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "prDiffCapLines")) {
          const v = patch.prDiffCapLines;
          if (
            v !== null &&
            (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
          ) {
            throw new Error("PR diff cap must be a positive integer or null");
          }
          prDiffCapLines = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "mcpServers")) {
          if (!Array.isArray(patch.mcpServers)) {
            throw new Error("mcpServers must be an array");
          }
          ctx.mcpServers = validateMcpServers(
            mergeMcpSettingsPatch(ctx.mcpServers, patch.mcpServers),
          ) as McpServerInfo[];
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultWorktree")) {
          if (typeof patch.defaultWorktree !== "boolean") {
            throw new Error("defaultWorktree must be a boolean");
          }
          defaultWorktree = patch.defaultWorktree;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultOrchestrate")) {
          if (typeof patch.defaultOrchestrate !== "boolean") {
            throw new Error("defaultOrchestrate must be a boolean");
          }
          defaultOrchestrate = patch.defaultOrchestrate;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultProvider")) {
          const v = patch.defaultProvider;
          if (v !== null && typeof v !== "string") {
            throw new Error("defaultProvider must be a string or null");
          }
          defaultProvider = v && v.trim() ? v.trim() : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "defaultModel")) {
          const v = patch.defaultModel;
          if (v !== null && typeof v !== "string") {
            throw new Error("defaultModel must be a string or null");
          }
          defaultModel = v && v.trim() ? v.trim() : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "quotaFailover")) {
          if (!Array.isArray(patch.quotaFailover)) {
            throw new Error("quotaFailover must be an array");
          }
          const seen = new Set<string>();
          quotaFailover = [];
          for (const item of patch.quotaFailover) {
            if (typeof item !== "string" || !item.trim()) {
              throw new Error("quotaFailover entries must be non-empty strings");
            }
            const id = item.trim();
            if (seen.has(id)) continue;
            seen.add(id);
            quotaFailover.push(id);
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, "onboardingSeen")) {
          if (typeof patch.onboardingSeen !== "boolean") {
            throw new Error("onboardingSeen must be a boolean");
          }
          onboardingSeen = patch.onboardingSeen;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "updateChannel")) {
          const v = patch.updateChannel;
          if (v !== null && v !== "prod" && v !== "nightly") {
            throw new Error('updateChannel must be "prod", "nightly", or null');
          }
          updateChannel = v ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "notifications")) {
          if (typeof patch.notifications !== "boolean") {
            throw new Error("notifications must be a boolean");
          }
          notifications = patch.notifications;
        }
        if (
          Object.prototype.hasOwnProperty.call(patch, "notificationSound")
        ) {
          if (typeof patch.notificationSound !== "boolean") {
            throw new Error("notificationSound must be a boolean");
          }
          notificationSound = patch.notificationSound;
        }
        if (
          Object.prototype.hasOwnProperty.call(patch, "feltEstimatePrompt")
        ) {
          if (typeof patch.feltEstimatePrompt !== "boolean") {
            throw new Error("feltEstimatePrompt must be a boolean");
          }
          feltEstimatePrompt = patch.feltEstimatePrompt;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "uiScale")) {
          const v = patch.uiScale;
          if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new Error("uiScale must be a number");
          }
          const stepped = Math.round(v * 10) / 10;
          uiScale = Math.min(1.6, Math.max(0.8, stepped));
        }
        if (Object.prototype.hasOwnProperty.call(patch, "theme")) {
          const v = patch.theme;
          if (v !== "system" && v !== "light" && v !== "dark") {
            throw new Error('theme must be "system", "light", or "dark"');
          }
          theme = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "agentsPanelDefault")) {
          const v = patch.agentsPanelDefault;
          if (v !== "closed" && v !== "open") {
            throw new Error('agentsPanelDefault must be "closed" or "open"');
          }
          agentsPanelDefault = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "agentsPanelRememberLast")) {
          if (typeof patch.agentsPanelRememberLast !== "boolean") {
            throw new Error("agentsPanelRememberLast must be a boolean");
          }
          agentsPanelRememberLast = patch.agentsPanelRememberLast;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "stayAwake")) {
          const v = patch.stayAwake;
          if (v !== "agent" && v !== "on" && v !== "off") {
            throw new Error('stayAwake must be "agent", "on", or "off"');
          }
          stayAwake = v;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "quotaWaitAutoResume")) {
          if (typeof patch.quotaWaitAutoResume !== "boolean") {
            throw new Error("quotaWaitAutoResume must be a boolean");
          }
          ctx.quotaWaitAutoResume = patch.quotaWaitAutoResume;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "confirmQuitWithActiveWork")) {
          if (typeof patch.confirmQuitWithActiveWork !== "boolean") {
            throw new Error("confirmQuitWithActiveWork must be a boolean");
          }
          confirmQuitWithActiveWork = patch.confirmQuitWithActiveWork;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "guardrailsEnabled")) {
          if (typeof patch.guardrailsEnabled !== "boolean") {
            throw new Error("guardrailsEnabled must be a boolean");
          }
          guardrailsEnabled = patch.guardrailsEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "agentProfiles")) {
          if (!Array.isArray(patch.agentProfiles)) {
            throw new Error("agentProfiles must be an array");
          }
          agentProfiles = patch.agentProfiles.map((p) => ({ ...p }));
          if (
            defaultOrchestratorProfileId &&
            !agentProfiles.some((p) => p.id === defaultOrchestratorProfileId)
          ) {
            defaultOrchestratorProfileId = null;
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, "providerInstances")) {
          if (!Array.isArray(patch.providerInstances)) {
            throw new Error("providerInstances must be an array");
          }
          providerInstances = patch.providerInstances.map((p) => ({ ...p, env: { ...p.env } }));
        }
        if (
          Object.prototype.hasOwnProperty.call(
            patch,
            "defaultOrchestratorProfileId",
          )
        ) {
          const v = patch.defaultOrchestratorProfileId;
          if (v !== null && typeof v !== "string") {
            throw new Error(
              "defaultOrchestratorProfileId must be a string or null",
            );
          }
          const id = v != null ? v.trim() : "";
          if (id && !agentProfiles.some((p) => p.id === id)) {
            throw new Error(
              "defaultOrchestratorProfileId must match an agent profile or be null",
            );
          }
          defaultOrchestratorProfileId = id || null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "subagentPool")) {
          const v = patch.subagentPool;
          if (!v || typeof v !== "object" || Array.isArray(v)) {
            throw new Error("subagentPool must be an object");
          }
          if (!Array.isArray(v.entries)) {
            throw new Error("subagentPool.entries must be an array");
          }
          subagentPool = {
            defaultAlias: v.defaultAlias ?? null,
            force: v.force === true,
            entries: v.entries.map((e) => ({ ...e })),
          };
        }
        if (Object.prototype.hasOwnProperty.call(patch, "otel")) {
          const v = patch.otel;
          if (!v || typeof v !== "object") {
            throw new Error("otel must be an object");
          }
          if (
            v.endpoint != null &&
            !/^https?:\/\/\S+$/.test(String(v.endpoint).trim())
          ) {
            throw new Error("OTLP endpoint must be an http(s) URL or null");
          }
          otel = {
            endpoint: v.endpoint ? String(v.endpoint).trim().replace(/\/+$/, "") : null,
            headers: { ...(v.headers ?? {}) },
            claudeMetrics: v.claudeMetrics === true,
          };
        }
        if (Object.prototype.hasOwnProperty.call(patch, "webhook")) {
          const v = patch.webhook;
          if (!v || typeof v !== "object") {
            throw new Error("webhook must be an object");
          }
          if (
            v.url != null &&
            v.url !== "" &&
            !/^https?:\/\/\S+$/.test(String(v.url).trim())
          ) {
            throw new Error("Webhook URL must be an http(s) URL or empty");
          }
          webhook = {
            url: v.url ? String(v.url).trim() : null,
            onDone: v.onDone !== false,
            onFailed: v.onFailed !== false,
            onWaiting: v.onWaiting !== false,
          };
        }
        return {
          dailyBudgetUsd: ctx.dailyBudgetUsd,
          orchestrationBudgetUsd,
          autoSettleAfterDays,
          autoSettleOnMerge,
          prDiffCapLines,
          mcpServers: ctx.mcpServers.map(redactDevMcp) as AppSettings["mcpServers"],
          defaultWorktree,
          defaultOrchestrate,
          defaultProvider,
          defaultModel,
          quotaFailover: quotaFailover.slice(),
          onboardingSeen,
          updateChannel,
          notifications,
          notificationSound,
          feltEstimatePrompt,
          uiScale,
          theme,
          agentsPanelDefault,
          agentsPanelRememberLast,
          stayAwake,
          quotaWaitAutoResume: ctx.quotaWaitAutoResume,
          confirmQuitWithActiveWork,
          guardrailsEnabled,
          agentProfiles: agentProfiles.map((p) => ({ ...p })),
          providerInstances: providerInstances.map((p) => ({ ...p, env: { ...p.env } })),
          defaultOrchestratorProfileId,
          subagentPool: {
            ...subagentPool,
            entries: subagentPool.entries.map((e) => ({ ...e })),
          },
          otel: { ...otel, headers: { ...otel.headers } },
          webhook: { ...webhook },
        };
      },
      async testWebhook() {
        // ponytail: dev browser has no main process to POST from; report the
        // shape the real handler returns so the Settings row stays exercisable.
        if (!webhook.url) return { ok: false, error: "Save an http(s) webhook URL first" };
        return { ok: true, status: 200 };
      },
    },
    stayAwake: {
      // ponytail: no real power blocker in the dev browser; mirror the shape
      // main returns so the sidebar control stays exercisable.
      async status() {
        const anyWorking = ctx.threads.some((t) => t.status === "working");
        return {
          mode: stayAwake,
          blocking:
            stayAwake === "on" || (stayAwake === "agent" && anyWorking),
          onBattery: false,
          anyWorking,
        };
      },
    },
  };
}

export function createPairing(ctx: DevCtx): Pick<CoderApi, "pairing"> {
  let pairings: PairingInfo[] = [];

  return {
    pairing: {
      async list(): Promise<PairingList> {
        return {
          pairings,
          server: { running: true, port: 7422, url: "http://127.0.0.1:7422/mcp" },
        };
      },
      async create(input: PairingCreateInput): Promise<PairingCreated> {
        const pairing: PairingInfo = {
          id: `pair-${pairings.length + 1}`,
          name: String(input.name || "Pairing").trim() || "Pairing",
          tokenPrefix: "devtoken",
          capabilities: input.capabilities ?? ["read", "launch"],
          projectIds: input.projectIds ?? null,
          expiresAt:
            input.ttlMs === 0 || input.ttlMs == null
              ? input.ttlMs === 0
                ? null
                : Date.now() + 30 * 24 * 60 * 60 * 1000
              : Date.now() + input.ttlMs,
          createdAt: Date.now(),
          lastUsedAt: null,
          revokedAt: null,
          requireApproval: input.requireApproval !== false,
          managedWorktree: input.managedWorktree !== false,
          launchesPerHour: input.launchesPerHour ?? 30,
          readsPerMinute: input.readsPerMinute ?? 120,
        };
        pairings = pairings.concat(pairing);
        const token = "d".repeat(64);
        const url = "http://127.0.0.1:7422/mcp";
        const claudeDesktopJson = JSON.stringify(
          {
            mcpServers: {
              solenta: {
                type: "http",
                url,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2,
        );
        return {
          pairing,
          token,
          url,
          claudeDesktopJson,
          pairingPrompt: `Connect to Solenta at ${url}`,
        };
      },
      async revoke(input: { id: string }): Promise<PairingInfo> {
        const existing = pairings.find((p) => p.id === input.id);
        if (!existing) throw new Error(`Unknown pairing: ${input.id}`);
        const revoked = { ...existing, revokedAt: Date.now() };
        pairings = pairings.filter((p) => p.id !== input.id);
        return revoked;
      },
      async approve(input: { threadId: string }) {
        const t = ctx.threads.find((row) => row.id === input.threadId);
        if (t) {
          t.pendingExternalApproval = false;
          t.pendingExternalPrompt = null;
        }
        return { runId: "dev-run" };
      },
      async reject(input: { threadId: string }): Promise<ThreadInfo> {
        const t = ctx.threads.find((row) => row.id === input.threadId);
        if (!t) throw new Error(`Unknown thread: ${input.threadId}`);
        t.pendingExternalApproval = false;
        t.pendingExternalPrompt = null;
        t.archived = true;
        return t;
      },
    },
  };
}
