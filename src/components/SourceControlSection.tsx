import { useCallback, useEffect, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import { providerReady } from "../sourceControl";
import type {
  CoderApi,
  GithubAccount,
  GithubHostSetting,
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
  /** Saved per-host GitHub rows (tokens redacted to hasToken). */
  githubHosts?: GithubHostSetting[];
  /** Persist the full githubHosts list; omit `token` on a row to keep it. */
  onSaveGithubHosts?: (rows: GithubHostSetting[]) => Promise<unknown>;
}

/** Saved rows minus the write-only token, so a re-save keeps saved tokens. */
function keepRows(rows: GithubHostSetting[]): GithubHostSetting[] {
  return rows.map((r) => ({ host: r.host, account: r.account }));
}

/**
 * Per-host GitHub account + saved token (#1528). Hosts come from gh's logins
 * plus any saved row; "Add host" covers GHE with a token and no gh.
 */
function GithubHosts({
  accounts,
  saved,
  onSave,
}: {
  accounts: GithubAccount[];
  saved: GithubHostSetting[];
  onSave: (rows: GithubHostSetting[]) => Promise<unknown>;
}) {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [newHost, setNewHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hosts = [
    ...new Set([...accounts.map((a) => a.host), ...saved.map((r) => r.host)]),
  ];

  const save = async (host: string, change: Partial<GithubHostSetting>) => {
    const rows = keepRows(saved);
    const i = rows.findIndex((r) => r.host === host);
    const base = i >= 0 ? rows[i] : { host, account: null };
    const next = { ...base, ...change };
    if (i >= 0) rows[i] = next;
    else rows.push(next);
    setBusy(true);
    setError(null);
    try {
      await onSave(rows);
      setTokens((t) => ({ ...t, [host]: "" }));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.field} data-github-hosts="">
      {hosts.map((host) => {
        const row = saved.find((r) => r.host === host);
        const logins = accounts.filter((a) => a.host === host);
        const active = logins.find((a) => a.active);
        return (
          <div key={host} className={styles.field} data-github-host={host}>
            <label className={styles.fieldLabel}>{host}</label>
            {logins.length > 0 ? (
              <select
                className={styles.input}
                aria-label={`Account for ${host}`}
                data-github-account={host}
                disabled={busy}
                value={row?.account ?? ""}
                onChange={(e) => void save(host, { account: e.target.value || null })}
              >
                <option value="">
                  {active ? `gh active account (${active.login})` : "gh active account"}
                </option>
                {logins.map((a) => (
                  <option key={a.login} value={a.login}>
                    {a.login}
                  </option>
                ))}
              </select>
            ) : null}
            <div className={styles.fieldRow}>
              <input
                className={styles.input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={`Token for ${host}`}
                data-github-token={host}
                placeholder={row?.hasToken ? "Token saved" : "Token (optional, replaces gh)"}
                value={tokens[host] ?? ""}
                disabled={busy}
                onChange={(e) => setTokens((t) => ({ ...t, [host]: e.target.value }))}
              />
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                data-github-token-save={host}
                disabled={busy || !(tokens[host] ?? "").trim()}
                onClick={() => void save(host, { token: (tokens[host] ?? "").trim() })}
              >
                Save token
              </button>
              {row?.hasToken ? (
                <button
                  type="button"
                  className={styles.btn}
                  data-github-token-clear={host}
                  disabled={busy}
                  onClick={() => void save(host, { token: null })}
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      <div className={styles.fieldRow}>
        <input
          className={styles.input}
          aria-label="GitHub Enterprise host"
          data-github-new-host=""
          placeholder="github.example.com"
          spellCheck={false}
          value={newHost}
          disabled={busy}
          onChange={(e) => setNewHost(e.target.value)}
        />
        <input
          className={styles.input}
          type="password"
          autoComplete="off"
          aria-label="Token for new host"
          data-github-new-token=""
          placeholder="Token"
          value={tokens[""] ?? ""}
          disabled={busy}
          onChange={(e) => setTokens((t) => ({ ...t, "": e.target.value }))}
        />
        <button
          type="button"
          className={styles.btn}
          data-github-add-host=""
          disabled={busy || !newHost.trim() || !(tokens[""] ?? "").trim()}
          onClick={() =>
            void save(newHost.trim().toLowerCase(), { token: (tokens[""] ?? "").trim() }).then(
              () => {
                setNewHost("");
                setTokens((t) => ({ ...t, "": "" }));
              },
            )
          }
        >
          Add host
        </button>
      </div>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      <p className={styles.note}>
        Solenta reads GitHub through its API with gh&apos;s token for the chosen
        account. A saved token is used instead of gh for that host.
      </p>
    </div>
  );
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
  githubHosts,
  onSaveGithubHosts,
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
              {provider.kind === "github" && onSaveGithubHosts ? (
                <GithubHosts
                  accounts={provider.accounts ?? []}
                  saved={githubHosts ?? []}
                  onSave={onSaveGithubHosts}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
