import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../shared/ipc";
import type { OnboardingStepProps } from "./OnboardingModal";
import styles from "./OnboardingModal.module.css";

const PREVIEW_COUNT = 4;
const BUDGET_ERROR =
  "Enter a budget above 0, or leave it blank for no cap.";

function budgetToInput(value: number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

function parseBudget(text: string): number | null {
  const raw = text.trim();
  return raw === "" ? null : Number(raw);
}

function isAllowedBudget(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value > 0);
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
  const [optionalOpen, setOptionalOpen] = useState(false);
  const budgetInputRef = useRef<HTMLInputElement>(null);

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

  const saveBudget = useCallback(() => {
    if (budgetInputRef.current?.validity.badInput) {
      setError(BUDGET_ERROR);
      return;
    }
    const parsed = parseBudget(budgetText);
    if (!isAllowedBudget(parsed)) {
      setError(BUDGET_ERROR);
      return;
    }
    void save({ dailyBudgetUsd: parsed });
  }, [budgetText, save]);

  const defaultsDisabled = settings == null || pending;
  const preview = projects.slice(0, PREVIEW_COUNT);
  const extra = projects.length - preview.length;

  return (
    <div className={styles.step}>
      <h3 className={styles.stepTitle}>Add a project</h3>
      <p className={styles.stepBody}>
        Choose a folder. New threads run against it.
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

      <details
        className={styles.setupSection}
        data-onboarding-optional-defaults=""
        onToggle={(e) => {
          setOptionalOpen((e.currentTarget as HTMLDetailsElement).open);
        }}
      >
        <summary
          className={styles.setupSectionLabel}
          data-onboarding-optional-summary=""
          tabIndex={0}
        >
          Optional defaults
        </summary>
        {optionalOpen ? (
          <fieldset className={styles.setupSection} disabled={defaultsDisabled}>
            <p className={styles.stepBody}>
              You can change these defaults now or later in Settings.
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
                Isolated git worktree for each new thread. Parallel agents do
                not share a checkout; you merge when ready. Uses extra disk.
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
                Delegate the first prompt to a worker in its own worktree. This
                thread supervises instead of doing the work.
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
              Enable both
            </button>

            <div className={styles.setupBudget}>
              <label
                className={styles.setupBudgetLabel}
                htmlFor="onboarding-budget"
              >
                Daily budget (USD)
              </label>
              <div className={styles.setupBudgetRow}>
                <input
                  ref={budgetInputRef}
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
                  onClick={saveBudget}
                >
                  Save
                </button>
              </div>
            </div>
          </fieldset>
        ) : null}
      </details>

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
