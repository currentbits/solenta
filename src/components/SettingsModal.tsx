import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, AppStatus } from "../shared/ipc";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./SettingsModal.module.css";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Current settings (budget + auto-settle window). */
  settings: AppSettings | null;
  /** Live app status for the memory section. */
  status: AppStatus | null;
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

export function SettingsModal({
  open,
  onClose,
  settings,
  status,
  onSaveSettings,
}: SettingsModalProps) {
  const [budgetText, setBudgetText] = useState("");
  const [settleDaysText, setSettleDaysText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
    setSettleDaysText(settleDaysToInput(settings?.autoSettleAfterDays ?? null));
    setError(null);
    setSaving(false);
    savingRef.current = false;
  }, [open, settings?.dailyBudgetUsd, settings?.autoSettleAfterDays]);

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

      const settleRaw = settleDaysText.trim();
      // Empty = Never (null disables inactivity settle). Otherwise parse.
      const autoSettleAfterDays: number | null =
        settleRaw === "" ? null : Number(settleRaw);

      const saved = await onSaveSettings({
        dailyBudgetUsd,
        autoSettleAfterDays,
      });
      setBudgetText(budgetToInput(saved.dailyBudgetUsd));
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
              {status
                ? `${status.build.version}${
                    status.build.sha ? ` · ${status.build.sha}` : " · dev tree"
                  }${status.build.time ? ` · ${status.build.time}` : ""}`
                : "unknown"}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
