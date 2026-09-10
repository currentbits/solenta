import { useEffect, useMemo, useState } from "react";
import type { OnboardingStepProps } from "./OnboardingModal";
import styles from "./OnboardingModal.module.css";

const DOCS = "https://solenta.app/docs.html";
const EXAMPLE_PROMPT = "Look at this project and tell me what it does.";

export default function TourStep({
  providers,
  projects,
  onCreateFirstThread,
  onGoToCli,
  onGoToSetup,
  firstThreadPending = false,
  firstThreadError = null,
}: OnboardingStepProps) {
  const available = useMemo(
    () => providers.filter((p) => p.id !== "simulate" && p.available),
    [providers],
  );
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [providerId, setProviderId] = useState(available[0]?.id ?? "");

  useEffect(() => {
    if (!projects.some((p) => p.id === projectId)) {
      setProjectId(projects[0]?.id ?? "");
    }
  }, [projects, projectId]);

  useEffect(() => {
    if (!available.some((p) => p.id === providerId)) {
      setProviderId(available[0]?.id ?? "");
    }
  }, [available, providerId]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const provider = available.find((p) => p.id === providerId) ?? null;
  const canCreate = Boolean(project && provider && onCreateFirstThread);
  const missingProject = projects.length === 0;
  const missingProvider = available.length === 0;

  return (
    <div className={styles.step} data-onboarding-tour="">
      <p className={styles.stepBody}>
        Pick a project and an installed agent. The composer stays empty so you
        can edit the first prompt before anything runs.
      </p>

      {missingProject ? (
        <p className={styles.stepBody}>
          Add a project first.
          {onGoToSetup ? (
            <>
              {" "}
              <button
                type="button"
                className={styles.textLink}
                data-onboarding-goto-setup=""
                disabled={firstThreadPending}
                onClick={onGoToSetup}
              >
                Go to Project
              </button>
            </>
          ) : null}
        </p>
      ) : projects.length === 1 && project ? (
        <p
          className={styles.choiceValue}
          data-onboarding-project={project.id}
        >
          Project: {project.name}
        </p>
      ) : (
        <label className={styles.choice}>
          <span className={styles.choiceLabel}>Project</span>
          <select
            className={styles.setupInput}
            data-onboarding-project-select=""
            data-onboarding-project={projectId}
            value={projectId}
            disabled={firstThreadPending}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {missingProvider ? (
        <p className={styles.stepBody}>
          Install an agent CLI first. Only installed agents can start a thread.
          {onGoToCli ? (
            <>
              {" "}
              <button
                type="button"
                className={styles.textLink}
                data-onboarding-goto-cli=""
                disabled={firstThreadPending}
                onClick={onGoToCli}
              >
                Go to Agent
              </button>
            </>
          ) : null}
        </p>
      ) : available.length === 1 && provider ? (
        <p
          className={styles.choiceValue}
          data-onboarding-provider={provider.id}
        >
          Agent: {provider.name}
        </p>
      ) : (
        <label className={styles.choice}>
          <span className={styles.choiceLabel}>Agent</span>
          <select
            className={styles.setupInput}
            data-onboarding-provider-select=""
            data-onboarding-provider={providerId}
            value={providerId}
            disabled={firstThreadPending}
            onChange={(e) => setProviderId(e.target.value)}
          >
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className={styles.choiceLabel}>Example prompt</p>
      <p className={styles.suggestion} data-onboarding-example="">
        {EXAMPLE_PROMPT}
      </p>
      <p className={styles.stepBody}>
        Write your task, then press Send when you are ready.
      </p>

      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        data-onboarding-create-thread=""
        disabled={!canCreate || firstThreadPending}
        onClick={() => {
          if (!canCreate || firstThreadPending || !project || !provider) return;
          void onCreateFirstThread?.({
            projectId: project.id,
            provider: provider.id,
          });
        }}
      >
        {firstThreadPending ? "Creating…" : "Create first thread"}
      </button>

      {firstThreadError ? (
        <p
          className={styles.setupError}
          role="alert"
          data-onboarding-first-error=""
        >
          {firstThreadError}
        </p>
      ) : null}

      <a
        className={styles.tourCardLink}
        href={DOCS}
        target="_blank"
        rel="noreferrer"
        data-onboarding-docs=""
      >
        Docs
      </a>
    </div>
  );
}
