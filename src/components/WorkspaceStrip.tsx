import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./WorkspaceStrip.module.css";

/**
 * Tab under the composer (t3-style). On a draft it picks where the first send
 * runs — the project checkout or a fresh worktree from a base branch; the
 * worktree itself is still created lazily on that first send. After that,
 * `started` turns it into a read-only label of where the thread runs.
 */
export interface WorkspaceStripProps {
  /** Thread has pendingWorktree armed. */
  worktree: boolean;
  /** Project checkout path, shown under "Local checkout". */
  projectPath: string | null;
  /** Recorded merge/PR base; null = repo default. */
  baseBranch: string | null;
  listBaseBranches?: () => Promise<{ defaultBranch: string; branches: string[] }>;
  /** Required while editable; unused once `started`. */
  onSetWorktree?: (worktree: boolean) => Promise<unknown>;
  onSetBaseBranch?: (baseBranch: string | null) => Promise<unknown>;
  /**
   * The project's most recent other worktree thread. "Previous worktree"
   * starts a fresh worktree stacked on its branch: committed work carries
   * over, uncommitted edits don't, and merge / PR land back on that branch.
   */
  previous?: { branch: string; title: string } | null;
  /** "Start from origin": fetch the base at creation and start from it. */
  fromOrigin?: boolean;
  onSetFromOrigin?: (fromOrigin: boolean) => Promise<unknown>;
  /** Thread has sent: show where it runs (read-only), with its branch. */
  started?: { branch: string | null } | null;
}

type Open = "workspace" | "base" | null;

