import { useCallback, useEffect, useRef, useState } from "react";
import {
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
} from "../format";
import { formatUsd } from "../digest";
import {
  CUSTOM_MODEL_ID,
  effortDisplayLabel,
  profileSummary,
} from "../modelPicker";
import type {
  AgentProfile,
  AppSettings,
  AppStatus,
  GcCleanInput,
  GcCleanResult,
  GcScanResult,
  OtelSettings,
  WebhookSettings,
  WebhookTestResult,
  PermissionMode,
  ProjectInfo,
  ProviderInfo,
  ReasoningEffort,
  SourceControlDiscovery,
  SubagentPool,
  SubagentPoolEntry,
  UpdateStatus,
} from "../shared/ipc";
import { syncTheme, type ThemePreference } from "../theme";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./SettingsModal.module.css";
import { WorktreeGcSection } from "./WorktreeGcSection";
import { VibeKanbanSection } from "./VibeKanbanSection";
import { SourceControlSection } from "./SourceControlSection";

export const SETTINGS_PANES = [
  "general",
  "threads",
  "spending",
  "git",
  "agents",
  "memory",
  "advanced",
] as const;

export type SettingsPane = (typeof SETTINGS_PANES)[number];

const PANE_META: Record<
  SettingsPane,
  { label: string; hint: string; keywords: string }
> = {
  general: {
    label: "General",
    hint: "Notifications, the welcome tour, and this build.",
    keywords:
      "notifications tour welcome update version build channel nightly prod felt estimate time saved webhook slack discord ntfy push phone",
  },
  threads: {
    label: "Threads",
    hint: "How new threads start, and when quiet ones leave the attention list.",
    keywords:
      "worktree isolate orchestrate delegate settle sidebar quota resume",
  },
  spending: {
    label: "Spending",
    hint: "Caps that stop a runaway day or a runaway crew.",
    keywords: "budget daily orchestration spend usd cap money cost",
  },
  git: {
    label: "Git",
    hint: "Source control, Linear tickets, PR size, and worktree disk.",
    keywords:
      "github gitlab bitbucket azure source control pr pull request worktree gc disk cleanup linear ticket api key",
  },
  agents: {
    label: "Agents",
    hint: "Named profiles for the composer, and the worker pool.",
    keywords:
      "profile provider model effort permission pool worker alias candidate",
  },
  memory: {
    label: "Memory",
    hint: "The local memory server injected into every session.",
    keywords: "memory entries vectors janitor server port embed",
  },
  advanced: {
    label: "Advanced",
    hint: "Telemetry export and importing Vibe Kanban boards.",
    keywords: "otel opentelemetry otlp traces headers vibe kanban import",
  },
};

function isSettingsPane(value: string | null | undefined): value is SettingsPane {
  return (
    value != null && (SETTINGS_PANES as readonly string[]).includes(value)
  );
}

interface SettingsModalProps {
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

/** ponytail: one `key: value` per line; a row editor if this grows past a handful of headers. */
export function formatOtelHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([k]) => k)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function parseOtelHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

interface ProfileDraft {
  id: string | null;
  name: string;
  provider: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  permissionMode: PermissionMode;
  customModel: boolean;
}

function defaultProviderId(providers: readonly ProviderInfo[]): string {
  return providers.find((p) => p.available)?.id ?? providers[0]?.id ?? "";
}

const EMPTY_POOL: SubagentPool = {
  defaultAlias: null,
  force: false,
  entries: [],
};

interface PoolDraft {
  originalAlias: string | null;
  alias: string;
  provider: string;
  model: string | null;
  description: string;
  customModel: boolean;
}

function emptyPoolDraft(providers: readonly ProviderInfo[]): PoolDraft {
  return {
    originalAlias: null,
    alias: "",
    provider: defaultProviderId(providers),
    model: null,
    description: "",
    customModel: false,
  };
}

function draftFromPoolEntry(
  entry: SubagentPoolEntry,
  providers: readonly ProviderInfo[],
): PoolDraft {
  const provider = providers.find((p) => p.id === entry.provider);
  const known =
    entry.model != null &&
    (provider?.modelInfo.some((m) => m.id === entry.model) ?? false);
  return {
    originalAlias: entry.alias,
    alias: entry.alias,
    provider: entry.provider,
    model: entry.model,
    description: entry.description,
    customModel: entry.model != null && !known,
  };
}

function emptyDraft(providers: readonly ProviderInfo[]): ProfileDraft {
  return {
    id: null,
    name: "",
    provider: defaultProviderId(providers),
    model: null,
    reasoningEffort: null,
    permissionMode: "default",
    customModel: false,
  };
}

