import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentProfile,
  AppSettings,
  AppStatus,
  GcCleanInput,
  GcCleanResult,
  GcScanResult,
  MergeSpotlight,
  OtelSettings,
  WebhookSettings,
  WebhookTestResult,
  ProjectInfo,
  ProviderInfo,
  SourceControlDiscovery,
  SubagentPool,
  UpdateStatus,
} from "../shared/ipc";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import type { MemoryProjectToolsApi } from "./MemoryTab";
import { SkillsManager, type SkillsManagerProps } from "./SkillsTab";
import styles from "./SettingsModal.module.css";
import { IntegrationsSection } from "./IntegrationsSection";
import { ChannelsSection } from "./settings/ChannelsSection";
import { ConnectionsSection } from "./ConnectionsSection";
import { WebAccessSection } from "./WebAccessSection";
import { isWebMode } from "../shared/wire";
import type { CoderApi, SidebarHostStatus } from "../shared/ipc";
import { PaneIcon } from "./settings/PaneIcon";
import { SpendingPane } from "./settings/SpendingPane";
import { ThreadsPane } from "./settings/ThreadsPane";
import { GitPane } from "./settings/GitPane";
import { MemoryPane } from "./settings/MemoryPane";
import { AdvancedPane, formatOtelHeaders } from "./settings/AdvancedPane";
import {
  AgentsPane,
  type PoolDraft,
  type ProfileDraft,
} from "./settings/AgentsPane";
import { GeneralPane } from "./settings/GeneralPane";
import { ProvidersPane } from "./settings/ProvidersPane";
import { KeyboardPane } from "./settings/KeyboardPane";
import { SETTINGS_INDEX } from "../settingsIndex";

export { formatOtelHeaders, parseOtelHeaders } from "./settings/AdvancedPane";

export const SETTINGS_PANES = [
  "general",
  "keyboard",
  "threads",
  "spending",
  "git",
  "providers",
  "agents",
  "memory",
  "skills",
  "connections",
  "integrations",
  "advanced",
] as const;

export type SettingsPane = (typeof SETTINGS_PANES)[number];

const PANE_META: Record<
  SettingsPane,
  { label: string; hint: string; keywords: string }
> = {
  general: {
    label: "General",
    hint: "Display, notifications, the welcome tour, and this build.",
    keywords:
      "notifications notification projects filter sound badge dock tour welcome update version build channel nightly prod felt estimate time saved webhook slack discord ntfy push phone agents panel sidebar collapse remember last quit confirm accidental close display divergence compare run duration paste cards vim motions",
  },
  keyboard: {
    label: "Keyboard",
    hint: "Remap app shortcuts. Anything you leave alone keeps its default.",
    keywords: "shortcuts keybindings hotkeys chord remap keys",
  },
  threads: {
    label: "Threads",
    hint: "How new threads start, and when quiet ones leave the attention list.",
    keywords:
      "worktree isolate orchestrate delegate settle sidebar quota resume default provider model failover bug report feedback",
  },
  spending: {
    label: "Spending",
    hint: "Caps that stop a runaway day or a runaway crew.",
    keywords: "budget daily orchestration spend usd cap money cost unmetered kimi cursor concurrent concurrency parallel runs queue",
  },
  git: {
    label: "Git",
    hint: "Source control, Linear tickets, PR size, worktree disk, and Spotlight.",
    keywords:
      "github gitlab bitbucket azure source control pr pull request worktree gc disk cleanup linear ticket api key sentry spotlight lanes preview",
  },
  providers: {
    label: "Providers",
    hint: "Sign in, API keys, base URLs and models for each agent CLI, plus custom OpenAI-compatible providers.",
    keywords:
      "provider sign in login logout api key base url anthropic openai xai cursor claude codex grok opencode kimi muse install instance account chatgpt config folder custom cli openai-compatible models favourite favorite environment env",
  },
  agents: {
    label: "Agents",
    hint: "Named profiles and prompt snippets for the composer, and the worker pool. Sign-in and keys live in Providers.",
    keywords:
      "profile provider model effort permission pool worker alias candidate orchestrator default snippet prompt text boilerplate template",
  },
  memory: {
    label: "Memory",
    hint: "The local memory server, plus each project's code map and config doctor.",
    keywords: "memory entries vectors janitor server port embed code map config doctor agents.md claude.md project tools",
  },
  skills: {
    label: "Skills & MCP",
    hint: "The skill catalog, MCP servers, and imports every agent shares.",
    keywords:
      "skills mcp server catalog curated import harness plugin add skill write manually github claude codex cursor grok kimi",
  },
  connections: {
    label: "Connections",
    hint: "Use this Solenta from your phone or a browser, or open the Solenta running on another computer.",
    keywords: "remote ssh host server tunnel workstation web token phone device qr pair tailscale https lan network browser",
  },
  integrations: {
    label: "Integrations",
    hint: "Pair an external MCP client, or start threads from Telegram, Slack or Discord.",
    keywords:
      "mcp pairing claude desktop claude code token integrations external agent connect telegram chat bot channel slack discord phone message",
  },
  advanced: {
    label: "Advanced",
    hint: "Guardrails, the privacy gateway, telemetry export, and importing Vibe Kanban boards.",
    keywords: "guardrails safety security protection tools secrets injection privacy gateway redact redaction pii personal data email otel opentelemetry otlp traces headers vibe kanban import",
  },
};