export function WorkspaceStrip({
  worktree,
  projectPath,
  baseBranch,
  listBaseBranches,
  onSetWorktree,
  onSetBaseBranch,
  previous = null,
  fromOrigin = false,
  onSetFromOrigin,
  started = null,
}: WorkspaceStripProps) {
  const [open, setOpen] = useState<Open>(null);
  const [branches, setBranches] = useState<{
    defaultBranch: string;
    branches: string[];
  } | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEscapeClose(open != null, () => setOpen(null));

  // Name the repo default ("From main") once, without waiting for a click.
  useEffect(() => {
    if (!worktree || branches || !listBaseBranches || (started && baseBranch)) return;
    let live = true;
    listBaseBranches().then(
      (listed) => live && setBranches(listed),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [worktree, branches, listBaseBranches]);

  const run = async (fn: () => Promise<unknown>) => {
    setOpen(null);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err));
    }
  };

  const baseLabel = baseBranch || branches?.defaultBranch || "repo default";
  const stacked = Boolean(
    worktree && previous && onSetBaseBranch && baseBranch === previous.branch,
  );
  const mode = !worktree ? "local" : stacked ? "previous" : "worktree";
  const q = query.trim().toLowerCase();
  const matches = (branches?.branches ?? []).filter(
    (b) => !q || b.toLowerCase().includes(q),
  );

  if (started) {
    return (
      <div className={`${styles.strip} ${styles.readOnly}`} data-workspace-strip="readonly">
        <span className={styles.label} data-workspace-label={worktree ? "worktree" : "local"}>
          {worktree ? <WorktreeGlyph /> : <FolderGlyph />}
          {worktree ? "worktree" : "local checkout"}
          {started.branch ? ` · ${started.branch}` : ""}
        </span>
        <span className={styles.spacer} />
        {worktree ? <span className={styles.label}>from {baseLabel}</span> : null}
      </div>
    );
  }

  return (
    <div className={styles.strip} ref={rootRef} data-workspace-strip="">
      <div className={styles.anchor}>
        <button
          type="button"
          className={styles.trigger}
          data-workspace-trigger={mode}
          aria-haspopup="menu"
          aria-expanded={open === "workspace"}
          onClick={() => setOpen((o) => (o === "workspace" ? null : "workspace"))}
        >
          {mode === "local" ? (
            <FolderGlyph />
          ) : mode === "previous" ? (
            <HistoryGlyph />
          ) : (
            <WorktreeGlyph />
          )}
          {mode === "local"
            ? "Local checkout"
            : mode === "previous"
              ? "Previous worktree"
              : "New worktree"}
          <Chevron />
        </button>
        {open === "workspace" && (
          <div className={styles.menu} role="menu" aria-label="Workspace">
            <div className={styles.menuLabel}>Workspace</div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!worktree}
              className={styles.item}
              data-workspace-option="local"
              onClick={() => void run(async () => onSetWorktree?.(false))}
            >
              <FolderGlyph />
              <span className={styles.itemText}>
                Local checkout
                <small>{projectPath ? `Edit ${projectPath} directly` : "Edit the project folder directly"}</small>
              </span>
              {!worktree && <Check />}
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode === "worktree"}
              className={styles.item}
              data-workspace-option="worktree"
              onClick={() =>
                void run(async () => {
                  await onSetWorktree?.(true);
                  // Leaving "Previous worktree" drops the stacked base too.
                  if (stacked && onSetBaseBranch) await onSetBaseBranch(null);
                })
              }
            >
              <WorktreeGlyph />
              <span className={styles.itemText}>
                New worktree
                <small>Isolated branch, created when you send</small>
              </span>
              {mode === "worktree" && <Check />}
            </button>
            {previous && onSetBaseBranch ? (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={mode === "previous"}
                className={styles.item}
                data-workspace-option="previous"
                title={`Stack on ${previous.branch}: its committed work carries over and merges land back on it. Uncommitted edits stay in the old worktree.`}
                onClick={() =>
                  void run(async () => {
                    await onSetWorktree?.(true);
                    await onSetBaseBranch(previous.branch);
                  })
                }
              >
                <HistoryGlyph />
                <span className={styles.itemText}>
                  Previous worktree
                  <small className={styles.mono}>{previous.branch}</small>
                </span>
                {mode === "previous" && <Check />}
              </button>
            ) : null}
          </div>
        )}
      </div>

      <span className={styles.spacer} />

      {worktree && onSetBaseBranch ? (
        <div className={styles.anchor}>
          <button
            type="button"
            className={styles.trigger}
            data-workspace-base={baseBranch ?? ""}
            aria-haspopup="dialog"
            aria-expanded={open === "base"}
            title="Branch the worktree starts from (and merges back into)"
            onClick={() => {
              setQuery("");
              setOpen((o) => (o === "base" ? null : "base"));
              if (!branches && listBaseBranches) {
                listBaseBranches().then(setBranches, (err) =>
                  setError(err instanceof Error ? err.message : String(err)),
                );
              }
            }}
          >
            <BranchGlyph />
            From {fromOrigin ? "origin/" : ""}
            {baseLabel}
            <Chevron />
          </button>
          {open === "base" && (
            <div className={`${styles.menu} ${styles.menuRight}`} role="dialog" aria-label="Base branch">
              <input
                className={styles.filter}
                type="search"
                aria-label="Filter base branches"
                placeholder="Filter branches…"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className={styles.branchList}>
                <button
                  type="button"
                  className={styles.item}
                  data-workspace-base-option=""
                  onClick={() => void run(() => onSetBaseBranch(null))}
                >
                  <span className={styles.itemText}>
                    Repo default
                    {branches?.defaultBranch ? <small>{branches.defaultBranch}</small> : null}
                  </span>
                  {!baseBranch && <Check />}
                </button>
                {matches.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={styles.item}
                    data-workspace-base-option={name}
                    onClick={() => void run(() => onSetBaseBranch(name))}
                  >
                    <span className={`${styles.itemText} ${styles.mono}`}>{name}</span>
                    {baseBranch === name && <Check />}
                  </button>
                ))}
                {branches && matches.length === 0 && (
                  <p className={styles.empty} role="status">
                    No matching branches
                  </p>
                )}
              </div>
              {onSetFromOrigin ? (
                <label
                  className={styles.originRow}
                  title="Creates the worktree from the latest matching branch on origin instead of your local branch."
                >
                  <input
                    type="checkbox"
                    role="switch"
                    data-workspace-from-origin=""
                    checked={fromOrigin}
                    onChange={(e) => {
                      const next = e.currentTarget.checked;
                      setError(null);
                      void onSetFromOrigin(next).catch((err) =>
                        setError(err instanceof Error ? err.message : String(err)),
                      );
                    }}
                  />
                  Start from origin
                </label>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {error ? (
        <span className={styles.error} role="alert" data-workspace-error="">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className={styles.glyph}
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function FolderGlyph() {
  return (
    <Svg>
      <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
    </Svg>
  );
}

function WorktreeGlyph() {
  return (
    <Svg>
      <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
      <circle cx="8" cy="8.5" r="1.3" />
    </Svg>
  );
}

function HistoryGlyph() {
  return (
    <Svg>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7" />
      <path d="M2.5 2.75v3h3" />
      <path d="M8 5.25V8l2 1.25" />
    </Svg>
  );
}

function BranchGlyph() {
  return (
    <Svg>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.2-2.8 2.3-4.6 3.4" />
    </Svg>
  );
}

function Chevron() {
  return (
    <svg className={styles.chevron} width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 2.75 4 5.25 6.5 2.75" />
    </svg>
  );
}

function Check() {
  return (
    <svg className={styles.check} width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}
