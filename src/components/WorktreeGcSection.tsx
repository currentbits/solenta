import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveCoderApi } from "../coderApi";
import { formatBytes, formatWorktreeUsage } from "../format";
import type {
  CoderApi,
  GcCandidate,
  GcCleanInput,
  GcCleanResult,
  GcScanResult,
  ProjectInfo,
} from "../shared/ipc";
import styles from "./SettingsModal.module.css";

const EMPTY_SCAN: GcScanResult = {
  candidates: [],
  usage: [],
  totalBytes: 0,
};

export interface WorktreeGcSectionProps {
  /** When true, scan once. Settings remounts this on each open. */
  active: boolean;
  projects?: ProjectInfo[];
  onGcScan?: () => Promise<GcScanResult>;
  onGcClean?: (input: GcCleanInput) => Promise<GcCleanResult>;
}

function dirName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function candidateLabel(c: GcCandidate): string {
  const title = c.title?.trim();
  return title || dirName(c.path);
}

function resolveGcApi(): CoderApi | null {
  try {
    const existing = (window as unknown as { coder?: CoderApi }).coder;
    if (existing) {
      return typeof existing.git?.gcScan === "function" ? existing : null;
    }
    const api = resolveCoderApi();
    return typeof api.git?.gcScan === "function" ? api : null;
  } catch {
    return null;
  }
}

function confirmLabel(count: number, bytes: number): string {
  const noun = count === 1 ? "worktree" : "worktrees";
  return `Delete ${count} ${noun} (${formatBytes(bytes)})`;
}