function draftFromProfile(
  profile: AgentProfile,
  providers: readonly ProviderInfo[],
): ProfileDraft {
  const provider = providers.find((p) => p.id === profile.provider);
  const known =
    profile.model != null &&
    (provider?.modelInfo.some((m) => m.id === profile.model) ?? false);
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    permissionMode: profile.permissionMode,
    customModel: profile.model != null && !known,
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
  const wasOpen = useRef(false);
  /** Sync guard: blur then Save-click can both fire before setSaving lands. */
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setPane(isSettingsPane(initialPane) ? initialPane : "general");
    setNavQuery("");
    setBudgetText(budgetToInput(settings?.dailyBudgetUsd ?? null));
    setUiScale(settings?.uiScale ?? 1);
    setOrchBudgetText(
      budgetToInput(settings?.orchestrationBudgetUsd ?? null),
    );
    setSettleDaysText(settleDaysToInput(settings?.autoSettleAfterDays ?? null));
    setPrCapText(budgetToInput(settings?.prDiffCapLines ?? null));
    setLinearKeyText(settings?.linearApiKey ?? "");
    const otel = settings?.otel ?? EMPTY_OTEL;
    setOtelEndpoint(otel.endpoint ?? "");
    setOtelHeadersText(formatOtelHeaders(otel.headers));
    setOtelClaudeMetrics(otel.claudeMetrics);
    const webhook = settings?.webhook ?? EMPTY_WEBHOOK;
    setWebhookUrl(webhook.url ?? "");
    setWebhookOnDone(webhook.onDone !== false);
    setWebhookOnFailed(webhook.onFailed !== false);
    setWebhookOnWaiting(webhook.onWaiting !== false);
    setWebhookTest("idle");
    setDraft(null);
    setPoolDraft(null);
    setError(null);
    setSaving(false);
    savingRef.current = false;
  }, [open, settings?.dailyBudgetUsd, settings?.orchestrationBudgetUsd, settings?.autoSettleAfterDays, settings?.prDiffCapLines, settings?.otel, settings?.webhook, settings?.uiScale, settings?.linearApiKey]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEscapeClose(open, handleClose);

  useEffect(() => {
    if (!open || !isSettingsPane(initialPane)) return;
    setPane(initialPane);
  }, [open, initialPane]);

  if (!open) return null;

  const navFilter = navQuery.trim().toLowerCase();
  const visiblePanes = SETTINGS_PANES.filter((id) => {
    if (!navFilter) return true;
    const meta = PANE_META[id];
    return (
      meta.label.toLowerCase().includes(navFilter) ||
      meta.hint.toLowerCase().includes(navFilter) ||
      meta.keywords.includes(navFilter)
    );
  });
  const paneMeta = PANE_META[pane];
  const spent = status?.spendTodayUsd;
  const spendCopy =
    spent == null
      ? null
      : settings?.dailyBudgetUsd != null
        ? `Spent ${formatUsd(spent)} of ${formatUsd(settings.dailyBudgetUsd)} today`
        : spent === 0
          ? "No spend today"
          : `Spent ${formatUsd(spent)} today`;
  const spendRatio =
    spent != null &&
    settings?.dailyBudgetUsd != null &&
    settings.dailyBudgetUsd > 0
      ? Math.min(1, Math.max(0, spent / settings.dailyBudgetUsd))
      : null;
  const updateWaiting =
    update?.state === "available" || update?.state === "staged";

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const budgetRaw = budgetText.trim();
      // Empty = no cap. Otherwise pass the parsed number through and let the
      // backend reject with its validation string.
      const dailyBudgetUsd: number | null =
        budgetRaw === "" ? null : Number(budgetRaw);

      const orchBudgetRaw = orchBudgetText.trim();
      // Same contract as the daily cap: empty = no per-orchestration ceiling.
      const orchestrationBudgetUsd: number | null =
        orchBudgetRaw === "" ? null : Number(orchBudgetRaw);

      const settleRaw = settleDaysText.trim();
      // Empty = Never (null disables inactivity settle). Otherwise parse.
      const autoSettleAfterDays: number | null =
        settleRaw === "" ? null : Number(settleRaw);

      const prCapRaw = prCapText.trim();
      // Empty = no size cap. Otherwise parse; the backend validates.
      const prDiffCapLines: number | null =
        prCapRaw === "" ? null : Number(prCapRaw);

      const saved = await onSaveSettings({
        dailyBudgetUsd,
        orchestrationBudgetUsd,
        autoSettleAfterDays,
        prDiffCapLines,
      });
      setBudgetText(budgetToInput(saved.dailyBudgetUsd));
      setOrchBudgetText(budgetToInput(saved.orchestrationBudgetUsd));
      setSettleDaysText(settleDaysToInput(saved.autoSettleAfterDays));
      setPrCapText(budgetToInput(saved.prDiffCapLines));
      if (saved.linearApiKey !== undefined) {
        setLinearKeyText(saved.linearApiKey ?? "");
      }
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

  const onBlurBudget = () => {
    // Skip if unchanged from last known settings value.
    const current = settings?.dailyBudgetUsd ?? null;
    const next = budgetText.trim() === "" ? null : Number(budgetText.trim());
    const same =
      (current == null && (budgetText.trim() === "" || next === null)) ||
      (current != null &&
        Number.isFinite(next) &&
        next === current &&
        budgetText.trim() !== "");
    if (same && error == null) return;
    void save();
  };

  const onBlurOrchBudget = () => {
    // Skip if unchanged from last known settings value.
    const current = settings?.orchestrationBudgetUsd ?? null;
    const next =
      orchBudgetText.trim() === "" ? null : Number(orchBudgetText.trim());
    const same =
      (current == null && (orchBudgetText.trim() === "" || next === null)) ||
      (current != null &&
        Number.isFinite(next) &&
        next === current &&
        orchBudgetText.trim() !== "");
    if (same && error == null) return;
    void save();
  };

  const onBlurSettleDays = () => {
    const current = settings?.autoSettleAfterDays ?? null;
    const next =
      settleDaysText.trim() === "" ? null : Number(settleDaysText.trim());
    const same =
      (current == null && (settleDaysText.trim() === "" || next === null)) ||
      (current != null &&
        Number.isFinite(next) &&
        next === current &&
        settleDaysText.trim() !== "");
    if (same && error == null) return;
    void save();
  };

  const onBlurPrCap = () => {
    const current = settings?.prDiffCapLines ?? null;
    const next = prCapText.trim() === "" ? null : Number(prCapText.trim());
    const same =
      (current == null && (prCapText.trim() === "" || next === null)) ||
      (current != null &&
        Number.isFinite(next) &&
        next === current &&
        prCapText.trim() !== "");
    if (same && error == null) return;
    void save();
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

  const otelFromDrafts = (): OtelSettings => ({
    endpoint: otelEndpoint.trim() === "" ? null : otelEndpoint.trim(),
    headers: parseOtelHeaders(otelHeadersText),
    claudeMetrics: otelClaudeMetrics,
  });

  const onBlurOtelEndpoint = () => {
    const current = settings?.otel?.endpoint ?? null;
    const next = otelEndpoint.trim() === "" ? null : otelEndpoint.trim();
    if (next === current && error == null) return;
    void persistOtel(otelFromDrafts());
  };

  const onBlurOtelHeaders = () => {
    const current = formatOtelHeaders(settings?.otel?.headers ?? {});
    const next = formatOtelHeaders(parseOtelHeaders(otelHeadersText));
    if (next === current && error == null) return;
    void persistOtel(otelFromDrafts());
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
      await onSaveSettings({ agentProfiles: next });
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

  const submitDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Name is required");
      return;
    }
    if (name.length > 40) {
      setError("Name must be 40 characters or fewer");
      return;
    }
    const selected = providers.find((p) => p.id === draft.provider);
    const model = draft.customModel
      ? draft.model?.trim() || null
      : draft.model;
    const reasoningEffort =
      selected && selected.efforts.length > 0 ? draft.reasoningEffort : null;
    const nextProfile: AgentProfile = {
      id: draft.id ?? crypto.randomUUID(),
      name,
      provider: draft.provider,
      model,
      reasoningEffort,
      permissionMode: draft.permissionMode,
    };
    const list = settings?.agentProfiles ?? [];
    const next = draft.id
      ? list.map((p) => (p.id === draft.id ? nextProfile : p))
      : [...list, nextProfile];
    if (await persistProfiles(next)) setDraft(null);
  };

  const submitPoolDraft = async () => {
    if (!poolDraft) return;
    const alias = poolDraft.alias.trim().toLowerCase();
    if (!alias) {
      setError("Alias is required");
      return;
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias)) {
      setError('Alias must be a lowercase slug (e.g. "fast"), 1-32 characters');
      return;
    }
    const description = poolDraft.description.replace(/\s+/g, " ").trim();
    if (!description) {
      setError("Description is required");
      return;
    }
    if (description.length > 160) {
      setError("Description must be 160 characters or fewer");
      return;
    }
    const model = poolDraft.customModel
      ? poolDraft.model?.trim() || null
      : poolDraft.model;
    const nextEntry: SubagentPoolEntry = {
      alias,
      provider: poolDraft.provider,
      model,
      description,
    };
    const current = settings?.subagentPool ?? EMPTY_POOL;
    const withoutOld = poolDraft.originalAlias
      ? current.entries.filter((e) => e.alias !== poolDraft.originalAlias)
      : current.entries;
    if (withoutOld.some((e) => e.alias === alias)) {
      setError(`Alias "${alias}" is already in the pool`);
      return;
    }
    const entries = poolDraft.originalAlias
      ? current.entries.map((e) =>
          e.alias === poolDraft.originalAlias ? nextEntry : e,
        )
      : [...current.entries, nextEntry];
    let defaultAlias = current.defaultAlias;
    if (poolDraft.originalAlias && defaultAlias === poolDraft.originalAlias) {
      defaultAlias = alias;
    }
    if (defaultAlias == null && entries.length === 1) defaultAlias = alias;
    if (await persistPool({ ...current, defaultAlias, entries })) {
      setPoolDraft(null);
    }
  };

  const memory = status?.memory;
  const memoryLabel =
    memory?.running && memory.port != null
      ? `Memory server: running on port ${memory.port}${
          memory.adopted ? " (adopted)" : ""
        }`
      : "Memory server: not running";

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className={styles.settingsModal}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
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
          <section className={styles.section}>
            {spendCopy ? (
              <div className={styles.spendBlock} data-spend-today="">
                <p className={styles.spendLine}>{spendCopy}</p>
                {spendRatio != null ? (
                  <div
                    className={styles.spendTrack}
                    aria-hidden
                  >
                    <span
                      className={styles.spendFill}
                      data-hot={spendRatio >= 1 ? "true" : undefined}
                      style={{ width: `${Math.round(spendRatio * 100)}%` }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="daily-budget">
                Daily budget (USD)
              </label>
              <div className={styles.fieldRow}>
                <input
                  id="daily-budget"
                  className={styles.input}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  placeholder="No cap"
                  value={budgetText}
                  disabled={saving}
                  onChange={(e) => {
                    setBudgetText(e.target.value);
                    setError(null);
                  }}
                  onBlur={() => onBlurBudget()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="orch-budget">
                Per-orchestration budget (USD)
              </label>
              <div className={styles.fieldRow}>
                <input
                  id="orch-budget"
                  className={styles.input}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  placeholder="No cap"
                  value={orchBudgetText}
                  disabled={saving}
                  data-orch-budget=""
                  onChange={(e) => {
                    setOrchBudgetText(e.target.value);
                    setError(null);
                  }}
                  onBlur={() => onBlurOrchBudget()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              <p className={styles.note}>
                Caps the combined spend of one orchestrator thread and its
                fan-out workers. When a crew reaches it, the next worker
                wake-up is refused and the thread lands failed with the
                reason — raise or clear the cap, then Retry turn.
              </p>
            </div>
          </section>
          )}

          {pane === "git" && (
          <SourceControlSection
            active={open && pane === "git"}
            onDiscover={onDiscoverSourceControl}
          />
          )}

          {pane === "git" && (
          <section className={styles.section}>
            <h3 className={styles.sectionLabel}>Pull requests</h3>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="pr-diff-cap">
                PR size cap (lines changed)
              </label>
              <div className={styles.fieldRow}>
                <input
                  id="pr-diff-cap"
                  className={styles.input}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  placeholder="No cap"
                  value={prCapText}
                  disabled={saving}
                  data-pr-diff-cap=""
                  onChange={(e) => {
                    setPrCapText(e.target.value);
                    setError(null);
                  }}
                  onBlur={() => onBlurPrCap()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
                <span className={styles.note}>lines</span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              <p className={styles.note}>
                PRs created from the app larger than this are refused with an
                offer to split them into stacked PRs — small batches keep
                human review affordable. Default 400; empty means no cap.
              </p>
            </div>
          </section>
          )}

          {pane === "git" && (
          <section className={styles.section}>
            <h3 className={styles.sectionLabel}>Linear</h3>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="linear-api-key">
                API key
              </label>
              <div className={styles.fieldRow}>
                <input
                  id="linear-api-key"
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="lin_api_…"
                  value={linearKeyText}
                  disabled={saving}
                  data-linear-api-key=""
                  onChange={(e) => {
                    setLinearKeyText(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveLinearKey();
                    }
                  }}
                />
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={saving}
                  data-linear-api-key-save=""
                  onClick={() => void saveLinearKey()}
                >
                  {saving ? "Saving…" : "Save key"}
                </button>
              </div>
              <p className={styles.note}>
                Used to start threads from Linear issues. LINEAR_API_KEY in
                the environment also works. Empty and Save key clears a
                stored key.
              </p>
            </div>
          </section>
          )}

          {pane === "threads" && (
          <section className={styles.section}>
            <h3 className={styles.sectionLabel}>Sidebar</h3>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="auto-settle-days">
                Auto-settle quiet threads after
              </label>
              <div className={styles.fieldRow}>
                <input
                  id="auto-settle-days"
                  className={styles.input}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  placeholder="Never"
                  value={settleDaysText}
                  disabled={saving}
                  data-auto-settle-days=""
                  onChange={(e) => {
                    setSettleDaysText(e.target.value);
                    setError(null);
                  }}
                  onBlur={() => onBlurSettleDays()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    }
                  }}
                />
                <span className={styles.note}>days</span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              <p className={styles.note}>
                Empty means Never — quiet threads only settle via PR state or
                an explicit settle.
              </p>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-auto-settle-on-merge=""
                  checked={settings?.autoSettleOnMerge !== false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      autoSettleOnMerge: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Settle a thread when its pull request merges</span>
              </label>
              <p className={styles.note}>
                Closed pull requests still settle automatically. Turn this
                off to keep a merged thread in the attention list until you
                settle it yourself.
              </p>
            </div>
          </section>
          )}

          {pane === "threads" && (
          <section className={styles.section}>
            <h3 className={styles.sectionLabel}>Threads</h3>
            <div className={styles.field}>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-default-worktree=""
                  checked={settings?.defaultWorktree ?? false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      defaultWorktree: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Isolate new threads in a git worktree</span>
              </label>
              <p className={styles.note}>
                New threads get their own branch and working directory, so
                parallel agents never touch your checkout. Local projects
                only.
              </p>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-default-orchestrate=""
                  checked={settings?.defaultOrchestrate ?? false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      defaultOrchestrate: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Delegate new threads to a worker</span>
              </label>
              <p className={styles.note}>
                The thread&apos;s first prompt is handed to a worker thread in
                its own worktree; the thread itself supervises. Wins over the
                worktree option above.
              </p>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-quota-wait-auto-resume=""
                  checked={settings?.quotaWaitAutoResume !== false}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    setError(null);
                    void onSaveSettings({
                      quotaWaitAutoResume: e.target.checked,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>Continue automatically when usage limit resets</span>
              </label>
              <p className={styles.note}>
                Parks a thread until the provider&apos;s reset time, then
                sends the same prompt once. Off = fail the turn. Distinct
                from the daily budget cap above.
              </p>
            </div>
          </section>
          )}

          {pane === "advanced" && (
          <section className={styles.section} data-otel-settings="">
            <h3 className={styles.sectionLabel}>OpenTelemetry</h3>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="otel-endpoint">
                OTLP endpoint
              </label>
              <input
                id="otel-endpoint"
                className={styles.input}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="http://127.0.0.1:4318"
                value={otelEndpoint}
                disabled={saving || settings == null}
                data-otel-endpoint=""
                onChange={(e) => {
                  setOtelEndpoint(e.target.value);
                  setError(null);
                }}
                onBlur={() => onBlurOtelEndpoint()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void persistOtel(otelFromDrafts());
                  }
                }}
              />
              <p className={styles.note}>
                Empty turns export off entirely. Spans POST to
                {" "}
                <span className={styles.monoNote}>&lt;endpoint&gt;/v1/traces</span>
                .
              </p>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="otel-headers">
                Export headers
              </label>
              <textarea
                id="otel-headers"
                className={styles.textarea}
                rows={3}
                spellCheck={false}
                placeholder="Authorization: Bearer ..."
                value={otelHeadersText}
                disabled={saving || settings == null}
                data-otel-headers=""
                onChange={(e) => {
                  setOtelHeadersText(e.target.value);
                  setError(null);
                }}
                onBlur={() => onBlurOtelHeaders()}
              />
              <p className={styles.note}>
                One <span className={styles.monoNote}>key: value</span> per
                line. Used as extra headers on every OTLP POST (collector
                auth).
              </p>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-otel-claude-metrics=""
                  checked={otelClaudeMetrics}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    const claudeMetrics = e.target.checked;
                    setOtelClaudeMetrics(claudeMetrics);
                    setError(null);
                    void persistOtel({
                      ...otelFromDrafts(),
                      claudeMetrics,
                    });
                  }}
                />
                <span>Also export Claude Code&apos;s native metrics</span>
              </label>
              <p className={styles.note}>
                Does nothing unless an endpoint is set. Points Claude Code
                at the same collector so its native metrics land beside our
                spans.
              </p>
            </div>
          </section>
          )}

          {pane === "agents" && (
          <section className={styles.section} data-agent-profiles="">
            <h3 className={styles.sectionLabel}>Agent profiles</h3>
            <p className={styles.note}>
              Named combinations of provider, model, effort, and permission
              mode. Pick one from the composer.
            </p>
            {(settings?.agentProfiles ?? []).length === 0 && draft == null && (
              <p className={styles.note}>No profiles yet.</p>
            )}
            {(settings?.agentProfiles ?? []).map((profile, index, list) => (
              <div
                key={profile.id}
                className={`${styles.memoryRow} ${styles.profileRow}`}
              >
                <div className={styles.profileMeta}>
                  <div className={styles.profileName}>{profile.name}</div>
                  <p className={styles.note}>
                    {profileSummary(profile, providers)}
                  </p>
                </div>
                <div className={styles.fieldRow}>
                  <button
                    type="button"
                    className={styles.btn}
                    aria-label={`Move ${profile.name} up`}
                    disabled={saving || index === 0}
                    onClick={() => {
                      const next = [...list];
                      const above = next[index - 1]!;
                      next[index - 1] = profile;
                      next[index] = above;
                      void persistProfiles(next);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    aria-label={`Move ${profile.name} down`}
                    disabled={saving || index === list.length - 1}
                    onClick={() => {
                      const next = [...list];
                      const below = next[index + 1]!;
                      next[index + 1] = profile;
                      next[index] = below;
                      void persistProfiles(next);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={saving}
                    onClick={() => {
                      setError(null);
                      setDraft(draftFromProfile(profile, providers));
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={saving}
                    onClick={() => {
                      if (draft?.id === profile.id) setDraft(null);
                      void persistProfiles(
                        list.filter((p) => p.id !== profile.id),
                      );
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {draft ? (
              <ProfileForm
                draft={draft}
                providers={providers}
                saving={saving}
                onChange={setDraft}
                onCancel={() => {
                  setDraft(null);
                  setError(null);
                }}
                onSubmit={() => void submitDraft()}
              />
            ) : (
              <div className={styles.fieldRow}>
                <button
                  type="button"
                  className={styles.btn}
                  data-add-profile=""
                  disabled={saving || settings == null || providers.length === 0}
                  onClick={() => {
                    setError(null);
                    setDraft(emptyDraft(providers));
                  }}
                >
                  Add profile
                </button>
              </div>
            )}
          </section>
          )}

          {pane === "agents" && (
          <section className={styles.section} data-subagent-pool="">
            <h3 className={styles.sectionLabel}>Worker model pool</h3>
            <p className={styles.note}>
              Described candidates the lead picks per spawn. Workers default
              to the cheap alias. Does not route the thread you are talking
              to.
            </p>
            {(settings?.subagentPool?.entries ?? []).length === 0 &&
              poolDraft == null && (
                <p className={styles.note}>
                  No pool. Workers inherit the lead&apos;s provider.
                </p>
              )}
            {(settings?.subagentPool?.entries ?? []).map((item) => {
              const current = settings?.subagentPool ?? EMPTY_POOL;
              const isDefault = current.defaultAlias === item.alias;
              return (
                <div
                  key={item.alias}
                  className={`${styles.memoryRow} ${styles.profileRow}`}
                  data-pool-entry={item.alias}
                >
                  <div className={styles.profileMeta}>
                    <div className={styles.profileName}>
                      {item.alias}
                      {isDefault ? " (default)" : ""}
                    </div>
                    <p className={styles.note}>
                      {item.description} ({item.provider} / {item.model ?? "default"})
                    </p>
                  </div>
                  <div className={styles.fieldRow}>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={saving}
                      onClick={() => {
                        setError(null);
                        setPoolDraft(draftFromPoolEntry(item, providers));
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={saving}
                      onClick={() => {
                        if (poolDraft?.originalAlias === item.alias) {
                          setPoolDraft(null);
                        }
                        const nextEntries = current.entries.filter(
                          (e) => e.alias !== item.alias,
                        );
                        const defaultAlias =
                          current.defaultAlias === item.alias
                            ? (nextEntries[0]?.alias ?? null)
                            : current.defaultAlias;
                        void persistPool({
                          defaultAlias,
                          force: defaultAlias != null && current.force,
                          entries: nextEntries,
                        });
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
            {(settings?.subagentPool?.entries ?? []).length > 0 && (
              <>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="pool-default">
                    Default worker
                  </label>
                  <select
                    id="pool-default"
                    className={styles.input}
                    data-pool-default=""
                    value={settings?.subagentPool?.defaultAlias ?? ""}
                    disabled={saving || settings == null}
                    onChange={(e) => {
                      const current = settings?.subagentPool ?? EMPTY_POOL;
                      const defaultAlias = e.target.value || null;
                      void persistPool({
                        ...current,
                        defaultAlias,
                        force: defaultAlias != null && current.force,
                      });
                    }}
                  >
                    <option value="">Inherit lead&apos;s provider</option>
                    {(settings?.subagentPool?.entries ?? []).map((item) => (
                      <option key={item.alias} value={item.alias}>
                        {item.alias}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldRow}>
                    <input
                      type="checkbox"
                      data-pool-force=""
                      checked={settings?.subagentPool?.force === true}
                      disabled={
                        saving ||
                        settings == null ||
                        !settings.subagentPool?.defaultAlias
                      }
                      onChange={(e) => {
                        const current = settings?.subagentPool ?? EMPTY_POOL;
                        void persistPool({
                          ...current,
                          force: e.target.checked,
                        });
                      }}
                    />
                    <span>Pin every worker to the default</span>
                  </label>
                  <p className={styles.note}>
                    When pinned, the lead cannot pick a different alias.
                  </p>
                </div>
              </>
            )}
            {poolDraft ? (
              <PoolForm
                draft={poolDraft}
                providers={providers}
                saving={saving}
                onChange={setPoolDraft}
                onCancel={() => {
                  setPoolDraft(null);
                  setError(null);
                }}
                onSubmit={() => void submitPoolDraft()}
              />
            ) : (
              <div className={styles.fieldRow}>
                <button
                  type="button"
                  className={styles.btn}
                  data-add-pool-entry=""
                  disabled={saving || settings == null || providers.length === 0}
                  onClick={() => {
                    setError(null);
                    setPoolDraft(emptyPoolDraft(providers));
                  }}
                >
                  Add candidate
                </button>
              </div>
            )}
          </section>
          )}

          {pane === "git" && (
          <WorktreeGcSection
            active={open && pane === "git"}
            projects={projects}
            onGcScan={onGcScan}
            onGcClean={onGcClean}
          />
          )}

          {pane === "advanced" && (
          <VibeKanbanSection active={open && pane === "advanced"} />
          )}

          {pane === "memory" && (
          <section className={styles.section}>
            <div className={styles.memoryRow}>
              <span
                className={styles.memoryDot}
                data-on={memory?.running ? "true" : undefined}
                aria-hidden
              />
              <span>{memoryLabel}</span>
            </div>
            {memory?.running && (
              <p className={styles.note}>
                {memory.entries != null ? `${memory.entries} entries` : "entries unknown"}
                {memory.vectors != null ? `, ${memory.vectors} embedded` : ""}
              </p>
            )}
            {memory?.lastError && (
              <p className={styles.fieldError} role="alert">
                Janitor error: {memory.lastError}
              </p>
            )}
            <p className={styles.note}>
              Shared memory is project-scoped and injected into agents
              automatically.
            </p>
          </section>
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaneIcon({ id }: { id: SettingsPane }) {
  return (
    <svg
      className={styles.navIcon}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {id === "general" ? (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
        </>
      ) : id === "threads" ? (
        <>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <path d="M3 6h.01M3 12h.01M3 18h.01" />
        </>
      ) : id === "spending" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M14.5 9.5a2.5 2.5 0 0 0-5 0c0 3.5 5 1.5 5 5a2.5 2.5 0 0 1-5 0M12 7v1.5M12 15.5V17" />
        </>
      ) : id === "git" ? (
        <>
          <circle cx="6" cy="6" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="12" cy="18" r="2.2" />
          <path d="M8 7.5v3.2A6 6 0 0 0 12 16M16 7.5v3.2A6 6 0 0 1 12 16" />
        </>
      ) : id === "agents" ? (
        <>
          <circle cx="8" cy="9" r="2.4" />
          <circle cx="16" cy="9" r="2.4" />
          <path d="M4 18c.4-2.4 2.4-4 4-4s3.6 1.6 4 4M12 18c.4-2.4 2.4-4 4-4s3.6 1.6 4 4" />
        </>
      ) : id === "memory" ? (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 13h5" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M4.5 12H8M16 12h3.5M12 4.5V8M12 16v3.5" />
          <path d="m7 7 2.2 2.2M14.8 14.8 17 17M17 7l-2.2 2.2M9.2 14.8 7 17" />
        </>
      )}
    </svg>
  );
}

function ProfileForm({
  draft,
  providers,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: ProfileDraft;
  providers: ProviderInfo[];
  saving: boolean;
  onChange: (draft: ProfileDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const selected = providers.find((p) => p.id === draft.provider);
  const modelInfo = selected?.modelInfo ?? [];
  const efforts = selected?.efforts ?? [];
  const modelValue = draft.customModel ? CUSTOM_MODEL_ID : (draft.model ?? "");
  const providerMissing =
    draft.provider !== "" &&
    !providers.some((p) => p.id === draft.provider);

  const setProvider = (nextId: string) => {
    const next = providers.find((p) => p.id === nextId);
    const modelOk =
      draft.model != null &&
      (next?.modelInfo.some((m) => m.id === draft.model) ?? false);
    const effortOk =
      draft.reasoningEffort != null &&
      (next?.efforts.includes(draft.reasoningEffort) ?? false);
    onChange({
      ...draft,
      provider: nextId,
      model: modelOk ? draft.model : null,
      customModel: false,
      reasoningEffort: effortOk ? draft.reasoningEffort : null,
    });
  };

  return (
    <div className={styles.section}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-name">
          Name
        </label>
        <input
          id="profile-name"
          className={styles.input}
          value={draft.name}
          disabled={saving}
          autoComplete="off"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-provider">
          Provider
        </label>
        <select
          id="profile-provider"
          className={styles.input}
          value={draft.provider}
          disabled={saving}
          onChange={(e) => setProvider(e.target.value)}
        >
          {providerMissing && (
            <option value={draft.provider}>{draft.provider}</option>
          )}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {!p.available ? " (not installed)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-model">
          Model
        </label>
        <select
          id="profile-model"
          className={styles.input}
          value={modelValue}
          disabled={saving}
          onChange={(e) => {
            const value = e.target.value;
            if (value === CUSTOM_MODEL_ID) {
              onChange({ ...draft, customModel: true });
              return;
            }
            onChange({
              ...draft,
              customModel: false,
              model: value === "" ? null : value,
            });
          }}
        >
          <option value="">Default</option>
          {modelInfo.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL_ID}>Custom...</option>
        </select>
        {draft.customModel && (
          <>
            <label className={styles.fieldLabel} htmlFor="profile-model-custom">
              Model id
            </label>
            <input
              id="profile-model-custom"
              className={styles.input}
              value={draft.model ?? ""}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="Model id"
              onChange={(e) =>
                onChange({ ...draft, model: e.target.value || null })
              }
            />
          </>
        )}
      </div>
      {efforts.length > 0 && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="profile-effort">
            Effort
          </label>
          <select
            id="profile-effort"
            className={styles.input}
            value={draft.reasoningEffort ?? ""}
            disabled={saving}
            onChange={(e) =>
              onChange({
                ...draft,
                reasoningEffort: (e.target.value || null) as
                  | ReasoningEffort
                  | null,
              })
            }
          >
            <option value="">Default</option>
            {efforts.map((level) => (
              <option key={level} value={level}>
                {effortDisplayLabel(level)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="profile-permission">
          Permission mode
        </label>
        <select
          id="profile-permission"
          className={styles.input}
          value={draft.permissionMode}
          disabled={saving}
          onChange={(e) =>
            onChange({
              ...draft,
              permissionMode: e.target.value as PermissionMode,
            })
          }
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {PERMISSION_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={onSubmit}
        >
          {draft.id ? "Update" : "Add"}
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function PoolForm({
  draft,
  providers,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: PoolDraft;
  providers: ProviderInfo[];
  saving: boolean;
  onChange: (draft: PoolDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const selected = providers.find((p) => p.id === draft.provider);
  const modelInfo = selected?.modelInfo ?? [];
  const modelValue = draft.customModel ? CUSTOM_MODEL_ID : (draft.model ?? "");
  const providerMissing =
    draft.provider !== "" &&
    !providers.some((p) => p.id === draft.provider);

  const setProvider = (nextId: string) => {
    const next = providers.find((p) => p.id === nextId);
    const modelOk =
      draft.model != null &&
      (next?.modelInfo.some((m) => m.id === draft.model) ?? false);
    onChange({
      ...draft,
      provider: nextId,
      model: modelOk ? draft.model : null,
      customModel: false,
    });
  };

  return (
    <div className={styles.section}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-alias">
          Alias
        </label>
        <input
          id="pool-alias"
          className={styles.input}
          value={draft.alias}
          disabled={saving}
          autoComplete="off"
          spellCheck={false}
          placeholder="fast"
          onChange={(e) => onChange({ ...draft, alias: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-description">
          Description
        </label>
        <input
          id="pool-description"
          className={styles.input}
          value={draft.description}
          disabled={saving}
          autoComplete="off"
          placeholder="Fast and cheap. Good for small edits."
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-provider">
          Provider
        </label>
        <select
          id="pool-provider"
          className={styles.input}
          value={draft.provider}
          disabled={saving}
          onChange={(e) => setProvider(e.target.value)}
        >
          {providerMissing && (
            <option value={draft.provider}>{draft.provider}</option>
          )}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {!p.available ? " (not installed)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="pool-model">
          Model
        </label>
        <select
          id="pool-model"
          className={styles.input}
          value={modelValue}
          disabled={saving}
          onChange={(e) => {
            const value = e.target.value;
            if (value === CUSTOM_MODEL_ID) {
              onChange({ ...draft, customModel: true });
              return;
            }
            onChange({
              ...draft,
              customModel: false,
              model: value === "" ? null : value,
            });
          }}
        >
          <option value="">Default</option>
          {modelInfo.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL_ID}>Custom...</option>
        </select>
        {draft.customModel && (
          <>
            <label className={styles.fieldLabel} htmlFor="pool-model-custom">
              Model id
            </label>
            <input
              id="pool-model-custom"
              className={styles.input}
              value={draft.model ?? ""}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              placeholder="Model id"
              onChange={(e) =>
                onChange({ ...draft, model: e.target.value || null })
              }
            />
          </>
        )}
      </div>
      <div className={styles.fieldRow}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          data-submit-pool=""
          disabled={saving}
          onClick={onSubmit}
        >
          {draft.originalAlias ? "Update" : "Add"}
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
