import { useCallback, useEffect, useRef, useState } from "react";
import { providerDisplayName } from "../format";
import type { ProviderInfo } from "../shared/ipc";
import {
  QUOTA_CLOCK_MS,
  displayWindowLabel,
  formatFetchedAt,
  formatResetAt,
  formatUsedPercent,
  usedBarWidth,
  isQuotaStale,
  isResetExpired,
  sortProviderUsage,
  type ProviderLimitsLoader,
  type ProviderUsage,
} from "../providerUsage";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import styles from "./ProviderQuota.module.css";

export interface ProviderQuotaProps {
  loadLimits?: ProviderLimitsLoader;
  activeProvider?: string | null;
  providers?: readonly ProviderInfo[];
  /** Frozen clock for tests; live UI ticks every QUOTA_CLOCK_MS. */
  now?: number;
  /** Demo review fixture. Not live account data. */
  demo?: boolean;
}

export function ProviderQuota({
  loadLimits,
  activeProvider,
  providers = [],
  now,
  demo = false,
}: ProviderQuotaProps) {
  const [rows, setRows] = useState<ProviderUsage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [clock, setClock] = useState(() => now ?? Date.now());
  const gen = useRef(0);
  const loaderRef = useRef(loadLimits);
  loaderRef.current = loadLimits;

  useEffect(() => {
    if (now != null) {
      setClock(now);
      return;
    }
    setClock(Date.now());
    const id = window.setInterval(() => setClock(Date.now()), QUOTA_CLOCK_MS);
    return () => window.clearInterval(id);
  }, [now]);

  const refresh = useCallback(async () => {
    const loader = loaderRef.current;
    if (!loader) {
      gen.current += 1;
      setUnsupported(true);
      setLoading(false);
      setError(null);
      setRows(null);
      setRefreshFailed(false);
      return;
    }
    const id = ++gen.current;
    setLoading(true);
    setError(null);
    setUnsupported(false);
    try {
      const next = await loader();
      if (id !== gen.current) return;
      setRows(Array.isArray(next) ? next : []);
      setRefreshFailed(false);
    } catch (err) {
      if (id !== gen.current) return;
      setRefreshFailed(true);
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not load quotas",
      );
    } finally {
      if (id === gen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      gen.current += 1;
    };
  }, [refresh]);

  const sorted = rows ? sortProviderUsage(rows, activeProvider) : [];
  const empty =
    !loading && !error && !unsupported && rows !== null && rows.length === 0;
  const showRows = sorted.length > 0;

  let hint: string | null = null;
  let hintStatus: "error" | undefined;
  if (demo) {
    hint = "Demo quotas. Not live account data.";
  }
  if (unsupported) {
    hint = "Provider quotas are not available in this build.";
  } else if (error && !showRows) {
    hint = error;
    hintStatus = "error";
  } else if (loading && !showRows) {
    hint = hint ?? "Loading provider usage…";
  } else if (empty) {
    hint = hint ?? "No quota data from providers.";
  } else if (error) {
    hint = error;
    hintStatus = "error";
  } else if (!hint) {
    hint = "Account limits reported by each CLI.";
  }

  return (
    <div
      className={styles.body}
      data-provider-quota-list=""
      data-demo-quota={demo ? "" : undefined}
      data-stale={refreshFailed ? "" : undefined}
    >
      <div className={styles.toolbar}>
        <p
          className={styles.hint}
          data-status={hintStatus}
          role={hintStatus === "error" ? "alert" : undefined}
          aria-live="polite"
        >
          {hint}
        </p>
        <button
          type="button"
          className={styles.refresh}
          data-provider-quota-refresh=""
          onClick={() => void refresh()}
          disabled={loading}
          aria-busy={loading || undefined}
          title="Refresh"
        >
          Refresh
        </button>
      </div>
      {showRows ? (
        <div className={styles.list}>
          {sorted.map((row) => (
            <QuotaRow
              key={row.provider}
              row={row}
              active={row.provider === activeProvider}
              label={providerDisplayName(row.provider, providers)}
              now={clock}
              refreshFailed={refreshFailed}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuotaRow({
  row,
  active,
  label,
  now,
  refreshFailed,
}: {
  row: ProviderUsage;
  active: boolean;
  label: string;
  now: number;
  refreshFailed: boolean;
}) {
  const stale = refreshFailed || isQuotaStale(row.fetchedAt, now);
  const fetched = formatFetchedAt(row.fetchedAt, now);
  const showUnavailable = row.status !== "ok";
  const fetchedLine = refreshFailed
    ? "Last reported · stale"
    : fetched
      ? `${fetched}${stale ? " · stale" : ""}`
      : null;

  return (
    <section
      className={styles.row}
      data-provider-quota-row={row.provider}
      data-status={row.status}
      data-active={active ? "true" : undefined}
      data-stale={stale ? "" : undefined}
    >
      <div className={styles.rowHead}>
        <span className={styles.name}>{label}</span>
        {active ? <span className={styles.active}>this thread</span> : null}
      </div>
      {showUnavailable ? (
        <p className={styles.statusNote}>
          {row.status === "unavailable" ? "unavailable" : "Could not load"}
          {row.message &&
          row.message.trim() &&
          row.message.trim().toLowerCase() !== "unavailable"
            ? `. ${row.message.trim()}`
            : ""}
        </p>
      ) : (
        <ul className={styles.windows}>
          {row.windows.map((win, i) => {
            const name = displayWindowLabel(win);
            const raw = win.usedPercent;
            const pct =
              Number.isFinite(raw) && raw >= 0 ? raw : null;
            const width = pct == null ? 0 : usedBarWidth(pct);
            const expired = isResetExpired(win.resetsAt, now);
            const reset = formatResetAt(win.resetsAt, now);
            return (
              <li
                key={`${name}-${i}`}
                className={styles.window}
                data-provider-quota-window={name}
                data-reset-expired={expired ? "" : undefined}
              >
                <span className={styles.windowLabel}>{name}</span>
                <div className={styles.track} aria-hidden>
                  <div
                    className={styles.fill}
                    style={{ width: `${width}%` }}
                    data-warn={width >= 80 && width < 95 ? "" : undefined}
                    data-high={width >= 95 ? "" : undefined}
                  />
                </div>
                <span className={styles.pct}>
                  {pct == null ? "unavailable" : formatUsedPercent(pct)}
                  {expired && pct != null ? " last reported" : ""}
                </span>
                {reset ? (
                  <span className={styles.reset}>
                    {expired ? `${reset}; refresh to check` : reset}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {fetchedLine ? (
        <p className={styles.fetched}>{fetchedLine}</p>
      ) : null}
    </section>
  );
}

export interface ProviderQuotaDialogProps extends ProviderQuotaProps {
  open: boolean;
  onClose: () => void;
}

export function ProviderQuotaDialog({
  open,
  onClose,
  ...quota
}: ProviderQuotaDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const handleClose = useCallback(() => onClose(), [onClose]);
  useEscapeClose(open, handleClose);
  useModalFocus(open, dialogRef);
  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-provider-quota=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-quota-title"
        tabIndex={-1}
        data-provider-quota-dialog=""
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 id="provider-quota-title" className={styles.title}>
            Provider usage
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>
        <ProviderQuota {...quota} />
      </div>
    </div>
  );
}

export function ProviderQuotaSection(props: ProviderQuotaProps) {
  return (
    <section className={styles.section} aria-label="Provider quotas">
      <h2 className={styles.sectionTitle}>Account limits</h2>
      <ProviderQuota {...props} />
    </section>
  );
}
