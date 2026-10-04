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
import { syncTheme, type ThemePreference } from "../theme";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import {
  setComposerVimEnabled,
  setDivergenceCardEnabled,
  setPasteCardsEnabled,
  setRunDurationEnabled,
  useComposerVimEnabled,
  useDivergenceCardEnabled,
  usePasteCardsEnabled,
  useRunDurationEnabled,
} from "../uiPrefs";
import { type MemoryProjectToolsApi } from "./MemoryTab";
import { SkillsManager, type SkillsManagerProps } from "./SkillsTab";
import styles from "./SettingsModal.module.css";
import { IntegrationsSection } from "./IntegrationsSection";
import { ConnectionsSection } from "./ConnectionsSection";
import { isWebMode } from "../shared/wire";
import type { CoderApi } from "../shared/ipc";
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

export { formatOtelHeaders, parseOtelHeaders } from "./settings/AdvancedPane";

export const SETTINGS_PANES = [
  "general",
  "threads",
  "spending",
  "git",
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
      "notifications tour welcome update version build channel nightly prod felt estimate time saved webhook slack discord ntfy push phone agents panel sidebar collapse remember last quit confirm accidental close display divergence compare run duration paste cards vim motions",
  },
  threads: {
    label: "Threads",
    hint: "How new threads start, and when quiet ones leave the attention list.",
    keywords:
      "worktree isolate orchestrate delegate settle sidebar quota resume default provider model failover",
  },
  spending: {
    label: "Spending",
    hint: "Caps that stop a runaway day or a runaway crew.",
    keywords: "budget daily orchestration spend usd cap money cost unmetered kimi cursor",
  },
  git: {
    label: "Git",
    hint: "Source control, Linear tickets, PR size, worktree disk, and Spotlight.",
    keywords:
      "github gitlab bitbucket azure source control pr pull request worktree gc disk cleanup linear ticket api key spotlight lanes preview",
  },
  agents: {
    label: "Agents",
    hint: "Named profiles for the composer, and the worker pool.",
    keywords:
      "profile provider model effort permission pool worker alias candidate orchestrator default",
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
    hint: "Run Solenta on another machine through SSH.",
    keywords: "remote ssh host server tunnel workstation web token",
  },
  integrations: {
    label: "Integrations",
    hint: "Pair an external MCP client so it can launch and track Solenta tasks.",
    keywords:
      "mcp pairing claude desktop claude code token integrations external agent connect",
  },
  advanced: {
    label: "Advanced",
    hint: "Guardrails, telemetry export, and importing Vibe Kanban boards.",
    keywords: "guardrails safety security protection tools secrets injection otel opentelemetry otlp traces headers vibe kanban import",
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

const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const UI_SCALE_STEP = 0.1;

function formatUiScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
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
  | "uiScale"
  | "linear"
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
    uiScale: settings?.uiScale ?? 1,
    linear: settings?.linearApiKey ?? "",
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
  currentProjectId = null,
  onSetSpotlight,
  projectTools,
  skills,
}: SettingsModalProps) {
  const [pane, setPane] = useState<SettingsPane>("general");
  const [navQuery, setNavQuery] = useState("");
  const [budgetText, setBudgetText] = useState("");
  const [uiScale, setUiScale] = useState(1);
  const [orchBudgetText, setOrchBudgetText] = useState("");
  const [settleDaysText, setSettleDaysText] = useState("");
  const [prCapText, setPrCapText] = useState("");
  const [linearKeyText, setLinearKeyText] = useState("");
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
      if (!skip("uiScale")) setUiScale(snap.uiScale);
      if (!skip("linear")) setLinearKeyText(snap.linear);
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

  if (!open) return null;

  const navFilter = navQuery.trim().toLowerCase();
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
        | "prDiffCapLines",
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
      if (saved.linearApiKey !== undefined) {
        setLinearKeyText(saved.linearApiKey ?? "");
      }
      hydrated.current = true;
      dirtyDrafts.current.delete("daily");
      dirtyDrafts.current.delete("orch");
      dirtyDrafts.current.delete("settle");
      dirtyDrafts.current.delete("pr");
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

  const webhookFromDrafts = (
    over: Partial<WebhookSettings> = {},
  ): WebhookSettings => ({
    url: webhookUrl.trim() === "" ? null : webhookUrl.trim(),
    onDone: webhookOnDone,
    onFailed: webhookOnFailed,
    onWaiting: webhookOnWaiting,
    ...over,
  });

  const onBlurWebhookUrl = () => {
    const current = settings?.webhook?.url ?? null;
    const next = webhookUrl.trim() === "" ? null : webhookUrl.trim();
    if (next === current && error == null) return;
    void persistWebhook(webhookFromDrafts());
  };

  /**
   * The main process POSTs to the *saved* URL, so a freshly typed one is
   * persisted first. The button suppresses the input's blur (onMouseDown)
   * so that save happens here once, not in a race with this handler.
   */
  const sendWebhookTest = async () => {
    if (!onTestWebhook) return;
    const drafted = webhookFromDrafts();
    if (drafted.url !== (settings?.webhook?.url ?? null)) {
      if (!(await persistWebhook(drafted))) return;
    }
    setWebhookTest("sending");
    try {
      setWebhookTest(await onTestWebhook());
    } catch (err) {
      setWebhookTest({
        ok: false,
        error:
          err instanceof Error && err.message ? err.message : "Test failed",
      });
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
                if (e.key !== "Enter") return;
                const first = visiblePanes[0];
                if (!first) return;
                e.preventDefault();
                setPane(first);
                setError(null);
              }}
              aria-label="Find a setting"
            />
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
            dirtyDrafts={dirtyDrafts}
            save={save}
          />
          )}

          {pane === "git" && (
          <GitPane
            settings={settings}
            saving={saving}
            error={error}
            setError={setError}
            prCapText={prCapText}
            setPrCapText={setPrCapText}
            linearKeyText={linearKeyText}
            setLinearKeyText={setLinearKeyText}
            dirtyDrafts={dirtyDrafts}
            save={save}
            saveLinearKey={saveLinearKey}
            projects={projects}
            onGcScan={onGcScan}
            onGcClean={onGcClean}
            onDiscoverSourceControl={onDiscoverSourceControl}
            onSetSpotlight={onSetSpotlight}
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
          />
          )}

          {pane === "integrations" && (
          <IntegrationsSection
            active={open && pane === "integrations"}
            projects={projects}
          />
          )}

          {pane === "connections" && !isWebMode() && (
          <ConnectionsSection onOpen={onOpenConnection} onForget={onForgetConnection} />
          )}

          {pane === "memory" && (
          <MemoryPane
            status={status}
            projects={projects}
            projectTools={projectTools}
            toolsProjectId={toolsProjectId}
            setToolsProjectId={setToolsProjectId}
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

          {pane === "general" && (
          <section className={styles.section}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="theme">
                Theme
              </label>
              <select
                id="theme"
                className={styles.input}
                data-theme-setting=""
                value={settings?.theme ?? "dark"}
                disabled={saving || settings == null}
                onChange={(e) => {
                  const theme = e.target.value as ThemePreference;
                  setError(null);
                  syncTheme(theme);
                  void onSaveSettings({ theme }).catch((err) => {
                    setError(
                      err instanceof Error && err.message
                        ? err.message
                        : "Failed to save settings",
                    );
                  });
                }}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
              <p className={styles.note}>
                System follows the OS. Light and Dark stay put.
              </p>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="agents-panel-default">
                Agents panel
              </label>
              <select
                id="agents-panel-default"
                className={styles.input}
                data-agents-panel-default=""
                value={settings?.agentsPanelDefault ?? "closed"}
                disabled={saving || settings == null}
                onChange={(e) => {
                  const agentsPanelDefault = e.target.value as
                    | "closed"
                    | "open";
                  setError(null);
                  void onSaveSettings({ agentsPanelDefault }).catch((err) => {
                    setError(
                      err instanceof Error && err.message
                        ? err.message
                        : "Failed to save settings",
                    );
                  });
                }}
              >
                <option value="closed">Closed</option>
                <option value="open">Open</option>
              </select>
              <p className={styles.note}>
                How the right sidebar starts. You can still open or hide it
                from the rail or with ⌘ + .
              </p>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-agents-panel-remember-last=""
                  checked={settings?.agentsPanelRememberLast ?? false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      agentsPanelRememberLast: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Remember last agents-panel state</span>
              </label>
              <p className={styles.note}>
                Keep the last ⌘ + . or rail toggle across launches. Closed
                or Open above is the fallback when there is no last state.
              </p>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="ui-scale">
                UI scale
              </label>
              <div className={styles.fieldRow}>
                <input
                  id="ui-scale"
                  className={styles.range}
                  data-ui-scale=""
                  type="range"
                  min={UI_SCALE_MIN}
                  max={UI_SCALE_MAX}
                  step={UI_SCALE_STEP}
                  value={uiScale}
                  disabled={saving || settings == null}
                  aria-valuetext={formatUiScale(uiScale)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    dirtyDrafts.current.add("uiScale");
                    setUiScale(next);
                    setError(null);
                    void onSaveSettings({ uiScale: next }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span className={styles.rangeValue} data-ui-scale-value="">
                  {formatUiScale(uiScale)}
                </span>
              </div>
              <p className={styles.note}>
                Scales the whole window, including text, icons, and chrome.
                Same control as View &rarr; Zoom In / Zoom Out, or the zoom
                shortcuts.
              </p>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-notifications=""
                  checked={settings?.notifications ?? true}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      notifications: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Desktop notification when a thread finishes</span>
              </label>
              <p className={styles.note}>
                Only fires while the window is in the background. Mute a
                single noisy thread from its snooze menu in the sidebar.
              </p>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-confirm-quit-with-active-work=""
                  checked={settings?.confirmQuitWithActiveWork !== false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      confirmQuitWithActiveWork: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Ask before quitting while work is running</span>
              </label>
              <p className={styles.note}>
                Cmd/Ctrl+Q, the Quit menu, and closing the last window on
                Windows or Linux show what will stop. macOS window close
                still hides the app.
              </p>
            </div>
            <div className={styles.field} data-webhook-settings="">
              <label className={styles.fieldLabel} htmlFor="webhook-url">
                Webhook URL
              </label>
              <input
                id="webhook-url"
                className={styles.input}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://ntfy.sh/my-topic"
                value={webhookUrl}
                disabled={saving || settings == null}
                data-webhook-url=""
                onChange={(e) => {
                  dirtyDrafts.current.add("webhook");
                  setWebhookUrl(e.target.value);
                  setError(null);
                }}
                onBlur={() => onBlurWebhookUrl()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void persistWebhook(webhookFromDrafts());
                  }
                }}
              />
              <p className={styles.note}>
                POST a small JSON payload when a thread finishes or waits for
                permission. Slack, Discord, and ntfy incoming URLs all work.
                Fires even while this window is focused, unlike desktop
                notifications.
              </p>
              {onTestWebhook && (
                <div className={styles.fieldRow}>
                  <button
                    type="button"
                    className={styles.btn}
                    data-webhook-test=""
                    disabled={
                      saving ||
                      settings == null ||
                      webhookTest === "sending" ||
                      webhookUrl.trim() === ""
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void sendWebhookTest()}
                  >
                    {webhookTest === "sending" ? "Sending…" : "Send test"}
                  </button>
                  {typeof webhookTest === "object" && (
                    <span
                      className={
                        webhookTest.ok ? styles.note : styles.fieldError
                      }
                      role="status"
                      data-webhook-test-result={webhookTest.ok ? "ok" : "fail"}
                    >
                      {webhookTest.ok
                        ? webhookTest.status != null
                          ? `Sent (HTTP ${webhookTest.status})`
                          : "Sent"
                        : webhookTest.error || "Test failed"}
                    </span>
                  )}
                </div>
              )}
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-webhook-on-done=""
                  checked={webhookOnDone}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    const onDone = e.target.checked;
                    setWebhookOnDone(onDone);
                    setError(null);
                    void persistWebhook(webhookFromDrafts({ onDone }));
                  }}
                />
                <span>Done</span>
              </label>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-webhook-on-failed=""
                  checked={webhookOnFailed}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    const onFailed = e.target.checked;
                    setWebhookOnFailed(onFailed);
                    setError(null);
                    void persistWebhook(webhookFromDrafts({ onFailed }));
                  }}
                />
                <span>Failed</span>
              </label>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-webhook-on-waiting=""
                  checked={webhookOnWaiting}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    const onWaiting = e.target.checked;
                    setWebhookOnWaiting(onWaiting);
                    setError(null);
                    void persistWebhook(webhookFromDrafts({ onWaiting }));
                  }}
                />
                <span>Waiting for permission</span>
              </label>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-felt-estimate-prompt=""
                  checked={settings?.feltEstimatePrompt ?? false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      feltEstimatePrompt: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Ask how much time a finished thread saved you</span>
              </label>
              <p className={styles.note}>
                One tap on the finished thread. Feeds the felt-vs-actual
                section of the Fleet view. Off by default.
              </p>
            </div>
            {onShowOnboarding && (
              <div className={styles.fieldRow}>
                <p className={styles.note}>Replay the first-run tour.</p>
                <button
                  type="button"
                  className={styles.btn}
                  data-show-onboarding=""
                  onClick={() => onShowOnboarding()}
                >
                  Show welcome tour
                </button>
              </div>
            )}
            {/* A stale packaged bundle behaves like a broken app; name the build. */}
            <p className={styles.note}>
              {status?.build
                ? `${status.build.version}${
                    status.build.sha ? ` · ${status.build.sha}` : " · dev tree"
                  }${status.build.time ? ` · ${status.build.time}` : ""}${
                    status.build.channel ? ` · ${status.build.channel}` : ""
                  }`
                : "unknown"}
            </p>
            <div className={styles.fieldRow}>
              {status?.build.platform === "darwin" && status.build.channel ? (
                <span className={styles.note}>
                  Update channel: {status.build.channel === "nightly" ? "Nightly" : "Prod"}
                </span>
              ) : (
                <>
                  <label className={styles.note} htmlFor="update-channel">
                    Update channel
                  </label>
                  <select
                    id="update-channel"
                    className={styles.input}
                    data-update-channel=""
                    value={settings?.updateChannel ?? status?.build.channel ?? "prod"}
                    disabled={saving || settings == null}
                    onChange={(e) => {
                      setError(null);
                      const updateChannel = e.target.value as "prod" | "nightly";
                      void onSaveSettings({ updateChannel })
                        .then(() => onCheckUpdate?.())
                        .catch((err) => {
                          setError(
                            err instanceof Error && err.message
                              ? err.message
                              : "Failed to save settings",
                          );
                        });
                    }}
                  >
                    <option value="prod">Prod</option>
                    <option value="nightly">Nightly</option>
                  </select>
                </>
              )}
              <button
                type="button"
                className={styles.btn}
                data-check-update=""
                disabled={checkingUpdate || onCheckUpdate == null}
                onClick={() => {
                  setCheckingUpdate(true);
                  void onCheckUpdate?.().finally(() => setCheckingUpdate(false));
                }}
              >
                {checkingUpdate ? "Checking…" : "Check for updates"}
              </button>
            </div>
            {status?.build.platform === "darwin" && status.build.channel && (
              <p className={styles.note}>
                Prod and Nightly are separate macOS apps. Download the other channel from{" "}
                <a href="https://github.com/currentbits/solenta/releases" target="_blank" rel="noreferrer">
                  Releases
                </a>{" "}
                and move it to Applications.
              </p>
            )}
            {update?.state === "none" && (
              <p className={styles.note}>Up to date.</p>
            )}
            {update?.state === "disabled" && (
              <p className={styles.note}>
                Auto-update is off in dev/unstamped builds.
              </p>
            )}
            {update?.state === "staged" && (
              <div className={styles.fieldRow}>
                <span className={styles.note}>
                  Update {update.tag} downloaded.
                </span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={() => void onApplyUpdate?.()}
                >
                  Restart to update
                </button>
              </div>
            )}
            {update?.state === "available" && (
              <div className={styles.fieldRow}>
                <span className={styles.note}>
                  Update {update.tag} available
                  {update.url ? (
                    <>
                      {" — "}
                      <a href={update.url} target="_blank" rel="noreferrer">
                        release page
                      </a>
                    </>
                  ) : null}
                  {update.error ? ` (install failed: ${update.error})` : ""}
                </span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  data-download-update=""
                  disabled={downloadingUpdate || onDownloadUpdate == null}
                  onClick={() => {
                    setDownloadingUpdate(true);
                    void onDownloadUpdate?.().finally(() => setDownloadingUpdate(false));
                  }}
                >
                  {downloadingUpdate ? "Downloading…" : "Download and install"}
                </button>
              </div>
            )}
            {update?.state === "error" && (
              <p className={styles.fieldError} role="alert">
                Update failed: {update.error}
              </p>
            )}
          </section>
          )}

          {pane === "general" && <DisplayPrefsSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Display prefs (moved from the Environment tab). Same uiPrefs keys. */
function DisplayPrefsSection() {
  const divergence = useDivergenceCardEnabled();
  const runDuration = useRunDurationEnabled();
  const pasteCards = usePasteCardsEnabled();
  const composerVim = useComposerVimEnabled();
  return (
    <section className={styles.section} data-display-prefs="">
      <h3 className={styles.sectionLabel}>Display</h3>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-divergence-pref=""
          checked={divergence}
          onChange={(e) => setDivergenceCardEnabled(e.target.checked)}
        />
        <span>Show divergence compare on threads</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-run-duration-pref=""
          checked={runDuration}
          onChange={(e) => setRunDurationEnabled(e.target.checked)}
        />
        <span>Show time spent at the end of a run</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-paste-cards-pref=""
          checked={pasteCards}
          onChange={(e) => setPasteCardsEnabled(e.target.checked)}
        />
        <span>Collapse large pastes into cards</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-composer-vim-pref=""
          checked={composerVim}
          onChange={(e) => setComposerVimEnabled(e.target.checked)}
        />
        <span>Vim motions in the composer</span>
      </label>
    </section>
  );
}

