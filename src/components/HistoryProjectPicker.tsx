import { useEffect, useMemo, useState } from "react";
import type { HistoryProject } from "../shared/ipc";
import chrome from "./SettingsModal.module.css";
import styles from "./HistoryProjectPicker.module.css";

const CLI_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  kimi: "Kimi",
  muse: "Muse",
  opencode: "OpenCode",
};

export function usedAgo(at: number, now = Date.now()): string {
  const days = Math.floor(Math.max(0, now - at) / 86_400_000);
  if (days === 0) return "used today";
  if (days === 1) return "used yesterday";
  return `used ${days} days ago`;
}

/**
 * Add project → From CLI history (#1858): every folder the agent CLIs ran
 * in that is not a project yet, newest first, filtered by name or path.
 * Picking a row hands its path to `onPick`.
 */
export function HistoryProjectPicker({
  discover,
  onPick,
  disabled,
  pendingPath,
}: {
  discover: () => Promise<HistoryProject[]>;
  onPick: (row: HistoryProject) => void;
  disabled?: boolean;
  pendingPath?: string | null;
}) {
  const [rows, setRows] = useState<HistoryProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    discover().then(
      (found) => live && setRows(found),
      (err: unknown) => {
        if (!live) return;
        setRows([]);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [discover]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows || !q) return rows ?? [];
    return rows.filter((r) => r.path.toLowerCase().includes(q));
  }, [rows, query]);

  if (rows === null) {
    return (
      <p className={chrome.browseEmpty} data-history-loading="">
        Reading your agent CLIs&apos; history…
      </p>
    );
  }
  if (error) {
    return (
      <p className={chrome.fieldError} role="alert" data-history-error="">
        {error}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className={chrome.browseEmpty} data-history-empty="">
        No new folders in your agent CLIs&apos; history.
      </p>
    );
  }
  const now = Date.now();
  return (
    <div className={chrome.field}>
      <input
        className={chrome.input}
        data-history-search=""
        aria-label="Search folders"
        placeholder={`Search ${rows.length} folders`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
      {shown.length === 0 ? (
        <p className={chrome.browseEmpty} data-history-no-match="">
          No folder matches “{query.trim()}”.
        </p>
      ) : (
        <ul className={`${chrome.browseList} ${styles.list}`}>
          {shown.map((r) => (
            <li key={r.path}>
              <button
                type="button"
                className={`${chrome.browseRow} ${styles.row}`}
                data-history-project={r.path}
                disabled={disabled}
                aria-busy={pendingPath === r.path ? true : undefined}
                title={r.path}
                onClick={() => onPick(r)}
              >
                <span className={styles.top}>
                  <span className={styles.name}>{r.name}</span>
                  <span className={styles.badges}>
                    {r.providers.map((p) => (
                      <span key={p} className={styles.badge} data-history-cli={p}>
                        {CLI_NAMES[p] ?? p}
                      </span>
                    ))}
                  </span>
                </span>
                <span className={styles.path}>{r.path}</span>
                <span className={styles.meta}>
                  {usedAgo(r.lastActiveAt, now)} · {r.sessions}{" "}
                  {r.sessions === 1 ? "session" : "sessions"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
