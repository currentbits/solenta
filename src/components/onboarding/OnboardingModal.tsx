import { useCallback, useEffect, useState } from "react";
import { useEscapeClose } from "../../useEscapeClose";
import type {
  AppSettings,
  ProjectInfo,
  ProviderInfo,
} from "../../shared/ipc";
import CliStep from "./CliStep";
import SetupStep from "./SetupStep";
import TourStep from "./TourStep";
import styles from "./OnboardingModal.module.css";

/** Shared contract for every onboarding step. Follow-up workers fill the bodies. */
export interface OnboardingStepProps {
  providers: ProviderInfo[];
  refreshProviders: () => Promise<void>;
  projects: ProjectInfo[];
  onAddProject: () => void;
  settings: AppSettings | null;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
}

const CONTENT_STEPS = [
  { id: "cli", title: "Agent CLIs", Component: CliStep },
  { id: "setup", title: "Project & defaults", Component: SetupStep },
  { id: "tour", title: "Tour", Component: TourStep },
] as const;

const STEP_IDS = ["welcome", ...CONTENT_STEPS.map((s) => s.id)] as const;

type StepId = (typeof STEP_IDS)[number];

function titleFor(id: StepId): string {
  if (id === "welcome") return "Welcome to Solenta";
  const found = CONTENT_STEPS.find((s) => s.id === id);
  return found ? found.title : id;
}

interface OnboardingModalProps extends OnboardingStepProps {
  open: boolean;
  onClose: () => void;
  onFinish: () => void;
}

export function OnboardingModal({
  open,
  onClose,
  onFinish,
  ...stepProps
}: OnboardingModalProps) {
  const [index, setIndex] = useState(0);
  const handleFinish = useCallback(() => onFinish(), [onFinish]);
  useEscapeClose(open, handleFinish);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  if (!open) return null;

  const stepId: StepId = STEP_IDS[index] ?? "welcome";
  const isFirst = index === 0;
  const isLast = index === STEP_IDS.length - 1;
  const content = CONTENT_STEPS.find((s) => s.id === stepId);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Solenta"
        data-onboarding=""
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{titleFor(stepId)}</h2>
          <button
            type="button"
            className={styles.skip}
            data-onboarding-skip=""
            onClick={onFinish}
          >
            Skip tour
          </button>
        </header>
        <div className={styles.body} data-onboarding-step={stepId}>
          {stepId === "welcome" ? (
            <div className={styles.welcome}>
              <p>
                Solenta is a desk for threads of AI coding agents. Run them in
                parallel as workers in isolated git worktrees, then review the
                diffs and merge from one place.
              </p>
              <p>
                This short tour checks your agent CLIs, adds a project, and
                shows what the app can do.
              </p>
            </div>
          ) : content ? (
            <content.Component {...stepProps} />
          ) : null}
        </div>
        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.btn}
            data-onboarding-back=""
            disabled={isFirst}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            Back
          </button>
          <div
            className={styles.dots}
            data-onboarding-dots=""
            aria-hidden="true"
          >
            {STEP_IDS.map((id, i) => (
              <span
                key={id}
                className={styles.dot}
                data-current={i === index ? "true" : undefined}
              />
            ))}
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            data-onboarding-next=""
            onClick={() => {
              if (isLast) onFinish();
              else setIndex((i) => Math.min(STEP_IDS.length - 1, i + 1));
            }}
          >
            {isLast ? "Finish" : "Next"}
          </button>
        </footer>
      </div>
    </div>
  );
}
