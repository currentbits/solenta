import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  originFromRowKey,
  useViewRestore,
  type ThreadOpenOrigin,
  type ViewReturnState,
} from "../viewReturn";
import {
  digestHeadline,
  formatUsd,
  summarizeDigest,
} from "../digest";
import { formatRelativeAge } from "../format";
import type { DigestResult, DigestRun, ProjectInfo } from "../shared/ipc";
import styles from "./DigestView.module.css";

export interface DigestViewProps {
  projects: ProjectInfo[];
  loadDigest: (input?: { sinceMs?: number }) => Promise<DigestResult>;
  markSeen: () => Promise<{ seenAt: number }>;
  onSelectThread: (id: string, origin?: ThreadOpenOrigin) => void;
  restore?: ViewReturnState | null;
  onRestoreApplied?: () => void;
  /** Live sidebar ids. Omitted means the list is still loading — treat rows as openable. */
  existingThreadIds?: Iterable<string>;
}

function formatDigestWindow(sinceMs: number, now: number): string {
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) return "";
  const d = new Date(sinceMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (sinceMs >= startOfToday.getTime()) return `since ${hh}:${mm}`;
  const yesterday = startOfToday.getTime() - 24 * 60 * 60 * 1000;
  if (sinceMs >= yesterday) return `since ${hh}:${mm} yesterday`;
  return `since ${formatRelativeAge(sinceMs, now)}`;
}

function checkState(checks: DigestRun["checks"]): "passed" | "failed" | "none" {
  if (checks.failed) return "failed";
  if (checks.ran) return "passed";
  return "none";
}

function checkLabel(state: "passed" | "failed" | "none"): string {
  if (state === "failed") return "failed";
  if (state === "passed") return "passed";
  return "no test evidence";
}

