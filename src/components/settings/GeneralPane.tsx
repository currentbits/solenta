import { useState, type RefObject } from "react";
import type {
  AppSettings,
  AppStatus,
  NotifyEvents,
  SpeechProvider,
  SpeechSettings,
  ProjectInfo,
  UpdateStatus,
  WebhookSettings,
  WebhookTestResult,
} from "../../shared/ipc";
import { syncTheme, type ThemePreference } from "../../theme";
import { applyContrast } from "../../contrast";
import {
  CHAT_WIDTH_MODES,
  CHAT_WIDTH_LABELS,
  SIDEBAR_PREVIEW_MODES,
  SIDEBAR_PREVIEW_LABELS,
  setChatWidth,
  setComposerSpellcheckEnabled,
  setComposerVimEnabled,
  setDiffFilesCollapsed,
  setEnterSendsEnabled,
  setDivergenceCardEnabled,
  setHighContrastEnabled,
  setPasteCardsEnabled,
  setRunDurationEnabled,
  setSidebarPreview,
  setUsageLimitsStripEnabled,
  setWrapCodeBlocksEnabled,
  useChatWidth,
  useComposerSpellcheckEnabled,
  useComposerVimEnabled,
  useDiffFilesCollapsed,
  useEnterSendsEnabled,
  useDivergenceCardEnabled,
  useHighContrastEnabled,
  usePasteCardsEnabled,
  useRunDurationEnabled,
  useSidebarPreview,
  useUsageLimitsStripEnabled,
  useWrapCodeBlocksEnabled,
  type ChatWidth,
  type SidebarPreview,
} from "../../uiPrefs";
import styles from "../SettingsModal.module.css";
import type { SettingsDraftKey, SettingsModalProps } from "../SettingsModal";

const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const UI_SCALE_STEP = 0.1;

const NOTIFY_EVENT_ROWS: Array<[keyof NotifyEvents, string]> = [
  ["approval", "Approval needed"],
  ["turnFinished", "Turn finished"],
  ["turnFailed", "Turn failed"],
  ["automationFinished", "Automation finished"],
  ["ciFailed", "CI failed on a watched PR"],
];

function formatUiScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export function GeneralPane({
  settings,
  status,
  update,
  saving,
  error,
  setError,
  uiScale,
  setUiScale,
  webhookUrl,
  setWebhookUrl,
  webhookOnDone,
  setWebhookOnDone,
  webhookOnFailed,
  setWebhookOnFailed,
  webhookOnWaiting,
  setWebhookOnWaiting,
  webhookTest,
  setWebhookTest,
  checkingUpdate,
  setCheckingUpdate,
  downloadingUpdate,
  setDownloadingUpdate,
  dirtyDrafts,
  persistWebhook,
  onSaveSettings,
  onTestWebhook,
  onShowOnboarding,
  onCheckUpdate,
  onDownloadUpdate,
  onApplyUpdate,
  projects,
}: {
  settings: AppSettings | null;
  status: AppStatus | null;
  update: UpdateStatus | null | undefined;
  saving: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  uiScale: number;
  setUiScale: (scale: number) => void;
  webhookUrl: string;
  setWebhookUrl: (url: string) => void;
  webhookOnDone: boolean;
  setWebhookOnDone: (on: boolean) => void;
  webhookOnFailed: boolean;
  setWebhookOnFailed: (on: boolean) => void;
  webhookOnWaiting: boolean;
  setWebhookOnWaiting: (on: boolean) => void;
  webhookTest: "idle" | "sending" | WebhookTestResult;
  setWebhookTest: (state: "idle" | "sending" | WebhookTestResult) => void;
  checkingUpdate: boolean;
  setCheckingUpdate: (on: boolean) => void;
  downloadingUpdate: boolean;
  setDownloadingUpdate: (on: boolean) => void;
  dirtyDrafts: RefObject<Set<SettingsDraftKey>>;
  persistWebhook: (next: WebhookSettings) => Promise<boolean>;
  onSaveSettings: SettingsModalProps["onSaveSettings"];
  onTestWebhook: SettingsModalProps["onTestWebhook"];
  onShowOnboarding: SettingsModalProps["onShowOnboarding"];
  onCheckUpdate: SettingsModalProps["onCheckUpdate"];
  onDownloadUpdate: SettingsModalProps["onDownloadUpdate"];
  onApplyUpdate: SettingsModalProps["onApplyUpdate"];
  projects?: ProjectInfo[];
}) {
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

  return (
    <>
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
          <div data-notify-events="">
            {NOTIFY_EVENT_ROWS.map(([key, label]) => (
              <label key={key} className={styles.fieldRow}>
                <input
                  type="checkbox"
                  data-notify-event={key}
                  checked={settings?.notifyEvents?.[key] ?? key !== "ciFailed"}
                  disabled={
                    saving || settings == null || settings.notifications === false
                  }
                  onChange={(e) => {
                    if (!settings) return;
                    setError(null);
                    void onSaveSettings({
                      notifyEvents: {
                        ...settings.notifyEvents,
                        [key]: e.target.checked,
                      },
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <p className={styles.note}>
            These also decide when the sound below plays. CI failed needs PR
            watch on the thread.
          </p>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-notification-sound=""
              checked={settings?.notificationSound ?? false}
              disabled={saving || settings == null}
              onChange={(e) => {
                setError(null);
                void onSaveSettings({
                  notificationSound: e.target.checked,
                }).catch((err) => {
                  setError(
                    err instanceof Error && err.message
                      ? err.message
                      : "Failed to save settings",
                  );
                });
              }}
            />
            <span>Play a sound when a thread needs you</span>
          </label>
          <p className={styles.note}>
            While the window is focused, when a thread finishes, fails or
            asks for permission. In the background the desktop
            notification plays its usual sound. Muted and snoozed threads
            stay quiet. The dock badge counts the threads waiting on you.
          </p>
        </div>
        {(settings?.notifications !== false ||
          settings?.notificationSound === true) && (
          <NotificationProjectsField
            selected={settings?.notificationProjects ?? []}
            projects={projects ?? []}
            disabled={saving || settings == null}
            onChange={(notificationProjects) => {
              setError(null);
              void onSaveSettings({ notificationProjects }).catch((err) => {
                setError(
                  err instanceof Error && err.message
                    ? err.message
                    : "Failed to save settings",
                );
              });
            }}
          />
        )}
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
        <div className={styles.field}>
          <label className={styles.fieldRow}>
            <input
              type="checkbox"
              data-pinch-zoom-window=""
              checked={settings?.pinchZoomWindow !== false}
              disabled={saving || settings == null}
              onChange={(e) => {
                setError(null);
                void onSaveSettings({
                  pinchZoomWindow: e.target.checked,
                }).catch((err) => {
                  setError(
                    err instanceof Error && err.message
                      ? err.message
                      : "Failed to save settings",
                  );
                });
              }}
            />
            <span>Pinch to zoom the window</span>
          </label>
          <p className={styles.note}>
            A trackpad pinch magnifies the window like a browser, separate
            from Cmd/Ctrl+Plus/Minus.
          </p>
        </div>
        {status?.build.platform && status.build.platform !== "darwin" && (
          <div className={styles.field}>
            <label className={styles.fieldRow}>
              <input
                type="checkbox"
                data-close-to-tray=""
                checked={settings?.closeToTray === true}
                disabled={saving || settings == null}
                onChange={(e) => {
                  setError(null);
                  void onSaveSettings({
                    closeToTray: e.target.checked,
                  }).catch((err) => {
                    setError(
                      err instanceof Error && err.message
                        ? err.message
                        : "Failed to save settings",
                    );
                  });
                }}
              />
              <span>Keep running in the tray when the window is closed</span>
            </label>
            <p className={styles.note}>
              Closing the window hides it behind a tray icon instead of
              quitting. Quit from the tray or the Quit menu to actually stop.
            </p>
          </div>
        )}
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
                  {": "}
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

      <VoiceInputSection
        settings={settings}
        saving={saving}
        onSaveSettings={onSaveSettings}
        setError={setError}
      />
      <DisplayPrefsSection />
    </>
  );
}

const CLOUD_SPEECH: Record<
  Exclude<SpeechProvider, "local">,
  { label: string; keyField: "openaiApiKey" | "elevenlabsApiKey"; has: "hasOpenaiKey" | "hasElevenlabsKey"; placeholder: string }
> = {
  openai: { label: "OpenAI", keyField: "openaiApiKey", has: "hasOpenaiKey", placeholder: "sk-…" },
  elevenlabs: { label: "ElevenLabs", keyField: "elevenlabsApiKey", has: "hasElevenlabsKey", placeholder: "xi-api-key" },
};

/**
 * Voice input provider (#1725). Local is the default; a cloud provider
 * uploads each recording and falls back to local on an error. Keys are
 * write-only: the field stays empty and the note says whether one is saved.
 */
function VoiceInputSection({
  settings,
  saving,
  onSaveSettings,
  setError,
}: {
  settings: AppSettings | null;
  saving: boolean;
  onSaveSettings: SettingsModalProps["onSaveSettings"];
  setError: (msg: string | null) => void;
}) {
  const provider = settings?.speech?.provider ?? "local";
  const cloud = provider === "local" ? null : CLOUD_SPEECH[provider];
  const [keyText, setKeyText] = useState("");
  // A partial patch: main keeps the omitted provider/keys.
  const save = (speech: Partial<SpeechSettings>) => {
    setError(null);
    return onSaveSettings({ speech: speech as SpeechSettings }).catch((err) => {
      setError(err instanceof Error && err.message ? err.message : "Failed to save settings");
    });
  };
  const hasKey = cloud ? settings?.speech?.[cloud.has] === true : false;
  return (
    <section className={styles.section} data-voice-input="">
      <h3 className={styles.sectionLabel}>Voice input</h3>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="speech-provider">
          Speech-to-text
        </label>
        <select
          id="speech-provider"
          className={styles.input}
          data-speech-provider=""
          value={provider}
          disabled={saving || settings == null}
          onChange={(e) => {
            setKeyText("");
            void save({ provider: e.target.value as SpeechProvider });
          }}
        >
          <option value="local">Local model (private, offline)</option>
          <option value="openai">OpenAI</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>
        <p className={styles.note}>
          {cloud
            ? `Each recording is sent to ${cloud.label} when you stop dictating. If that fails, the local model is used, when installed.`
            : "Runs on this machine. The model downloads the first time you use the mic."}
        </p>
      </div>
      {cloud && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="speech-api-key">
            {cloud.label} API key
          </label>
          <div className={styles.fieldRow}>
            <input
              id="speech-api-key"
              className={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={hasKey ? "Saved. Paste a new key to replace it" : cloud.placeholder}
              value={keyText}
              disabled={saving}
              data-speech-api-key=""
              onChange={(e) => setKeyText(e.target.value)}
            />
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={saving || !keyText.trim()}
              data-speech-api-key-save=""
              onClick={() => {
                void save({ [cloud.keyField]: keyText.trim() }).then(() => setKeyText(""));
              }}
            >
              Save key
            </button>
            {hasKey && (
              <button
                type="button"
                className={styles.btn}
                disabled={saving}
                data-speech-api-key-clear=""
                onClick={() => void save({ [cloud.keyField]: null })}
              >
                Remove
              </button>
            )}
          </div>
          <p className={styles.note} data-speech-key-state="">
            {hasKey
              ? "A key is saved, encrypted on this machine."
              : "No key saved yet. Dictation stays local until you add one."}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Which projects' threads notify (#1746). An empty list is "All projects";
 * ids of deleted projects are dropped from the count and the next save.
 */
function NotificationProjectsField({
  selected,
  projects,
  disabled,
  onChange,
}: {
  selected: string[];
  projects: ProjectInfo[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const live = selected.filter((id) => projects.some((p) => p.id === id));
  const all = live.length === 0;
  const q = query.trim().toLowerCase();
  const shown = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects;
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...live, id] : live.filter((x) => x !== id));
  return (
    <details className={styles.field} data-notification-projects="">
      <summary className={styles.fieldLabel}>
        Notification projects:{" "}
        <span data-notification-projects-summary="">
          {all
            ? "All projects"
            : `${live.length} ${live.length === 1 ? "project" : "projects"}`}
        </span>
      </summary>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-notification-projects-all=""
          checked={all}
          disabled={disabled || all}
          onChange={() => onChange([])}
        />
        <span>All projects</span>
      </label>
      {/* ponytail: filter only for long lists; no fuzzy match */}
      {projects.length > 8 && (
        <input
          type="search"
          className={styles.input}
          placeholder="Filter projects"
          aria-label="Filter projects"
          data-notification-projects-filter=""
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {shown.map((p) => (
        <label key={p.id} className={styles.fieldRow}>
          <input
            type="checkbox"
            data-notification-project={p.id}
            checked={live.includes(p.id)}
            disabled={disabled}
            onChange={(e) => toggle(p.id, e.target.checked)}
          />
          <span>{p.name}</span>
        </label>
      ))}
      {!all && (
        <button
          type="button"
          className={styles.btn}
          data-notification-projects-reset=""
          disabled={disabled}
          onClick={() => onChange([])}
        >
          Reset to all projects
        </button>
      )}
      <p className={styles.note}>
        Only threads in the checked projects send a desktop notification or
        play the sound. Nothing checked means every project.
      </p>
    </details>
  );
}

/** Display prefs (moved from the Environment tab). Same uiPrefs keys. */
function DisplayPrefsSection() {
  const divergence = useDivergenceCardEnabled();
  const runDuration = useRunDurationEnabled();
  const pasteCards = usePasteCardsEnabled();
  const composerVim = useComposerVimEnabled();
  const composerSpellcheck = useComposerSpellcheckEnabled();
  const enterSends = useEnterSendsEnabled();
  const usageLimits = useUsageLimitsStripEnabled();
  const wrapCode = useWrapCodeBlocksEnabled();
  const diffFilesCollapsed = useDiffFilesCollapsed();
  const chatWidth = useChatWidth();
  const highContrast = useHighContrastEnabled();
  const sidebarPreview = useSidebarPreview();
  return (
    <section className={styles.section} data-display-prefs="">
      <h3 className={styles.sectionLabel}>Display</h3>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="chat-width-pref">
          Chat width
        </label>
        <select
          id="chat-width-pref"
          className={styles.input}
          data-chat-width-pref=""
          value={chatWidth}
          onChange={(e) => setChatWidth(e.target.value as ChatWidth)}
        >
          {CHAT_WIDTH_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {CHAT_WIDTH_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="sidebar-preview-pref">
          Sidebar preview
        </label>
        <select
          id="sidebar-preview-pref"
          className={styles.input}
          data-sidebar-preview-pref=""
          value={sidebarPreview}
          onChange={(e) => setSidebarPreview(e.target.value as SidebarPreview)}
        >
          {SIDEBAR_PREVIEW_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {SIDEBAR_PREVIEW_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
      <p className={styles.note}>
        How many lines of a thread's title show in the sidebar row. None
        hides it and tightens the row.
      </p>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-high-contrast-pref=""
          checked={highContrast}
          onChange={(e) => {
            setHighContrastEnabled(e.target.checked);
            applyContrast(e.target.checked);
          }}
        />
        <span>Increase contrast</span>
      </label>
      <p className={styles.note}>
        Stronger borders and muted text in either theme. Off by default, but
        the OS &quot;increase contrast&quot; setting applies the same look on
        its own even then.
      </p>
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
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-composer-spellcheck-pref=""
          checked={composerSpellcheck}
          onChange={(e) => setComposerSpellcheckEnabled(e.target.checked)}
        />
        <span>Spellcheck in the composer</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-enter-sends-pref=""
          checked={enterSends}
          onChange={(e) => setEnterSendsEnabled(e.target.checked)}
        />
        <span>Send with Enter (⇧ Enter for a new line)</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-usage-limits-strip-pref=""
          checked={usageLimits}
          onChange={(e) => setUsageLimitsStripEnabled(e.target.checked)}
        />
        <span>Show usage limits in thread</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-wrap-code-pref=""
          checked={wrapCode}
          onChange={(e) => setWrapCodeBlocksEnabled(e.target.checked)}
        />
        <span>Wrap long lines in code blocks</span>
      </label>
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-diff-files-collapsed-pref=""
          checked={diffFilesCollapsed}
          onChange={(e) => setDiffFilesCollapsed(e.target.checked)}
        />
        <span>Start diff files collapsed</span>
      </label>
      <p className={styles.note}>
        A quiet strip above the composer with the 5-hour, weekly and
        context limits as percent left. Off by default.
      </p>
    </section>
  );
}
