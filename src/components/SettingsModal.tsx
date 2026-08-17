import { useCallback, useEffect, useRef, useState } from "react";
import {
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
} from "../format";
import {
  CUSTOM_MODEL_ID,
  effortDisplayLabel,
  profileSummary,
} from "../modelPicker";
import type {
  AgentProfile,
  AppSettings,
  AppStatus,
  OtelSettings,
  PermissionMode,
  ProviderInfo,
  ReasoningEffort,
  UpdateStatus,
} from "../shared/ipc";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./SettingsModal.module.css";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
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
  settings,
  providers = [],
  status,
  update,
  onCheckUpdate,
  onDownloadUpdate,
  onApplyUpdate,
  onSaveSettings,
}: SettingsModalProps) {
  const [budgetText, setBudgetText] = useState("");
  const [orchBudgetText, setOrchBudgetText] = useState("");
  const [settleDaysText, setSettleDaysText] = useState("");
  const [otelEndpoint, setOtelEndpoint] = useState("");
  const [otelHeadersText, setOtelHeadersText] = useState("");
  const [otelClaudeMetrics, setOtelClaudeMetrics] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
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
    setBudgetText(budgetToInput(settings?.dailyBudgetUsd ?? null));
    setOrchBudgetText(
      budgetToInput(settings?.orchestrationBudgetUsd ?? null),
    );
    setSettleDaysText(settleDaysToInput(settings?.autoSettleAfterDays ?? null));
    const otel = settings?.otel ?? EMPTY_OTEL;
    setOtelEndpoint(otel.endpoint ?? "");
    setOtelHeadersText(formatOtelHeaders(otel.headers));
    setOtelClaudeMetrics(otel.claudeMetrics);
    setDraft(null);
    setError(null);
    setSaving(false);
    savingRef.current = false;
  }, [open, settings?.dailyBudgetUsd, settings?.orchestrationBudgetUsd, settings?.autoSettleAfterDays, settings?.otel]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEscapeClose(open, handleClose);

  if (!open) return null;

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

      const saved = await onSaveSettings({
        dailyBudgetUsd,
        orchestrationBudgetUsd,
        autoSettleAfterDays,
      });
      setBudgetText(budgetToInput(saved.dailyBudgetUsd));
      setOrchBudgetText(budgetToInput(saved.orchestrationBudgetUsd));
      setSettleDaysText(settleDaysToInput(saved.autoSettleAfterDays));
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
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
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

        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.sectionLabel}>Budget</h3>
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
              {error && (
                <p className={styles.fieldError} role="alert">
                  {error}
                </p>
              )}
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
            </div>
          </section>

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
          </section>

          <section className={styles.section} data-otel-settings="">
            <h3 className={styles.sectionLabel}>OpenTelemetry</h3>
            {error && (
              <p className={styles.fieldError} role="alert">
                {error}
              </p>
            )}
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

          <section className={styles.section}>
            <h3 className={styles.sectionLabel}>Memory</h3>
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

          <section className={styles.section}>
            <h3 className={styles.sectionLabel}>Build</h3>
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
        </div>
      </div>
    </div>
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