export function WorktreeGcSection({
  active,
  projects: projectsProp,
  onGcScan,
  onGcClean,
}: WorktreeGcSectionProps) {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<GcScanResult | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cleaning, setCleaning] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [failed, setFailed] = useState<Array<{ path: string; error: string }>>(
    [],
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const api = resolveGcApi();
      const scan = onGcScan ?? (api ? () => api.git.gcScan() : null);
      if (!scan) {
        setResult(EMPTY_SCAN);
        return;
      }
      const next = await scan();
      setResult(next);
      if (projectsProp) {
        setNames(
          Object.fromEntries(projectsProp.map((p) => [p.id, p.name])),
        );
      } else if (api) {
        const list = await api.projects.list();
        setNames(Object.fromEntries(list.map((p) => [p.id, p.name])));
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Scan failed");
      setResult(EMPTY_SCAN);
    } finally {
      setScanning(false);
    }
  }, [onGcScan, projectsProp]);

  useEffect(() => {
    if (!active) return;
    void runScan();
  }, [active, runScan]);

  const candidates = result?.candidates ?? [];
  const usage = result?.usage ?? [];
  const totalBytes = result?.totalBytes ?? 0;
  const unblocked = useMemo(
    () => candidates.filter((c) => !c.blocked),
    [candidates],
  );
  // Unmerged rows stay tickable — the branch survives either way — but
  // reclaiming one is a deliberate per-row click, never part of "select all".
  // Fork / archived worktrees are the exception: background retention takes
  // those anyway (#624), so leaving them unticked here would just mislead.
  const defaultPick = useMemo(
    () => unblocked.filter((c) => !c.unmerged || c.transient),
    [unblocked],
  );
  const reclaimableBytes = useMemo(
    () => defaultPick.reduce((sum, c) => sum + c.bytes, 0),
    [defaultPick],
  );

  const openCleanup = () => {
    setSelected(new Set(defaultPick.map((c) => c.path)));
    setCleanupOpen(true);
    setReport(null);
    setFailed([]);
  };

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allSelected =
    defaultPick.length > 0 && defaultPick.every((c) => selected.has(c.path));

  const toggleAll = () => {
    setSelected(
      allSelected ? new Set() : new Set(defaultPick.map((c) => c.path)),
    );
  };

  const selectedBytes = candidates.reduce(
    (sum, c) => (selected.has(c.path) ? sum + c.bytes : sum),
    0,
  );
  const selectedCount = selected.size;

  const confirm = async () => {
    if (selectedCount === 0 || cleaning) return;
    const paths = [...selected];
    setCleaning(true);
    setError(null);
    try {
      const api = resolveGcApi();
      const clean =
        onGcClean ?? (api ? (input: GcCleanInput) => api.git.gcClean(input) : null);
      if (!clean) {
        setError("Cleanup is unavailable");
        return;
      }
      const out = await clean({ paths });
      const parts: string[] = [];
      if (out.removed.length > 0) {
        const n = out.removed.length;
        const noun = n === 1 ? "worktree" : "worktrees";
        parts.push(`Removed ${n} ${noun} (${formatBytes(out.bytes)}).`);
      } else {
        parts.push("Nothing was removed.");
      }
      setReport(parts.join(" "));
      setFailed(out.failed ?? []);
      setCleanupOpen(false);
      setSelected(new Set());
      await runScan();
    } catch (err) {
      setError(
        err instanceof Error && err.message ? err.message : "Cleanup failed",
      );
    } finally {
      setCleaning(false);
    }
  };

  const empty = !scanning && usage.length === 0;

  return (
    <section className={styles.section} data-worktree-gc="">
      <h3 className={styles.sectionLabel}>Worktrees</h3>
      <p className={styles.note}>
        Disk used by git worktrees. Cleanup removes directories only. Branches
        stay, so no commits are lost.
      </p>
      {scanning && (
        <p className={styles.note} data-gc-scanning="">
          Scanning…
        </p>
      )}
      {empty && (
        <p className={styles.note} data-gc-empty="">
          No worktrees on disk
        </p>
      )}
      {!scanning &&
        usage.map((row) => (
          <div
            key={row.projectId}
            className={styles.memoryRow}
            data-gc-usage-row={row.projectId}
          >
            <div className={styles.profileMeta}>
              <div className={styles.profileName}>
                {names[row.projectId] ?? row.projectId}
              </div>
              <p className={styles.note}>
                {formatWorktreeUsage(row.worktrees, row.bytes)}
              </p>
            </div>
          </div>
        ))}
      {!scanning && totalBytes > 0 && (
        <p className={styles.note} data-gc-total="">
          Total {formatBytes(totalBytes)}
        </p>
      )}
      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      {report && (
        <p className={styles.note} data-gc-report="">
          {report}
        </p>
      )}
      {failed.length > 0 && (
        <ul className={styles.gcFailed} data-gc-failed="">
          {failed.map((f) => (
            <li key={f.path} className={styles.fieldError}>
              {dirName(f.path)}: {f.error}
            </li>
          ))}
        </ul>
      )}
      {!scanning && candidates.length > 0 && !cleanupOpen && (
        <div className={styles.fieldRow}>
          <button
            type="button"
            className={styles.btn}
            data-gc-open=""
            onClick={openCleanup}
          >
            {reclaimableBytes > 0
              ? `Reclaim ${formatBytes(reclaimableBytes)}`
              : "Clean up"}
          </button>
        </div>
      )}
      {cleanupOpen && (
        <div className={styles.gcList} data-gc-dialog="">
          <p className={styles.note}>
            Only directories are removed. Branches are kept, so no commits are
            lost.
          </p>
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={styles.btn}
              data-gc-select-all=""
              disabled={cleaning || defaultPick.length === 0}
              onClick={toggleAll}
            >
              {allSelected ? "Select none" : "Select all"}
            </button>
          </div>
          {candidates.map((c) => {
            const blocked = Boolean(c.blocked);
            return (
              <label
                key={c.path}
                className={styles.gcCandidate}
                data-gc-candidate={c.path}
                data-blocked={blocked ? "true" : undefined}
              >
                <input
                  type="checkbox"
                  disabled={blocked || cleaning}
                  checked={blocked ? false : selected.has(c.path)}
                  onChange={() => {
                    if (!blocked) toggle(c.path);
                  }}
                />
                <span className={styles.gcMeta}>
                  <span className={styles.gcTitle}>{candidateLabel(c)}</span>
                  <p className={styles.note}>
                    {c.reason}
                    {c.branch ? ` · ${c.branch}` : ""}
                    {" · "}
                    {formatBytes(c.bytes)}
                  </p>
                  {c.unmerged ? (
                    <p className={styles.note} data-gc-unmerged={c.path}>
                      {c.unmerged} unmerged{" "}
                      {c.unmerged === 1 ? "commit" : "commits"} · branch kept
                    </p>
                  ) : null}
                  {c.blocked && (
                    <p className={styles.fieldError}>{c.blocked}</p>
                  )}
                </span>
              </label>
            );
          })}
          <div className={styles.fieldRow}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              data-gc-confirm=""
              disabled={cleaning || selectedCount === 0}
              onClick={() => void confirm()}
            >
              {cleaning
                ? "Deleting…"
                : confirmLabel(selectedCount, selectedBytes)}
            </button>
            <button
              type="button"
              className={styles.btn}
              disabled={cleaning}
              onClick={() => setCleanupOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
