/**
 * Compact Committing / Pushing / Creating PR / Linking progress list shown
 * by CreatePrDialog and ChangesPanel's inline Commit & PR button while
 * createPr streams "pr:progress" (issue #1803).
 */
import { PR_STEP_ORDER, type PrStepUiState, type PrSteps } from "../prProgress";
import type { PrStep } from "../shared/ipc";
import styles from "./PrStepList.module.css";

const LABEL: Record<PrStep, string> = {
  commit: "Committing",
  push: "Pushing",
  create: "Creating PR",
  link: "Linking",
};

const ICON: Record<PrStepUiState, string> = {
  pending: "○",
  active: "…",
  done: "✓",
  error: "✗",
  skipped: "–",
};

export function PrStepList({ steps }: { steps: PrSteps }) {
  return (
    <ol className={styles.list} data-pr-steps="">
      {PR_STEP_ORDER.map((step) => {
        const { state, detail } = steps[step];
        return (
          <li
            key={step}
            className={styles.row}
            data-pr-step={step}
            data-pr-step-state={state}
          >
            <span className={styles.icon} aria-hidden="true">
              {ICON[state]}
            </span>
            <span className={styles.label}>
              {LABEL[step]}
              {state === "active" ? "…" : ""}
              {state === "skipped" ? " (skipped)" : ""}
            </span>
            {state === "error" && detail ? (
              <span className={styles.detail}>{detail}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
