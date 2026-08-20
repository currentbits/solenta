import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../../shared/ipc";
import type { OnboardingStepProps } from "./OnboardingModal";
import styles from "./OnboardingModal.module.css";

const PREVIEW_COUNT = 4;

function budgetToInput(value: number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

function parseBudget(text: string): number | null {
  const raw = text.trim();
  return raw === "" ? null : Number(raw);
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message
    ? err.message
    : "Failed to save settings";
}

export default function SetupStep({
  projects,
  onAddProject,
  settings,
  onSaveSettings,
}: OnboardingStepProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budgetText, setBudgetText] = useState("");
  const [budgetSeeded, setBudgetSeeded] = useState(false);

  useEffect(() => {
    if (!settings || budgetSeeded) return;
    setBudgetText(budgetToInput(settings.dailyBudgetUsd));
    setBudgetSeeded(true);
  }, [settings, budgetSeeded]);

  const save = useCallback(
    async (patch: Partial<AppSettings>) => {
      setPending(true);
      setError(null);
      try {
        await onSaveSettings(patch);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setPending(false);
      }
    },
    [onSaveSettings],
  );

  const defaultsDisabled = settings == null || pending;
  const preview = projects.slice(0, PREVIEW_COUNT);
  const extra = projects.length - preview.length;

  return (
    <div className={styles.step}>
      <h3 className={styles.stepTitle}>Project & defaults</h3>
      <p className={styles.stepBody}>
        Add a project and pick recommended defaults
      </p>

      {projects.length === 0 ? (
        <div className={styles.setupSection}>
          <p className={styles.stepBody}>
            A folder that is not a git repo gets initialized automatically.
          </p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            data-onboarding-add-project=""
            onClick={onAddProject}
          >
            Add project
          </button>
        </div>
      ) : (
        <div className={styles.setupSection} data-onboarding-projects-done="">
          <p className={styles.stepBody}>
            {projects.length === 1
              ? "1 project added"
              : `${projects.length} projects added`}
          </p>
          <ul className={styles.setupProjectList}>
            {preview.map((p) => (
              <li key={p.id}>{p.name}</li>
            ))}
            {extra > 0 ? (
              <li className={styles.setupProjectMore}>and {extra} more</li>
            ) : null}
          </ul>
        </div>
      )}

      <fieldset className={styles.setupSection} disabled={defaultsDisabled}>
        <legend className={styles.setupSectionLabel}>Recommended defaults</legend>
        <p className={styles.stepBody}>
          Headline features ship off. Turn them on so new threads match how
          Solenta is meant to run.
        </p>

        <label className={styles.setupToggle}>
          <input
            type="checkbox"
            data-onboarding-default-worktree=""
            checked={settings?.defaultWorktree ?? false}
            onChange={(e) => {
              void save({ defaultWorktree: e.target.checked });
            }}
          />
          <span>
            Run new threads in isolated git worktrees so parallel agents never
            collide
          </span>
        </label>

        <label className={styles.setupToggle}>
          <input
            type="checkbox"
            data-onboarding-default-orchestrate=""
            checked={settings?.defaultOrchestrate ?? false}
            onChange={(e) => {
              void save({ defaultOrchestrate: e.target.checked });
            }}
          />
          <span>
            Delegate new threads to a worker. The first prompt is handed to a
            worker in its own worktree; this thread supervises.
          </span>
        </label>

        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          data-onboarding-recommended=""
          onClick={() => {
            void save({ defaultWorktree: true, defaultOrchestrate: true });
          }}
        >
          Use recommended
        </button>

        <div className={styles.setupBudget}>
          <label className={styles.setupBudgetLabel} htmlFor="onboarding-budget">
            Daily budget (USD)
          </label>
          <div className={styles.setupBudgetRow}>
            <input
              id="onboarding-budget"
              className={styles.setupInput}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="No cap"
              value={budgetText}
              data-onboarding-budget=""
              onChange={(e) => {
                setBudgetText(e.target.value);
                setError(null);
              }}
            />
            <button
              type="button"
              className={styles.btn}
              data-onboarding-budget-save=""
              onClick={() => {
                void save({ dailyBudgetUsd: parseBudget(budgetText) });
              }}
            >
              Save
            </button>
          </div>
        </div>
      </fieldset>

      {error ? (
        <p
          className={styles.setupError}
          role="alert"
          data-onboarding-setup-error=""
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
