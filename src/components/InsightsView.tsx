import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeAge } from "../format";
import type { FailureKind, FailureMode } from "../shared/ipc";
import styles from "./InsightsView.module.css";

export interface InsightsViewProps {
  loadFailureModes: () => Promise<FailureMode[]>;
  onSelectThread: (id: string) => void;
}

const KIND_LABEL: Record<FailureKind, string> = {
  failed: "failed",
  stalled: "stalled",
  retried: "retried",
};

/** Sample is long machine text; keep the card scannable until asked. */
const SAMPLE_LIMIT = 140;

export function InsightsView({
  loadFailureModes,
  onSelectThread,
}: InsightsViewProps) {
  const [modes, setModes] = useState<FailureMode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [openSample, setOpenSample] = useState<string | null>(null);
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadFailureModes();
      if (gen !== loadGen.current) return;
      setModes(Array.isArray(next) ? next : []);
      setNow(Date.now());
    } catch (err) {
      if (gen !== loadGen.current) return;
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load failure modes";
      setError(msg);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [loadFailureModes]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadGen.current += 1;
    };
  }, [loadAll]);

  // ponytail: manual refresh only, add a subscription if staleness becomes visible
  const empty = !loading && !error && modes.length === 0;

  return (
    <main className={styles.main} data-insights="">
      <header className={styles.header}>
        <h1 className={styles.title}>Insights</h1>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void loadAll()}
          disabled={loading}
          title="Refresh"
        >
          Refresh
        </button>
      </header>

      {loading && modes.length === 0 && !error ? (
        <p className={styles.hint} aria-live="polite">
          Loading failure modes…
        </p>
      ) : empty ? (
        <div className={styles.empty} data-insights-empty="">
          <p className={styles.emptyTitle}>No recurring failure modes</p>
          <p className={styles.emptyHint}>
            This is the good outcome. One-off errors stay off this list until
            they repeat across threads. A brand-new install looks like this.
          </p>
        </div>
      ) : error && modes.length === 0 ? (
        <div className={styles.empty} data-insights-error="">
          <p className={styles.emptyTitle}>Could not load failure modes</p>
          <p className={styles.emptyHint} role="alert">
            {error}
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {error && (
            <p className={styles.hint} role="alert">
              {error}
            </p>
          )}
          {modes.map((mode) => {
            const long = mode.sample.length > SAMPLE_LIMIT;
            const expanded = openSample === mode.id;
            const sampleText =
              !long || expanded
                ? mode.sample
                : `${mode.sample.slice(0, SAMPLE_LIMIT).trimEnd()}…`;
            return (
              <section
                key={mode.id}
                className={styles.mode}
                data-insights-mode={mode.id}
              >
                <header className={styles.modeHead}>
                  <h2 className={styles.signature}>{mode.signature}</h2>
                  <div className={styles.modeMeta}>
                    <span className={styles.count}>
                      {mode.count} {mode.count === 1 ? "thread" : "threads"}
                    </span>
                    <span className={styles.age}>
                      {formatRelativeAge(mode.lastAt, now)}
                    </span>
                  </div>
                </header>
                <p className={styles.sample} data-insights-sample={mode.id}>
                  {sampleText}
                </p>
                {long && (
                  <button
                    type="button"
                    className={styles.sampleToggle}
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpenSample(expanded ? null : mode.id)
                    }
                  >
                    {expanded ? "Show less" : "Show sample"}
                  </button>
                )}
                <div className={styles.offenders}>
                  {mode.offenders.map((offender) => (
                    <div
                      key={`${offender.threadId}:${offender.at}:${offender.kind}`}
                      className={styles.row}
                      data-insights-offender={offender.threadId}
                    >
                      <button
                        type="button"
                        className={styles.rowSelect}
                        aria-label={`Select thread: ${offender.threadTitle}`}
                        onClick={() => onSelectThread(offender.threadId)}
                      />
                      <div className={styles.rowBody}>
                        <div className={styles.rowTop}>
                          <span className={styles.threadTitle}>
                            {offender.threadTitle}
                          </span>
                          <span className={styles.provider}>
                            {offender.provider}
                          </span>
                        </div>
                        <div className={styles.rowMeta}>
                          <span
                            className={styles.kind}
                            data-kind={offender.kind}
                          >
                            {KIND_LABEL[offender.kind] ?? offender.kind}
                          </span>
                          <span className={styles.age}>
                            {formatRelativeAge(offender.at, now)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
