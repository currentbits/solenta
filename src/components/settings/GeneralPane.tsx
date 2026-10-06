import type { RefObject } from "react";
import type {
  AppSettings,
  AppStatus,
  UpdateStatus,
  WebhookSettings,
  WebhookTestResult,
} from "../../shared/ipc";
import { syncTheme, type ThemePreference } from "../../theme";
import {
  setComposerVimEnabled,
  setEnterSendsEnabled,
  setDivergenceCardEnabled,
  setPasteCardsEnabled,
  setRunDurationEnabled,
  useComposerVimEnabled,
  useEnterSendsEnabled,
  useDivergenceCardEnabled,
  usePasteCardsEnabled,
  useRunDurationEnabled,
} from "../../uiPrefs";
import styles from "../SettingsModal.module.css";
import type { SettingsDraftKey, SettingsModalProps } from "../SettingsModal";

const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const UI_SCALE_STEP = 0.1;

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

      <DisplayPrefsSection />
    </>
  );
}

/** Display prefs (moved from the Environment tab). Same uiPrefs keys. */
function DisplayPrefsSection() {
  const divergence = useDivergenceCardEnabled();
  const runDuration = useRunDurationEnabled();
  const pasteCards = usePasteCardsEnabled();
  const composerVim = useComposerVimEnabled();
  const enterSends = useEnterSendsEnabled();
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
      <label className={styles.fieldRow}>
        <input
          type="checkbox"
          data-enter-sends-pref=""
          checked={enterSends}
          onChange={(e) => setEnterSendsEnabled(e.target.checked)}
        />
        <span>Send with Enter (⇧ Enter for a new line)</span>
      </label>
    </section>
  );
}