function isSettingsPane(value: string | null | undefined): value is SettingsPane {
  return (
    value != null && (SETTINGS_PANES as readonly string[]).includes(value)
  );
}

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Open onto a specific pane (sidebar worktree usage deep-links to Git). */
  initialPane?: SettingsPane | null;
  /** Current settings (budget + auto-settle window). */
  settings: AppSettings | null;
  /** Provider catalogue for the profiles form. Unavailable CLIs stay listed. */
  providers?: ProviderInfo[];
  /** Re-list providers (re-probes sign-in) when Settings › Providers or Agents opens. */
  onRefreshProviders?: () => void;
  /**
   * Start a provider's login command in a terminal (#1501). `install` and
   * `logout` type the install or logout command instead (#1714).
   */
  onProviderSignIn?: (
    providerId: string,
    opts?: { name?: string; install?: boolean; logout?: boolean },
  ) => Promise<void>;
  /** Live app status for the memory section. */
  status: AppStatus | null;
  /** Auto-update check result for the build section. */
  update?: UpdateStatus | null;
  /** Manual "Check for updates". */
  onCheckUpdate?: () => Promise<void>;
  /** Download + install an available update. Nothing installs without this. */
  onDownloadUpdate?: () => Promise<void>;
  /** Relaunch into a staged update. */
  onApplyUpdate?: () => Promise<void>;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** "Send test": POST to the saved webhook URL now (issue #167). */
  onTestWebhook?: () => Promise<WebhookTestResult>;
  /** Optional GC seam. When omitted the section reads window.coder. */
  projects?: ProjectInfo[];
  onGcScan?: () => Promise<GcScanResult>;
  onGcClean?: (input: GcCleanInput) => Promise<GcCleanResult>;
  /** Optional forge probe (#608). When omitted the section reads window.coder. */
  onDiscoverSourceControl?: (input?: {
    rescan?: boolean;
  }) => Promise<SourceControlDiscovery>;
  /** Relaunch the first-run welcome tour (#628). */
  onShowOnboarding?: () => void;
  onOpenConnection?: CoderApi["app"]["openRemoteConnection"];
  onForgetConnection?: CoderApi["app"]["forgetRemoteConnection"];
  onInstallSolenta?: CoderApi["app"]["installRemoteSolenta"];
  onSidebarHosts?: CoderApi["app"]["setSidebarHosts"];
  /** Live state of the Connections shown in the sidebar (#1819). */
  sidebarHosts?: SidebarHostStatus[];
  /** Optional memory-scope rename seam (#179). When omitted reads window.coder. */
  onRenameMemoryScope?: CoderApi["memory"]["renameScope"];
  /** Project picker default for Spotlight and Project tools: the selected thread's project. */
  currentProjectId?: string | null;
  /** Per-project Spotlight opt-in (moved from the Environment Lanes card). */
  onSetSpotlight?: (input: {
    projectId: string;
    enabled: boolean;
  }) => Promise<MergeSpotlight>;
  /** Code map + config doctor (moved from the Memory tab). */
  projectTools?: MemoryProjectToolsApi;
  /** Catalog, MCP servers, imports and Add skill (moved from the Skills tab). */
  skills?: Omit<SkillsManagerProps, "projectPath">;
}

