import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeClose } from "../../useEscapeClose";
import { useModalFocus } from "../../useModalFocus";
import type {
  AppSettings,
  ProjectInfo,
  ProviderInfo,
} from "../../shared/ipc";
import CliStep from "./CliStep";
import SetupStep from "./SetupStep";
import TourStep from "./TourStep";
import styles from "./OnboardingModal.module.css";

export type RefreshProviders = (
  options?: { throwOnError?: boolean },
) => Promise<void>;

export interface OnboardingStepProps {
  providers: ProviderInfo[];
  refreshProviders: RefreshProviders;
  projects: ProjectInfo[];
  onAddProject: () => void;
  settings: AppSettings | null;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onCreateFirstThread?: (input: {
    projectId: string;
    provider: string;
  }) => Promise<void>;
  onGoToCli?: () => void;
  onGoToSetup?: () => void;
  firstThreadPending?: boolean;
  firstThreadError?: string | null;
}

const CONTENT_STEPS = [
  {
    id: "cli",
    title: "Agent",
    benefit:
      "Your agents share project context, so each conversation starts with what the last one learned. Connect one agent, add a project, and start a first task.",
    Component: CliStep,
  },
  {
    id: "setup",
    title: "Project",
    benefit: "Add the folder the agent should work in. One project is enough.",
    Component: SetupStep,
  },
  {
    id: "tour",
    title: "First thread",
    benefit: "Open a thread, then write the first task yourself.",
    Component: TourStep,
  },
] as const;

const STEP_IDS = CONTENT_STEPS.map((s) => s.id);

type StepId = (typeof STEP_IDS)[number];

function failMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

interface OnboardingModalProps extends OnboardingStepProps {
  open: boolean;
  /** Hide chrome and drop Escape/focus while a nested dialog (add project) is open. */
  suspended?: boolean;
  onFinish: () => void | Promise<void>;
}

export function OnboardingModal({
  open,
  suspended = false,
  onFinish,
  onCreateFirstThread,
  ...stepProps
}: OnboardingModalProps) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const active = open && !suspended;
  const pending = busy;

  const persistFinish = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPersistError(null);
    try {
      await onFinish();
    } catch (err) {
      setPersistError(failMessage(err, "Could not save onboarding progress"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onFinish]);

  const handleEscape = useCallback(() => {
    void persistFinish();
  }, [persistFinish]);

  useEscapeClose(active && !pending, handleEscape);
  useModalFocus(active, dialogRef);

  useEffect(() => {
    if (open) {
      setIndex(0);
      setPersistError(null);
      setCreateError(null);
    }
  }, [open]);

  const goTo = useCallback((id: StepId) => {
    if (busyRef.current) return;
    const next = STEP_IDS.indexOf(id);
    if (next >= 0) setIndex(next);
  }, []);

  const handleCreateFirstThread = useCallback(
    async (input: { projectId: string; provider: string }) => {
      if (busyRef.current || !onCreateFirstThread) return;
      busyRef.current = true;
      setBusy(true);
      setPersistError(null);
      setCreateError(null);
      try {
        await onCreateFirstThread(input);
        try {
          await onFinish();
        } catch (err) {
          setPersistError(
            failMessage(err, "Could not save onboarding progress"),
          );
        }
      } catch (err) {
        setCreateError(failMessage(err, "Could not create thread"));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCreateFirstThread, onFinish],
  );

  if (!open) return null;

  const stepId: StepId = STEP_IDS[index] ?? "cli";
  const isFirst = index === 0;
  const isLast = index === STEP_IDS.length - 1;
  const content = CONTENT_STEPS.find((s) => s.id === stepId);
  const stepNumber = index + 1;
  const passed: OnboardingStepProps = {
    ...stepProps,
    onCreateFirstThread: onCreateFirstThread
      ? handleCreateFirstThread
      : undefined,
    onGoToCli: () => goTo("cli"),
    onGoToSetup: () => goTo("setup"),
    firstThreadPending: pending,
    firstThreadError: createError,
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      hidden={suspended}
      data-onboarding-backdrop=""
      data-onboarding-suspended={suspended ? "" : undefined}
    >
      <div
        ref={dialogRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`Solenta onboarding, step ${stepNumber} of 3`}
        aria-hidden={suspended || undefined}
        inert={suspended ? true : undefined}
        tabIndex={-1}
        data-onboarding=""
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <p className={styles.progress} data-onboarding-progress="">
              Step {stepNumber} of 3
            </p>
            <h2 className={styles.title}>{content?.title ?? stepId}</h2>
          </div>
          <button
            type="button"
            className={styles.skip}
            data-onboarding-skip=""
            disabled={pending}
            onClick={() => void persistFinish()}
          >
            Skip
          </button>
        </header>
        <div className={styles.body} data-onboarding-step={stepId}>
          {content ? (
            <p className={styles.lead} data-onboarding-benefit="">
              {content.benefit}
            </p>
          ) : null}
          {content ? <content.Component {...passed} /> : null}
          {persistError ? (
            <p
              className={styles.persistError}
              role="alert"
              data-onboarding-persist-error=""
            >
              {persistError}
              <button
                type="button"
                className={styles.btn}
                data-onboarding-persist-retry=""
                disabled={pending}
                onClick={() => void persistFinish()}
              >
                Retry save
              </button>
            </p>
          ) : null}
        </div>
        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.btn}
            data-onboarding-back=""
            disabled={isFirst || pending}
            onClick={() => {
              if (pending) return;
              setIndex((i) => Math.max(0, i - 1));
            }}
          >
            Back
          </button>
          <span className={styles.footerSpacer} />
          {isLast ? (
            <button
              type="button"
              className={styles.btn}
              data-onboarding-next=""
              disabled={pending}
              onClick={() => {
                if (pending) return;
                void persistFinish();
              }}
            >
              Do this later
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              data-onboarding-next=""
              disabled={pending}
              onClick={() => {
                if (pending) return;
                setIndex((i) => Math.min(STEP_IDS.length - 1, i + 1));
              }}
            >
              Next
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