function changeStats(run: DigestRun): string {
  const files = run.filesChanged;
  const parts = [
    `+${run.additions} / −${run.deletions} over ${files} file${files === 1 ? "" : "s"}`,
  ];
  if (run.commits > 0) {
    parts.push(`${run.commits} commit${run.commits === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

export function DigestView({
  projects,
  loadDigest,
  markSeen,
  onSelectThread,
  existingThreadIds,
  restore = null,
  onRestoreApplied,
}: DigestViewProps) {
  const [result, setResult] = useState<DigestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [hasLastSuccess, setHasLastSuccess] = useState(false);
  const [marking, setMarking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const loadGen = useRef(0);

  const loadAll = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    setAckError(null);
    try {
      const next = await loadDigest();
      if (gen !== loadGen.current) return;
      setResult(next && typeof next === "object" ? next : null);
      setHasLastSuccess(true);
      setNow(Date.now());
    } catch (err) {
      if (gen !== loadGen.current) return;
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load digest";
      setError(msg);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [loadDigest]);

  useEffect(() => {
    void loadAll();
    return () => {
      loadGen.current += 1;
    };
  }, [loadAll]);

  const onMarkReviewed = useCallback(async () => {
    setMarking(true);
    setAckError(null);
    try {
      await markSeen();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Failed to mark reviewed";
      setAckError(msg);
      return;
    } finally {
      setMarking(false);
    }
    await loadAll();
  }, [markSeen, loadAll]);

  const projectSlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.slug);
    return map;
  }, [projects]);

  const liveThreadIds = useMemo(() => {
    if (existingThreadIds == null) return null;
    return new Set(existingThreadIds);
  }, [existingThreadIds]);

  const summary = useMemo(
    () => summarizeDigest(result?.runs ?? []),
    [result],
  );
  const empty = hasLastSuccess && (result == null || result.runs.length === 0);
  const showLoading = loading && !hasLastSuccess && !error;
  const initialError = Boolean(error && !hasLastSuccess);
  const windowLabel = result ? formatDigestWindow(result.sinceMs, now) : "";
  const canMarkReviewed = hasLastSuccess && !loading && !marking;
  const rootRef = useRef<HTMLElement>(null);
  useViewRestore(hasLastSuccess, restore, rootRef, onRestoreApplied);

  return (
    <main className={styles.main} data-digest="" ref={rootRef}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>Morning digest</h1>
          {hasLastSuccess ? (
            <p
              className={styles.headline}
              data-digest-headline=""
              data-wasted={summary.wastedUsd > 0 ? "true" : undefined}
            >
              {digestHeadline(summary)}
            </p>
          ) : null}
          {windowLabel ? (
            <p className={styles.window} data-digest-window="">
              {windowLabel}
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void loadAll()}
            disabled={loading}
            title="Refresh"
          >
            Refresh
          </button>
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void onMarkReviewed()}
            disabled={!canMarkReviewed}
            title="Mark reviewed"
            data-digest-mark-seen=""
          >
            Mark reviewed
          </button>
        </div>
      </header>

      {showLoading ? (
        <p className={styles.hint} aria-live="polite">
          Loading digest…
        </p>
      ) : initialError ? (
        <div className={styles.empty} data-digest-error="">
          <p className={styles.emptyTitle}>Could not load digest</p>
          <p className={styles.emptyHint} role="alert">
            {error}
          </p>
          <button
            type="button"
            className={styles.retry}
            onClick={() => void loadAll()}
            disabled={loading}
            title="Retry"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {error || ackError ? (
            <div
              className={styles.refreshStatus}
              data-digest-error={error ? "" : undefined}
            >
              {error ? (
                <>
                  <p className={styles.hint} role="alert">
                    {error}
                  </p>
                  <p className={styles.hint} data-digest-stale="" data-stale="">
                    Last successful digest · stale
                  </p>
                  <button
                    type="button"
                    className={styles.retry}
                    onClick={() => void loadAll()}
                    disabled={loading}
                    title="Retry"
                  >
                    Retry
                  </button>
                </>
              ) : null}
              {ackError ? (
                <p className={styles.hint} role="alert" data-digest-ack-error="">
                  {ackError}
                </p>
              ) : null}
            </div>
          ) : null}
          {empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing ran while you were away.</p>
        </div>
          ) : (
        <div className={styles.list} data-return-scroll="">
          {summary.groups.map((group) => (
            <section
              key={group.bucket}
              className={styles.group}
              data-digest-group={group.bucket}
            >
              <h2 className={styles.groupHeader}>
                <span>
                  {group.label}
                  <span className={styles.groupCount}>
                    {" "}
                    {group.entries.length}
                  </span>
                </span>
                <span
                  className={styles.groupCost}
                  data-wasted={
                    group.bucket === "discard" && group.costUsd > 0
                      ? "true"
                      : undefined
                  }
                >
                  {formatUsd(group.costUsd)}
                </span>
              </h2>
              {group.entries.length === 0 ? (
                <p className={styles.groupEmpty}>nothing here</p>
              ) : (
                group.entries.map((entry) => {
                  const { run } = entry;
                  const slug =
                    projectSlug.get(run.projectId) ?? run.projectSlug;
                  const check = checkState(run.checks);
                  const missing =
                    liveThreadIds != null && !liveThreadIds.has(run.threadId);
                  return (
                    <div
                      key={run.threadId}
                      className={styles.row}
                      data-digest-row={run.threadId}
                      data-return-row={run.threadId}
                      data-bucket={group.bucket}
                      data-thread-unavailable={missing ? "" : undefined}
                    >
                      {missing ? null : (
                        <button
                          type="button"
                          className={styles.rowSelect}
                          aria-label={`Select thread: ${run.title}`}
                          onClick={() =>
                            onSelectThread(
                              run.threadId,
                              originFromRowKey(rootRef.current, run.threadId),
                            )
                          }
                        />
                      )}
                      <div className={styles.rowBody}>
                        <div className={styles.rowTop}>
                          <span className={styles.slug}>{slug}</span>
                          <span className={styles.threadTitle}>{run.title}</span>
                          {missing ? (
                            <span className={styles.unavailable}>
                              Transcript unavailable
                            </span>
                          ) : null}
                        </div>
                        <div className={styles.rowMeta}>
                          <span className={styles.reason}>{entry.reason}</span>
                          <span className={styles.cost}>
                            {formatUsd(run.costUsd)} · {run.turns} turn
                            {run.turns === 1 ? "" : "s"}
                          </span>
                          <span className={styles.changes}>
                            {changeStats(run)}
                          </span>
                          <span
                            className={styles.check}
                            data-digest-check={check}
                          >
                            {checkLabel(check)}
                          </span>
                        </div>
                        {entry.risks.length > 0 ? (
                          <div className={styles.risks}>
                            {entry.risks.map((risk) => (
                              <span
                                key={risk}
                                className={styles.risk}
                                data-digest-risk=""
                              >
                                {risk}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          ))}
        </div>
          )}
        </>
      )}
    </main>
  );
}