function budgetToInput(value: number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

function settleDaysToInput(value: number | null | undefined): string {
  // null = Never (empty). undefined while loading → treat as empty draft.
  if (value == null) return "";
  return String(value);
}

function parseNumericDraft(text: string): number | null {
  const raw = text.trim();
  return raw === "" ? null : Number(raw);
}

export type SettingsDraftKey =
  | "daily"
  | "orch"
  | "settle"
  | "pr"
  | "runs"
  | "uiScale"
  | "linear"
  | "sentry"
  | "otel"
  | "webhook";

const EMPTY_OTEL: OtelSettings = {
  endpoint: null,
  headers: {},
  claudeMetrics: false,
};

const EMPTY_WEBHOOK: WebhookSettings = {
  url: null,
  onDone: true,
  onFailed: true,
  onWaiting: true,
};

function settingsDraftSnapshot(settings: AppSettings | null) {
  const otel = settings?.otel ?? EMPTY_OTEL;
  const webhook = settings?.webhook ?? EMPTY_WEBHOOK;
  return {
    daily: budgetToInput(settings?.dailyBudgetUsd ?? null),
    orch: budgetToInput(settings?.orchestrationBudgetUsd ?? null),
    settle: settleDaysToInput(settings?.autoSettleAfterDays ?? null),
    pr: budgetToInput(settings?.prDiffCapLines ?? null),
    runs: budgetToInput(settings?.maxConcurrentRuns ?? null),
    uiScale: settings?.uiScale ?? 1,
    linear: settings?.linearApiKey ?? "",
    sentry: settings?.sentryAuthToken ?? "",
    otelEndpoint: otel.endpoint ?? "",
    otelHeadersText: formatOtelHeaders(otel.headers),
    otelClaudeMetrics: otel.claudeMetrics,
    webhookUrl: webhook.url ?? "",
    webhookOnDone: webhook.onDone !== false,
    webhookOnFailed: webhook.onFailed !== false,
    webhookOnWaiting: webhook.onWaiting !== false,
  };
}

export function SettingsModal({
  open,
  onClose,
  initialPane = null,
  settings,
  providers = [],
  onRefreshProviders,
  onProviderSignIn,
  status,
  update,
  onCheckUpdate,
  onDownloadUpdate,
  onApplyUpdate,
  onSaveSettings,
  onTestWebhook,
  projects,
  onGcScan,
  onGcClean,
  onDiscoverSourceControl,
  onShowOnboarding,
  onOpenConnection,
  onForgetConnection,
  onInstallSolenta,
  onSidebarHosts,
  sidebarHosts,
  onRenameMemoryScope,
  currentProjectId = null,
  onSetSpotlight,
  projectTools,
  skills,
}: SettingsModalProps) {
  const [pane, setPane] = useState<SettingsPane>("general");
  const [navQuery, setNavQuery] = useState("");
  /** Selector of a "Find a setting" pick, scrolled to and flashed once its pane renders. */
  const [highlightTarget, setHighlightTarget] = useState<string | null>(null);
  const [budgetText, setBudgetText] = useState("");
  const [uiScale, setUiScale] = useState(1);
  const [orchBudgetText, setOrchBudgetText] = useState("");
  const [settleDaysText, setSettleDaysText] = useState("");
  const [prCapText, setPrCapText] = useState("");
  const [maxRunsText, setMaxRunsText] = useState("");
  const [linearKeyText, setLinearKeyText] = useState("");
  const [sentryKeyText, setSentryKeyText] = useState("");
  const [otelEndpoint, setOtelEndpoint] = useState("");
  const [otelHeadersText, setOtelHeadersText] = useState("");
  const [otelClaudeMetrics, setOtelClaudeMetrics] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookOnDone, setWebhookOnDone] = useState(true);
  const [webhookOnFailed, setWebhookOnFailed] = useState(true);
  const [webhookOnWaiting, setWebhookOnWaiting] = useState(true);
  const [webhookTest, setWebhookTest] = useState<
    "idle" | "sending" | WebhookTestResult
  >("idle");
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [poolDraft, setPoolDraft] = useState<PoolDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  /** Shared by Git → Spotlight and Memory → Project tools; reset on open. */
  const [toolsProjectId, setToolsProjectId] = useState<string | null>(null);
  const wasOpen = useRef(false);
  /** True once drafts have been filled from a real settings object. */
  const hydrated = useRef(false);
  const dirtyDrafts = useRef(new Set<SettingsDraftKey>());
  /** Sync guard: blur then Save-click can both fire before setSaving lands. */
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      hydrated.current = false;
      dirtyDrafts.current.clear();
      setHighlightTarget(null);
      return;
    }
    const justOpened = !wasOpen.current;
    wasOpen.current = true;

    const applyDrafts = (from: AppSettings | null, onlyClean: boolean) => {
      const snap = settingsDraftSnapshot(from);
      const skip = (key: SettingsDraftKey) =>
        onlyClean && dirtyDrafts.current.has(key);
      if (!skip("daily")) setBudgetText(snap.daily);
      if (!skip("orch")) setOrchBudgetText(snap.orch);
      if (!skip("settle")) setSettleDaysText(snap.settle);
      if (!skip("pr")) setPrCapText(snap.pr);
      if (!skip("runs")) setMaxRunsText(snap.runs);
      if (!skip("uiScale")) setUiScale(snap.uiScale);
      if (!skip("linear")) setLinearKeyText(snap.linear);
      if (!skip("sentry")) setSentryKeyText(snap.sentry);
      if (!skip("otel")) {
        setOtelEndpoint(snap.otelEndpoint);
        setOtelHeadersText(snap.otelHeadersText);
        setOtelClaudeMetrics(snap.otelClaudeMetrics);
      }
      if (!skip("webhook")) {
        setWebhookUrl(snap.webhookUrl);
        setWebhookOnDone(snap.webhookOnDone);
        setWebhookOnFailed(snap.webhookOnFailed);
        setWebhookOnWaiting(snap.webhookOnWaiting);
      }
    };

    if (justOpened) {
      setPane(isSettingsPane(initialPane) ? initialPane : "general");
      setToolsProjectId(currentProjectId);
      setNavQuery("");
      applyDrafts(settings, false);
      setWebhookTest("idle");
      setDraft(null);
      setPoolDraft(null);
      setError(null);
      setSaving(false);
      savingRef.current = false;
      hydrated.current = settings != null;
      return;
    }

    // Settings arrived after open: fill untouched drafts, keep dirty ones.
    if (!hydrated.current && settings != null) {
      applyDrafts(settings, true);
      hydrated.current = true;
    }
  }, [open, settings]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const handleClose = useCallback(() => {
    if (savingRef.current) return;
    onClose();
  }, [onClose]);

  useEscapeClose(open && !saving, handleClose);
  useModalFocus(open, dialogRef);

  useEffect(() => {
    if (!open || !isSettingsPane(initialPane)) return;
    setPane(initialPane);
  }, [open, initialPane]);

  // "Find a setting" jump: once the target pane has rendered, scroll to the
  // setting's own control and flash its row (same device as the sidebar's
  // #293 thread reveal).
  useEffect(() => {
    if (!highlightTarget) return;
    const selector = highlightTarget;
    // No cleanup: clearing highlightTarget right below re-runs this effect,
    // and a cleanup here would cancel the rAF it just scheduled before it
    // ever fires (same shape as the sidebar's #293 thread reveal effect).
    window.requestAnimationFrame(() => {
      const el = dialogRef.current?.querySelector(selector);
      if (el) {
        // Prefer the whole .field block (label + control); a standalone
        // checkbox row has no .field wrapper, so fall back to .fieldRow.
        const row =
          el.closest(`.${styles.field}`) ??
          el.closest(`.${styles.fieldRow}`) ??
          el;
        row.scrollIntoView({ block: "center" });
        row.classList.add(styles.settingFlash);
      }
    });
    setHighlightTarget(null);
  }, [highlightTarget, pane]);

  if (!open) return null;

  const navFilter = navQuery.trim().toLowerCase();
  const settingMatches = navFilter
    ? SETTINGS_INDEX.filter(
        (entry) =>
          entry.label.toLowerCase().includes(navFilter) ||
          entry.help.toLowerCase().includes(navFilter) ||
          (entry.keywords ?? "").toLowerCase().includes(navFilter),
      ).slice(0, 8)
    : [];
  const goToSetting = (entry: (typeof SETTINGS_INDEX)[number]) => {
    setPane(entry.pane);
    setHighlightTarget(entry.selector);
    setNavQuery("");
    setError(null);
  };
  const visiblePanes = SETTINGS_PANES.filter((id) => {
    if (id === "connections" && isWebMode()) return false;
    if (!navFilter) return true;
    const meta = PANE_META[id];
    return (
      meta.label.toLowerCase().includes(navFilter) ||
      meta.hint.toLowerCase().includes(navFilter) ||
      meta.keywords.includes(navFilter)
    );
  });
  const paneMeta = PANE_META[pane];
  const updateWaiting =
    update?.state === "available" || update?.state === "staged";

  const save = async () => {
    if (savingRef.current) return;
    const patch: Partial<AppSettings> = {};
    const putNumeric = (
      key:
        | "dailyBudgetUsd"
        | "orchestrationBudgetUsd"
        | "autoSettleAfterDays"
        | "prDiffCapLines"
        | "maxConcurrentRuns",
      text: string,
      draftKey: SettingsDraftKey,
    ) => {
      // Empty unhydrated drafts are "unknown", not "clear this cap".
      if (!hydrated.current && !dirtyDrafts.current.has(draftKey)) return;
      patch[key] = parseNumericDraft(text);
    };
    putNumeric("dailyBudgetUsd", budgetText, "daily");
    putNumeric("orchestrationBudgetUsd", orchBudgetText, "orch");
    putNumeric("autoSettleAfterDays", settleDaysText, "settle");
    putNumeric("prDiffCapLines", prCapText, "pr");
    putNumeric("maxConcurrentRuns", maxRunsText, "runs");
    if (Object.keys(patch).length === 0) return;

    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await onSaveSettings(patch);
      setBudgetText(budgetToInput(saved.dailyBudgetUsd));
      setOrchBudgetText(budgetToInput(saved.orchestrationBudgetUsd));
      setSettleDaysText(settleDaysToInput(saved.autoSettleAfterDays));
      setPrCapText(budgetToInput(saved.prDiffCapLines));
      setMaxRunsText(budgetToInput(saved.maxConcurrentRuns));
      if (saved.linearApiKey !== undefined) {
        setLinearKeyText(saved.linearApiKey ?? "");
      }
      hydrated.current = true;
      dirtyDrafts.current.delete("daily");
      dirtyDrafts.current.delete("orch");
      dirtyDrafts.current.delete("settle");
      dirtyDrafts.current.delete("pr");
      dirtyDrafts.current.delete("runs");
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save settings";
      setError(msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveLinearKey = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const linearApiKey = linearKeyText.trim() || null;
      const saved = await onSaveSettings({ linearApiKey });
      setLinearKeyText(saved.linearApiKey ?? "");
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save settings";
      setError(msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveSentryKey = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const sentryAuthToken = sentryKeyText.trim() || null;
      const saved = await onSaveSettings({ sentryAuthToken });
      setSentryKeyText(saved.sentryAuthToken ?? "");
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save settings";
      setError(msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const persistOtel = async (next: OtelSettings): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await onSaveSettings({ otel: next });
      const otel = saved.otel ?? next;
      setOtelEndpoint(otel.endpoint ?? "");
      setOtelHeadersText(formatOtelHeaders(otel.headers));
      setOtelClaudeMetrics(otel.claudeMetrics);
      return true;
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save settings";
      setError(msg);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const persistWebhook = async (next: WebhookSettings): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await onSaveSettings({ webhook: next });
      const webhook = saved.webhook ?? next;
      setWebhookUrl(webhook.url ?? "");
      setWebhookOnDone(webhook.onDone !== false);
      setWebhookOnFailed(webhook.onFailed !== false);
      setWebhookOnWaiting(webhook.onWaiting !== false);
      return true;
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save settings";
      setError(msg);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const persistPool = async (next: SubagentPool): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSaveSettings({ subagentPool: next });
      return true;
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save settings";
      setError(msg);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const persistProfiles = async (next: AgentProfile[]): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const patch: Partial<AppSettings> = { agentProfiles: next };
      const currentDefault = settings?.defaultOrchestratorProfileId ?? null;
      if (currentDefault && !next.some((p) => p.id === currentDefault)) {
        patch.defaultOrchestratorProfileId = null;
      }
      await onSaveSettings(patch);
      return true;
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to save settings";
      setError(msg);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const memory = status?.memory;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.settingsModal}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        data-settings=""
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button
            type="button"
            className={styles.close}
            onClick={handleClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.shell}>
          <nav className={styles.nav} aria-label="Settings sections">
            <input
              className={styles.navSearch}
              type="search"
              data-settings-search=""
              placeholder="Find a setting"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && navQuery !== "") {
                  // Clear first; Escape again (bubbling, query now empty)
                  // falls through to the modal's own close handler.
                  e.preventDefault();
                  e.stopPropagation();
                  setNavQuery("");
                  return;
                }
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (settingMatches[0]) {
                  goToSetting(settingMatches[0]);
                  return;
                }
                const first = visiblePanes[0];
                if (!first) return;
                setPane(first);
                setError(null);
              }}
              aria-label="Find a setting"
            />
            {settingMatches.length > 0 ? (
              <div className={styles.navMatches} data-settings-search-results="">
                {settingMatches.map((entry) => (
                  <button
                    key={`${entry.pane}:${entry.label}`}
                    type="button"
                    className={styles.navMatch}
                    data-setting-match={`${entry.pane}:${entry.label}`}
                    onClick={() => goToSetting(entry)}
                  >
                    <span className={styles.navMatchPane}>
                      {PANE_META[entry.pane].label}
                      {" › "}
                    </span>
                    <span className={styles.navMatchLabel}>
                      {entry.label}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className={styles.navList}>
              {visiblePanes.map((id) => (
                <button
                  key={id}
                  type="button"
                  data-settings-nav={id}
                  data-active={pane === id ? "true" : undefined}
                  className={styles.navItem}
                  aria-current={pane === id ? "page" : undefined}
                  onClick={() => {
                    setPane(id);
                    setError(null);
                  }}
                >
                  <PaneIcon id={id} />
                  <span className={styles.navLabel}>{PANE_META[id].label}</span>
                  {id === "general" && updateWaiting ? (
                    <span className={styles.navDot} data-update="" aria-hidden />
                  ) : null}
                  {id === "memory" ? (
                    <span
                      className={styles.navDot}
                      data-on={memory?.running ? "true" : undefined}
                      aria-hidden
                    />
                  ) : null}
                </button>
              ))}
            </div>
            {navFilter && visiblePanes.length === 0 ? (
              <p className={styles.navEmpty}>No matching settings</p>
            ) : null}
          </nav>

          <div className={styles.content}>
            <div className={styles.paneHead}>
              <h3 className={styles.paneTitle}>{paneMeta.label}</h3>
              <p className={styles.paneHint}>{paneMeta.hint}</p>
            </div>
            {error ? (
              <p className={styles.fieldError} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.paneBody} data-settings-pane={pane}>
          {pane === "spending" && (
          <SpendingPane
            settings={settings}
            status={status}
            saving={saving}
            error={error}
            setError={setError}
            budgetText={budgetText}
            setBudgetText={setBudgetText}
            orchBudgetText={orchBudgetText}
            setOrchBudgetText={setOrchBudgetText}
            maxRunsText={maxRunsText}
            setMaxRunsText={setMaxRunsText}
            dirtyDrafts={dirtyDrafts}
            save={save}
            onSaveSettings={onSaveSettings}
          />
          )}

          {pane === "git" && (
          <GitPane
            settings={settings}
            providers={providers}
            saving={saving}
            error={error}
            setError={setError}
            prCapText={prCapText}
            setPrCapText={setPrCapText}
            linearKeyText={linearKeyText}
            setLinearKeyText={setLinearKeyText}
            sentryKeyText={sentryKeyText}
            setSentryKeyText={setSentryKeyText}
            dirtyDrafts={dirtyDrafts}
            save={save}
            saveLinearKey={saveLinearKey}
            saveSentryKey={saveSentryKey}
            projects={projects}
            onGcScan={onGcScan}
            onGcClean={onGcClean}
            onDiscoverSourceControl={onDiscoverSourceControl}
            onSetSpotlight={onSetSpotlight}
            onSaveSettings={onSaveSettings}
            toolsProjectId={toolsProjectId}
            setToolsProjectId={setToolsProjectId}
          />
          )}

          {pane === "threads" && (
          <ThreadsPane
            settings={settings}
            providers={providers}
            saving={saving}
            error={error}
            setError={setError}
            settleDaysText={settleDaysText}
            setSettleDaysText={setSettleDaysText}
            dirtyDrafts={dirtyDrafts}
            save={save}
            onSaveSettings={onSaveSettings}
          />
          )}

          {pane === "advanced" && (
          <AdvancedPane
            settings={settings}
            providers={providers}
            saving={saving}
            error={error}
            setError={setError}
            otelEndpoint={otelEndpoint}
            setOtelEndpoint={setOtelEndpoint}
            otelHeadersText={otelHeadersText}
            setOtelHeadersText={setOtelHeadersText}
            otelClaudeMetrics={otelClaudeMetrics}
            setOtelClaudeMetrics={setOtelClaudeMetrics}
            dirtyDrafts={dirtyDrafts}
            persistOtel={persistOtel}
            onSaveSettings={onSaveSettings}
            projects={projects}
            currentProjectId={currentProjectId ?? null}
          />
          )}

          {pane === "agents" && (
          <AgentsPane
            settings={settings}
            providers={providers}
            saving={saving}
            setError={setError}
            draft={draft}
            setDraft={setDraft}
            poolDraft={poolDraft}
            setPoolDraft={setPoolDraft}
            persistProfiles={persistProfiles}
            persistPool={persistPool}
            onSaveSettings={onSaveSettings}
            onRefreshProviders={onRefreshProviders}
          />
          )}

          {pane === "providers" && (
          <ProvidersPane
            settings={settings}
            providers={providers}
            saving={saving}
            setError={setError}
            onSaveSettings={onSaveSettings}
            onRefreshProviders={onRefreshProviders}
            onProviderSignIn={onProviderSignIn}
          />
          )}

          {pane === "integrations" && (
          <>
          <IntegrationsSection
            active={open && pane === "integrations"}
            projects={projects}
          />
          {!isWebMode() && (
          <ChannelsSection
            active={open && pane === "integrations"}
            settings={settings}
            projects={projects}
            onSaveSettings={onSaveSettings}
          />
          )}
          </>
          )}

          {pane === "connections" && !isWebMode() && (
          <>
          <WebAccessSection active={open && pane === "connections"} />
          <p className={styles.sectionLabel}>Connect to another computer</p>
          <ConnectionsSection onOpen={onOpenConnection} onForget={onForgetConnection} onInstall={onInstallSolenta} onSidebarHosts={onSidebarHosts} sidebarHosts={sidebarHosts} />
          <p className={styles.note} data-connections-remote-project-hint="">
            Only need one repo from a server, in this window? Add it as a
            project with a Remote host instead (Add project, then Remote
            host). Its git and agents run there over SSH.
          </p>
          </>
          )}

          {pane === "memory" && (
          <MemoryPane
            status={status}
            projects={projects}
            projectTools={projectTools}
            toolsProjectId={toolsProjectId}
            setToolsProjectId={setToolsProjectId}
            onRenameScope={onRenameMemoryScope}
          />
          )}

          {pane === "skills" && skills && (
          <SkillsManager
            projectPath={
              projects?.find((p) => p.id === currentProjectId)?.path ?? null
            }
            {...skills}
          />
          )}

          {pane === "keyboard" && <KeyboardPane />}

          {pane === "general" && (
          <GeneralPane
            settings={settings}
            status={status}
            update={update}
            saving={saving}
            error={error}
            setError={setError}
            uiScale={uiScale}
            setUiScale={setUiScale}
            webhookUrl={webhookUrl}
            setWebhookUrl={setWebhookUrl}
            webhookOnDone={webhookOnDone}
            setWebhookOnDone={setWebhookOnDone}
            webhookOnFailed={webhookOnFailed}
            setWebhookOnFailed={setWebhookOnFailed}
            webhookOnWaiting={webhookOnWaiting}
            setWebhookOnWaiting={setWebhookOnWaiting}
            webhookTest={webhookTest}
            setWebhookTest={setWebhookTest}
            checkingUpdate={checkingUpdate}
            setCheckingUpdate={setCheckingUpdate}
            downloadingUpdate={downloadingUpdate}
            setDownloadingUpdate={setDownloadingUpdate}
            dirtyDrafts={dirtyDrafts}
            persistWebhook={persistWebhook}
            onSaveSettings={onSaveSettings}
            onTestWebhook={onTestWebhook}
            onShowOnboarding={onShowOnboarding}
            onCheckUpdate={onCheckUpdate}
            onDownloadUpdate={onDownloadUpdate}
            onApplyUpdate={onApplyUpdate}
            projects={projects}
          />
          )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
