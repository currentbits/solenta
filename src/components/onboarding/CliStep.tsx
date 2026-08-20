import { useState } from "react";
import type { OnboardingStepProps } from "./OnboardingModal";
import { hintFor } from "./installHints";
import styles from "./OnboardingModal.module.css";

export default function CliStep({
  providers,
  refreshProviders,
}: OnboardingStepProps) {
  const [checking, setChecking] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const rows = providers.filter((p) => p.id !== "simulate");
  const anyInstalled = rows.some((p) => p.available);

  async function recheck() {
    setChecking(true);
    try {
      await refreshProviders();
    } finally {
      setChecking(false);
    }
  }

  async function copyCommand(id: string, command: string) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === id ? null : cur));
      }, 1500);
    } catch {
      // jsdom has no clipboard; permission denied on some hosts.
    }
  }

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <h3 className={styles.stepTitle}>Agent CLIs</h3>
        <button
          type="button"
          className={styles.btn}
          data-onboarding-cli-recheck=""
          disabled={checking}
          onClick={() => void recheck()}
        >
          Recheck
        </button>
      </div>
      <p className={styles.stepBody}>
        Solenta does not bundle any agent; it finds CLIs on your PATH.
      </p>
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
      {!anyInstalled ? (
        <p className={styles.cliWarning} data-onboarding-cli-warning="" role="status">
          Runs will fail until a CLI is installed.
        </p>
      ) : null}
    </div>
  );
}
