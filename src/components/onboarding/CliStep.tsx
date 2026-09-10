import { useState } from "react";
import type { OnboardingStepProps } from "./OnboardingModal";
import { hintFor } from "./installHints";
import styles from "./OnboardingModal.module.css";

const COPY_FAIL = "Could not copy. Select and copy the command.";

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Could not recheck";
}

export default function CliStep({
  providers,
  refreshProviders,
}: OnboardingStepProps) {
  const refresh: (options?: { throwOnError?: boolean }) => Promise<void> =
    refreshProviders;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const rows = providers
    .filter((p) => p.id !== "simulate")
    .sort((a, b) => Number(b.available) - Number(a.available));
  const anyInstalled = rows.some((p) => p.available);

  async function recheck() {
    setChecking(true);
    setError(null);
    setChecked(false);
    try {
      await refresh({ throwOnError: true });
      setChecked(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  async function copyCommand(id: string, command: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopiedId(null);
      setCopyError(COPY_FAIL);
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      setCopyError(null);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === id ? null : cur));
      }, 1500);
    } catch {
      setCopiedId(null);
      setCopyError(COPY_FAIL);
    }
  }

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h3 className={styles.stepTitle}>One coding agent is enough</h3>
        <button
          type="button"
          className={styles.btn}
          data-onboarding-cli-recheck=""
          disabled={checking}
          aria-busy={checking ? "true" : undefined}
          onClick={() => void recheck()}
        >
          {checking ? "Checking…" : "Recheck"}
        </button>
      </div>
      <p className={styles.stepBody}>
        Installed means Solenta found the agent on the machine running the
        app, not that you are signed in. Sign in using a terminal on that
        machine.
      </p>
      {checking ? (
        <p
          className={styles.stepBody}
          data-onboarding-cli-status="pending"
          role="status"
        >
          Checking…
        </p>
      ) : null}
      {error ? (
        <p
          className={styles.setupError}
          data-onboarding-cli-error=""
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {checked && !error ? (
        <p
          className={styles.stepBody}
          data-onboarding-cli-status="ok"
          role="status"
        >
          Installation detected. Sign in using a terminal on the machine
          running Solenta.
        </p>
      ) : null}
      {copyError ? (
        <p
          className={styles.setupError}
          data-onboarding-cli-copy-error=""
          role="alert"
        >
          {copyError}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p
          className={styles.stepBody}
          data-onboarding-cli-empty=""
          role="status"
        >
          No detection result. Recheck after you install an agent.
        </p>
      ) : (
        <ul className={styles.cliList}>
          {rows.map((p) => {
            const hint = p.available ? null : hintFor(p.id);
            return (
              <li
                key={p.id}
                className={styles.cliRow}
                data-onboarding-cli-row={p.id}
                data-available={p.available ? "true" : "false"}
              >
                <div className={styles.cliRowMain}>
                  <span className={styles.cliName}>{p.name}</span>
                  <span className={styles.cliState}>
                    {p.available ? "✓ Installed" : "Not installed"}
                  </span>
                </div>
                {hint ? (
                  <>
                    <div className={styles.cliHintRow}>
                      <code
                        className={styles.cliHint}
                        data-onboarding-cli-hint=""
                      >
                        {hint.command}
                      </code>
                      <button
                        type="button"
                        className={styles.btn}
                        onClick={() => void copyCommand(p.id, hint.command)}
                      >
                        {copiedId === p.id ? "Copied" : "Copy"}
                      </button>
                    </div>
                    {hint.url ? (
                      <a
                        className={styles.cliDocs}
                        href={hint.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {hint.url.replace(/^https:\/\//, "")}
                      </a>
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && !anyInstalled ? (
        <p className={styles.cliWarning} data-onboarding-cli-warning="" role="status">
          Install one agent using its instructions, then Recheck.
        </p>
      ) : null}
    </div>
  );
}
