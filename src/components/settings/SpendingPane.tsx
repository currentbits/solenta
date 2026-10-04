import type { RefObject } from "react";
import { formatUsd } from "../../digest";
import type { AppSettings, AppStatus } from "../../shared/ipc";
import styles from "../SettingsModal.module.css";
import type { SettingsDraftKey } from "../SettingsModal";

export function SpendingPane({
  settings,
  status,
  saving,
  error,
  setError,
  budgetText,
  setBudgetText,
  orchBudgetText,
  setOrchBudgetText,
  dirtyDrafts,
  save,
}: {
  settings: AppSettings | null;
  status: AppStatus | null;
  saving: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  budgetText: string;
  setBudgetText: (text: string) => void;
  orchBudgetText: string;
  setOrchBudgetText: (text: string) => void;
  dirtyDrafts: RefObject<Set<SettingsDraftKey>>;
  save: () => Promise<void>;
}) {
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

  return (
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
              dirtyDrafts.current.add("daily");
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
        <p className={styles.note} data-budget-unmetered-note="">
          Kimi and Cursor report no USD, so their turns never count toward
          this cap.
        </p>
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
              dirtyDrafts.current.add("orch");
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
  );
}
