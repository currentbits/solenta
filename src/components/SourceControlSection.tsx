import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import { providerReady } from "../sourceControl";
import type {
  CoderApi,
  SourceControlDiscovery,
  SourceControlProvider,
} from "../shared/ipc";
import styles from "./SettingsModal.module.css";

export interface SourceControlSectionProps {
  /** Settings remounts this on each open. */
  active: boolean;
  onDiscover?: (input?: {
    rescan?: boolean;
  }) => Promise<SourceControlDiscovery>;
}

function resolveDiscover(
  onDiscover?: SourceControlSectionProps["onDiscover"],
): ((input?: { rescan?: boolean }) => Promise<SourceControlDiscovery>) | null {
  if (onDiscover) return onDiscover;
  try {
    const existing = (window as unknown as { coder?: CoderApi }).coder;
    if (existing && typeof existing.sourceControl?.discover === "function") {
      return (input) => existing.sourceControl.discover(input);
    }
    const api = resolveCoderApi();
    if (typeof api.sourceControl?.discover === "function") {
      return (input) => api.sourceControl.discover(input);
    }
  } catch {
    return null;
  }
  return null;
}

function statusLabel(provider: SourceControlProvider): string {
  if (provider.status === "missing") return "Not installed";
  if (provider.status === "outdated") {
    return provider.version
      ? `GitHub CLI ${provider.version} is too old (need 2.81.0+)`
      : "Too old to report sign-in status";
  }
  if (provider.auth.status === "authenticated") {
    return provider.auth.detail
      ? `Signed in as ${provider.auth.detail}`
      : "Authenticated and ready";
  }
  if (provider.auth.status === "unauthenticated") {
    return provider.auth.detail || "Not authenticated";
  }
  return provider.auth.detail || "Could not verify sign-in status";
}

function dotState(provider: SourceControlProvider): "ready" | "warn" | "missing" {
  if (providerReady(provider)) return "ready";
  if (provider.status === "missing") return "missing";
  return "warn";
}

export function SourceControlSection({
  active,
  onDiscover,
}: SourceControlSectionProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<SourceControlDiscovery | null>(
    null,
  );
  const [copiedKind, setCopiedKind] = useState<string | null>(null);

  const runDiscover = useCallback(
    async (rescan = false) => {
      const discover = resolveDiscover(onDiscover);
      if (!discover) {
        setDiscovery(null);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await discover(rescan ? { rescan: true } : undefined);
        setDiscovery(next);
      } catch (err) {
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Could not probe source control",
        );
      } finally {
        setLoading(false);
      }
    },
    [onDiscover],
  );

  useEffect(() => {
    if (!active) return;
    void runDiscover(false);
  }, [active, runDiscover]);

  const copyHint = async (provider: SourceControlProvider) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(provider.installHint);
      setCopiedKind(provider.kind);
      window.setTimeout(() => setCopiedKind(null), 1500);
    } catch {
      // Permission denied; leave the label unchanged.
    }
  };

  const providers = discovery?.sourceControlProviders ?? [];

  return (
    <section className={styles.section} data-source-control="">
      <div className={styles.scHead}>
        <h3 className={styles.sectionLabel}>Source Control</h3>
        <button
          type="button"
          className={styles.btn}
          data-source-control-rescan=""
          disabled={loading}
          onClick={() => void runDiscover(true)}
        >
          {loading ? "Checking…" : "Rescan"}
        </button>
      </div>
      <p className={styles.note}>
        GitHub, GitLab, Bitbucket, and Azure DevOps. Rescan after installing a
        CLI or signing in.
      </p>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      {providers.length === 0 && !loading && !error ? (
        <p className={styles.note}>
          Source control status is unavailable in this mode.
        </p>
      ) : null}
      {providers.map((provider) => {
        const ready = providerReady(provider);
        return (
          <div
            key={provider.kind}
            className={styles.memoryRow}
            data-source-control-kind={provider.kind}
            data-source-control-status={provider.status}
            data-source-control-auth={provider.auth.status}
          >
            <span
              className={styles.memoryDot}
              data-state={dotState(provider)}
              aria-hidden
            />
            <div className={styles.scMeta}>
              <div className={styles.profileName}>{provider.label}</div>
              <p className={styles.note}>{statusLabel(provider)}</p>
              {!ready ? (
                <div className={styles.scHintRow}>
                  <code className={styles.doctorFix} data-source-control-hint="">
                    {provider.installHint}
                  </code>
                  <button
                    type="button"
                    className={styles.btn}
                    data-source-control-copy={provider.kind}
                    onClick={() => void copyHint(provider)}
                  >
                    {copiedKind === provider.kind ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
