import type { RefObject } from "react";
import type { AppSettings, ProviderInfo } from "../../shared/ipc";
import styles from "../SettingsModal.module.css";
import type { SettingsDraftKey, SettingsModalProps } from "../SettingsModal";

export function ThreadsPane({
  settings,
  providers,
  saving,
  error,
  setError,
  settleDaysText,
  setSettleDaysText,
  dirtyDrafts,
  save,
  onSaveSettings,
}: {
  settings: AppSettings | null;
  providers: ProviderInfo[];
  saving: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  settleDaysText: string;
  setSettleDaysText: (text: string) => void;
  dirtyDrafts: RefObject<Set<SettingsDraftKey>>;
  save: () => Promise<void>;
  onSaveSettings: SettingsModalProps["onSaveSettings"];
}) {
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

  return (
    <>
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
                dirtyDrafts.current.add("settle");
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
            Empty means Never: quiet threads only settle via PR state or
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
          <label className={styles.fieldLabel} htmlFor="default-provider">
            Default provider
          </label>
          <select
            id="default-provider"
            className={styles.input}
            data-default-provider=""
            value={settings?.defaultProvider ?? ""}
            disabled={saving || settings == null || providers.length === 0}
            onChange={(e) => {
              const provider = e.target.value || null;
              setError(null);
              void onSaveSettings({
                defaultProvider: provider,
                defaultModel: null,
              }).catch((err) => {
                setError(
                  err instanceof Error && err.message
                    ? err.message
                    : "Failed to save settings",
                );
              });
            }}
          >
            <option value="">Claude Code (built-in)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {!p.available ? " (not installed)" : ""}
              </option>
            ))}
          </select>
          <p className={styles.note}>
            Used when a new thread cannot inherit from the selected one:
            autodispatch, issue-created threads, and the first thread in a
            project.
          </p>
          {(() => {
            const providerId = settings?.defaultProvider || "";
            const selected = providers.find((p) => p.id === providerId);
            const modelInfo = selected?.modelInfo ?? [];
            if (!providerId) return null;
            const known = modelInfo.some((m) => m.id === settings?.defaultModel);
            return (
              <>
                <label className={styles.fieldLabel} htmlFor="default-model">
                  Default model
                </label>
                <select
                  id="default-model"
                  className={styles.input}
                  data-default-model=""
                  value={settings?.defaultModel ?? ""}
                  disabled={saving || settings == null}
                  onChange={(e) => {
                    const value = e.target.value;
                    setError(null);
                    void onSaveSettings({
                      defaultModel: value === "" ? null : value,
                    }).catch((err) => {
                      setError(
                        err instanceof Error && err.message
                          ? err.message
                          : "Failed to save settings",
                      );
                    });
                  }}
                >
                  <option value="">Provider default</option>
                  {modelInfo.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {settings?.defaultModel && !known && (
                    <option value={settings.defaultModel}>
                      {settings.defaultModel}
                    </option>
                  )}
                </select>
              </>
            );
          })()}
          {providers.some((p) => p.catalogNote) ? (
            <ul className={styles.doctorList} data-catalog-doctor="">
              {providers
                .filter((p) => p.catalogNote)
                .map((p) => (
                  <li
                    key={p.id}
                    className={styles.doctorItem}
                    data-catalog-doctor-row={p.id}
                  >
                    <p className={styles.note}>{p.catalogNote}</p>
                  </li>
                ))}
            </ul>
          ) : null}
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
        {providers.length > 0 && (
          <div className={styles.field} data-quota-failover="">
            <span className={styles.fieldLabel}>Quota failover</span>
            {providers.map((p) => {
              const chain = settings?.quotaFailover ?? [];
              return (
                <label className={styles.fieldRow} key={p.id}>
                  <input
                    type="checkbox"
                    data-quota-failover-id={p.id}
                    checked={chain.includes(p.id)}
                    disabled={saving || settings == null}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      const next = providers
                        .map((row) => row.id)
                        .filter((id) =>
                          id === p.id ? checked : chain.includes(id),
                        );
                      setError(null);
                      void onSaveSettings({ quotaFailover: next }).catch(
                        (err) => {
                          setError(
                            err instanceof Error && err.message
                              ? err.message
                              : "Failed to save settings",
                          );
                        },
                      );
                    }}
                  />
                  <span>
                    {p.name}
                    {!p.available ? " (not installed)" : ""}
                  </span>
                </label>
              );
            })}
            <p className={styles.note}>
              When a turn hits a usage limit or exhausted balance, try
              these providers in the order shown instead of parking or
              failing. The current provider is skipped. Empty = no
              failover.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
