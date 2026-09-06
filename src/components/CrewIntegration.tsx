import { useMemo, useState } from "react";
import type {
  CrewIntegration as CrewIntegrationView,
  CrewIntegrationState,
  CrewIntegrationWorkerRow,
  ThreadInfo,
} from "../shared/ipc";
import { formatVerifySummary } from "../verifyCard";
import styles from "./CrewIntegration.module.css";

function stateLabel(state: CrewIntegrationState): string {
  switch (state) {
    case "running":
      return "Running";
    case "ready":
      return "Ready for review";
    case "conflicted":
      return "Conflicted";
    case "integrated":
      return "Integrated";
    case "landed":
      return "Landed";
    case "missing":
      return "Missing";
  }
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "unknown";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function canIntegrate(row: CrewIntegrationWorkerRow): boolean {
  return row.state === "ready" && !row.blocked;
}

export interface CrewIntegrationProps {
  view: CrewIntegrationView | null;
  thread: ThreadInfo | null;
  onIntegrate: (workerId: string) => Promise<void>;
  onSelectThread?: (id: string) => void;
  onVerify?: () => Promise<void>;
  onFinal?: () => Promise<void>;
  verifying?: boolean;
  finalPending?: boolean;
  busyWorkerId?: string | null;
  error?: string | null;
}

export function CrewIntegration({
  view,
  thread,
  onIntegrate,
  onSelectThread,
  onVerify,
  onFinal,
  verifying = false,
  finalPending = false,
  busyWorkerId = null,
  error = null,
}: CrewIntegrationProps) {
  const workers = view?.workers ?? [];
  const [order, setOrder] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const ordered = useMemo(() => {
    if (workers.length === 0) return [];
    const byId = new Map(workers.map((w) => [w.workerId, w]));
    const seen = new Set<string>();
    const rows: CrewIntegrationWorkerRow[] = [];
    for (const id of order) {
      const row = byId.get(id);
      if (row) {
        rows.push(row);
        seen.add(id);
      }
    }
    for (const row of workers) {
      if (!seen.has(row.workerId)) rows.push(row);
    }
    return rows;
  }, [workers, order]);

  if (!view) {
    if (!error) return null;
    return (
      <section
        className={styles.section}
        aria-label="Integration"
        data-crew-integration=""
      >
        <div className={styles.label}>Integration</div>
        <p className={styles.error} role="alert">
          {error}
        </p>
      </section>
    );
  }

  const snapshot = view;
  const leadBranch = snapshot.leadBranch || "lead worktree";
  const finalTarget = snapshot.finalTarget || "repo default";
  const finalLabel =
    snapshot.finalAction === "pr" ? "Open PR" : `Merge into ${finalTarget}`;

  function move(id: string, dir: -1 | 1) {
    const ids = ordered.map((w) => w.workerId);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = ids.slice();
    const tmp = next[i]!;
    next[i] = next[j]!;
    next[j] = tmp;
    setOrder(next);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function integrateSelected() {
    for (const row of ordered) {
      if (!selected.has(row.workerId)) continue;
      if (!canIntegrate(row) || snapshot.missingLeadWorktree) continue;
      await onIntegrate(row.workerId);
    }
  }

  return (
    <section
      className={styles.section}
      aria-label="Integration"
      data-crew-integration=""
    >
      <div className={styles.label}>Integration</div>
      <p className={styles.header} data-crew-integration-header="">
        Workers → {leadBranch} → {finalTarget}
        <span className={styles.route}>
          {snapshot.finalAction === "pr" ? "Open PR" : `Merge into ${finalTarget}`}
        </span>
      </p>

      {snapshot.missingLeadWorktree ? (
        <p className={styles.empty} data-crew-empty="">
          Set up a lead worktree first
        </p>
      ) : null}

      <ul className={styles.list}>
        {ordered.map((row, index) => {
          const integrateDisabled =
            snapshot.missingLeadWorktree ||
            !canIntegrate(row) ||
            busyWorkerId === row.workerId;
          return (
            <li
              key={row.workerId}
              className={styles.row}
              data-crew-worker={row.workerId}
              data-state={row.state}
              data-blocked={row.blocked ? "true" : "false"}
            >
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={selected.has(row.workerId)}
                  onChange={() => toggle(row.workerId)}
                  aria-label={`Select ${row.title}`}
                />
              </label>
              <div className={styles.order}>
                <button
                  type="button"
                  className={styles.nudge}
                  aria-label={`Move ${row.title} up`}
                  disabled={index === 0}
                  data-move="up"
                  onClick={() => move(row.workerId, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className={styles.nudge}
                  aria-label={`Move ${row.title} down`}
                  disabled={index === ordered.length - 1}
                  data-move="down"
                  onClick={() => move(row.workerId, 1)}
                >
                  Down
                </button>
              </div>
              <div className={styles.body}>
                <div className={styles.titleRow}>
                  <span className={styles.title}>{row.title}</span>
                  <span className={styles.state} data-state={row.state}>
                    {stateLabel(row.state)}
                  </span>
                </div>
                <div className={styles.meta}>
                  <span data-source-sha="">
                    {shortSha(row.sourceSha)}
                  </span>
                  <span data-destination="">into {row.destination}</span>
                  {row.changedFiles.length > 0 ? (
                    <span data-changed-files="">
                      {row.changedFiles.length} file
                      {row.changedFiles.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {row.verify ? (
                    <span data-worker-verify="">
                      {row.verify.ok ? "checks passed" : "checks failed"}
                    </span>
                  ) : null}
                  {row.blocked ? (
                    <span data-blocked-needs="">
                      blocked on {row.needs.join(", ") || "dependencies"}
                    </span>
                  ) : null}
                </div>
                {row.state === "missing" && row.missingReason ? (
                  <p className={styles.missing}>{row.missingReason}</p>
                ) : null}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.btn}
                    data-review=""
                    onClick={() => onSelectThread?.(row.workerId)}
                  >
                    Review diff
                  </button>
                  {row.state === "conflicted" ? (
                    <button
                      type="button"
                      className={styles.btn}
                      data-resolve=""
                      onClick={() => onSelectThread?.(row.workerId)}
                    >
                      Resolve in worker
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.btn}
                      data-integrate=""
                      disabled={integrateDisabled}
                      onClick={() => void onIntegrate(row.workerId)}
                    >
                      {busyWorkerId === row.workerId
                        ? "Integrating…"
                        : `Integrate into ${leadBranch}`}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {ordered.some((w) => selected.has(w.workerId)) ? (
        <button
          type="button"
          className={styles.btn}
          data-integrate-selected=""
          disabled={snapshot.missingLeadWorktree}
          onClick={() => void integrateSelected()}
        >
          Integrate selected
        </button>
      ) : null}

      <div className={styles.combined} data-combined="">
        <div className={styles.combinedLabel}>Combined result</div>
        {snapshot.combinedFiles.length > 0 ? (
          <p className={styles.meta} data-combined-files="">
            {snapshot.combinedFiles.join(", ")}
          </p>
        ) : (
          <p className={styles.meta}>No combined diff yet</p>
        )}
        {snapshot.leadVerify ? (
          <p
            className={styles.meta}
            data-lead-verify=""
            data-stale={snapshot.verifyStale ? "true" : "false"}
          >
            {formatVerifySummary(snapshot.leadVerify)}
            {snapshot.verifyStale ? " · stale" : ""}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btn}
            data-verify-now=""
            disabled={
              verifying || !String(thread?.verifyCommand ?? "").trim()
            }
            onClick={() => void onVerify?.()}
          >
            {verifying ? "Verifying…" : "Verify now"}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            data-final-land=""
            disabled={
              finalPending ||
              snapshot.missingLeadWorktree ||
              snapshot.landed ||
              snapshot.workers.every((w) => w.state !== "integrated")
            }
            onClick={() => void onFinal?.()}
          >
            {finalPending ? "Landing…" : finalLabel}
          </button>
        </div>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
