import { useState } from "react";
import type { OnboardingStepProps } from "./OnboardingModal";
import { hintFor } from "./installHints";
import styles from "./OnboardingModal.module.css";

/** useCoder.refreshProviders accepts this; the step prop type is still zero-arg. */
type RefreshProviders = (opts?: { throwOnError?: boolean }) => Promise<void>;

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message
    ? err.message
    : "Could not recheck PATH";
}

export default function CliStep({
  providers,
  refreshProviders,
}: OnboardingStepProps) {
  const refresh = refreshProviders as RefreshProviders;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const rows = providers
    .filter((p) => p.id !== "simulate")
    .slice()
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
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopyError(null);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === id ? null : cur));
      }, 1500);
    } catch (err) {
      setCopiedId(null);
      setCopyError(errorMessage(err));
    }
  }

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h3 className={styles.stepTitle}>One agent CLI</h3>
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
        One CLI on PATH is enough. Installed means the binary was found, not
        that you are signed in. Sign in from that CLI&apos;s terminal; Recheck
        does not verify a login.
      </p>
      {checking ? (
        <p
          className={styles.stepBody}
          data-onboarding-cli-status="pending"
          role="status"
        >
          Checking PATH…
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
          Checked PATH. Sign-in still happens in the CLI.
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
          No detection result. Recheck after a CLI is on your PATH.
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
          Copy an install command below, then Recheck. One CLI is enough.
        </p>
      ) : null}
    </div>
  );
}
