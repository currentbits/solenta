import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ConflictContext,
  ProjectInfo,
  ThreadInfo,
} from "../shared/ipc";
import {
  buildConflictResolvePrompt,
  parseConflictFiles,
  type ConflictResolveInput,
} from "../conflictResolve";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./WorktreeControl.module.css";

type GitAction = "setup" | "merge" | "remove" | null;

export interface WorktreeControlProps {
  thread: ThreadInfo | null;
  project: ProjectInfo | null;
  isWorking: boolean;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: (opts?: {
    ciWorkflowApproved?: boolean;
  }) => Promise<unknown>;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  onStartRun?: (prompt: string, threadId?: string) => void | Promise<void>;
  conflictContext?: (threadId: string) => Promise<ConflictContext>;
  onOpenWorktree?: (() => void) | null;
}

export interface WorktreeChrome {
  toolbar: ReactNode;
  banner: ReactNode;
}

function classifyGitError(msg: string): {
  kind: "dirty" | "conflict" | "ci" | "error";
  text: string;
} {
  const after = (marker: string) => {
    const at = msg.indexOf(marker);
    return at === -1 ? null : msg.slice(at + marker.length).trim();
  };
  const dirty = after("WORKTREE_DIRTY:");
  if (dirty) return { kind: "dirty", text: dirty };
  const conflict = after("MERGE_CONFLICT:");
  if (conflict) return { kind: "conflict", text: conflict };
  const ci = after("CI_WORKFLOW:");
  if (ci) return { kind: "ci", text: ci };
  return { kind: "error", text: msg };
}

function BranchGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.2-2.8 2.3-4.6 3.4" />
    </svg>
  );
}

function Spinner() {
  return <span className={styles.spinner} aria-hidden />;
}

function BannerActions({ children }: { children: ReactNode }) {
  return <div className={styles.bannerActions}>{children}</div>;
}

/**
 * Thread-header worktree chrome: compact toolbar control plus a banner
 * for dirty-delete, merge conflict, and CI sign-off. Same action
 * machine as the old Environment WorktreeCard (#680).
 */
export function useWorktreeChrome(
  props: WorktreeControlProps,
): WorktreeChrome {
  const {
    thread,
    project,
    isWorking,
    onSetupWorktree,
    onMergeWorktree,
    onRemoveWorktree,
    onStartRun,
    conflictContext,
    onOpenWorktree,
  } = props;

  const [gitAction, setGitAction] = useState<GitAction>(null);
  const [dirtyMessage, setDirtyMessage] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [ciWorkflowMessage, setCiWorkflowMessage] = useState<string | null>(
    null,
  );
  const [cardError, setCardError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pendingMergeRetry, setPendingMergeRetry] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const sawWorkingRef = useRef(false);
  const onMergeRef = useRef(onMergeWorktree);
  onMergeRef.current = onMergeWorktree;
  const menuRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasWorktree = Boolean(thread?.worktreePath);
  const busy = isWorking || gitAction != null || resolving;
  const visible = Boolean(thread && !project?.remoteHost);

  useEffect(() => {
    setDirtyMessage(null);
    setConflictMessage(null);
    setCiWorkflowMessage(null);
    setCardError(null);
    setGitAction(null);
    setResolving(false);
    setPendingMergeRetry(false);
    setMenuOpen(false);
    setCopiedPath(false);
    sawWorkingRef.current = false;
  }, [thread?.id]);

  useEffect(() => {
    return () => {
      if (copyTimer.current != null) clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEscapeClose(menuOpen, () => setMenuOpen(false));

  const runAction = async (
    action: Exclude<GitAction, null>,
    fn: () => Promise<unknown>,
  ) => {
    setGitAction(action);
    setCardError(null);
    setConflictMessage(null);
    try {
      await fn();
      setDirtyMessage(null);
      setCiWorkflowMessage(null);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Git action failed";
      const classified = classifyGitError(msg);
      if (classified.kind === "dirty") setDirtyMessage(classified.text);
      else if (classified.kind === "conflict") {
        setConflictMessage(classified.text);
      } else if (classified.kind === "ci") {
        setCiWorkflowMessage(classified.text);
      } else {
        setCardError(classified.text);
      }
    } finally {
      setGitAction(null);
    }
  };

  const handleResolve = async () => {
    if (!thread || !onStartRun || busy) return;
    setResolving(true);
    setCardError(null);
    try {
      let input: ConflictResolveInput = {
        files: parseConflictFiles(conflictMessage || "").map((path) => ({
          path,
          content: "",
          truncated: false,
          binary: false,
        })),
        branch: thread.branch,
      };
      if (conflictContext) {
        try {
          const ctx = await conflictContext(thread.id);
          if (ctx.files.length) {
            input = ctx;
          } else {
            input = {
              ...input,
              branch: ctx.branch ?? input.branch,
              baseBranch: ctx.baseBranch,
              omitted: ctx.omitted,
            };
          }
        } catch {
          // Prompt still lists files from the MERGE_CONFLICT body.
        }
      }
      await onStartRun(buildConflictResolvePrompt(input), thread.id);
      setPendingMergeRetry(true);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not start resolve turn";
      setCardError(msg);
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    if (!pendingMergeRetry) {
      sawWorkingRef.current = false;
      return;
    }
    if (thread?.status === "working") {
      sawWorkingRef.current = true;
      return;
    }
    if (!sawWorkingRef.current) return;
    sawWorkingRef.current = false;
    setPendingMergeRetry(false);
    void runAction("merge", () => onMergeRef.current());
  }, [pendingMergeRetry, thread?.status]);

  const handleCopyPath = useCallback(async () => {
    const path = thread?.worktreePath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      return;
    }
    setCopiedPath(true);
    setMenuOpen(false);
    if (copyTimer.current != null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopiedPath(false);
      copyTimer.current = null;
    }, 1400);
  }, [thread?.worktreePath]);

  if (!visible || !thread) {
    return { toolbar: null, banner: null };
  }

  const branch = thread.branch ?? null;
  const path = thread.worktreePath ?? null;
  const setupPending = gitAction === "setup";
  const mergePending = gitAction === "merge";
  const removePending = gitAction === "remove" && !dirtyMessage;
  const resolveLabel =
    pendingMergeRetry && isWorking ? "Resolving…" : "Starting…";

  const toolbar = hasWorktree ? (
    <div className={styles.group} data-worktree-control="ready">
      <div className={styles.metaWrap} ref={menuRef}>
        <button
          type="button"
          className={styles.meta}
          data-worktree-menu=""
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Worktree actions"
          title={path ?? "Worktree"}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <BranchGlyph />
          <span className={styles.branch} title={branch ?? undefined}>
            {branch ?? "worktree"}
          </span>
          <svg
            className={styles.chevron}
            width="8"
            height="8"
            viewBox="0 0 8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M1.5 2.75 4 5.25 6.5 2.75" />
          </svg>
        </button>
        {menuOpen && (
          <div className={styles.menu} role="menu">
            {onOpenWorktree && (
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-worktree-open=""
                onClick={() => {
                  setMenuOpen(false);
                  onOpenWorktree();
                }}
              >
                Open in editor
              </button>
            )}
            {path && (
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                data-worktree-copy-path=""
                onClick={() => void handleCopyPath()}
              >
                {copiedPath ? "Copied path" : "Copy path"}
              </button>
            )}
            <button
              type="button"
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              role="menuitem"
              data-worktree-delete=""
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                void runAction("remove", () => onRemoveWorktree(false));
              }}
            >
              {removePending ? "Deleting…" : "Delete worktree"}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className={styles.merge}
        data-worktree-merge=""
        disabled={busy}
        onClick={() => void runAction("merge", () => onMergeWorktree())}
      >
        {mergePending ? (
          <>
            <Spinner />
            Merging…
          </>
        ) : (
          "Merge worktree"
        )}
      </button>
    </div>
  ) : (
    <button
      type="button"
      className={styles.setup}
      data-worktree-control="setup"
      data-worktree-setup=""
      disabled={busy}
      title="Create a git worktree so runs execute on an isolated branch"
      onClick={() => void runAction("setup", () => onSetupWorktree())}
    >
      {setupPending ? (
        <>
          <Spinner />
          Setting up…
        </>
      ) : (
        <>
          <BranchGlyph />
          Set up worktree
        </>
      )}
    </button>
  );

  const banner = (
    <>
      {dirtyMessage && (
        <div
          className={styles.banner}
          role="alert"
          data-worktree-banner="dirty"
        >
          <pre className={styles.bannerText}>{dirtyMessage}</pre>
          <BannerActions>
            <button
              type="button"
              className={`${styles.bannerBtn} ${styles.bannerBtnDanger}`}
              data-worktree-force-delete=""
              onClick={() =>
                void runAction("remove", () => onRemoveWorktree(true))
              }
              disabled={busy}
            >
              {gitAction === "remove" ? (
                <>
                  <Spinner />
                  Deleting…
                </>
              ) : (
                "Delete anyway"
              )}
            </button>
            <button
              type="button"
              className={styles.bannerBtn}
              onClick={() => setDirtyMessage(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </BannerActions>
        </div>
      )}

      {ciWorkflowMessage && (
        <div
          className={styles.banner}
          role="alert"
          data-ci-signoff=""
          data-worktree-banner="ci"
        >
          <pre className={styles.bannerText}>{ciWorkflowMessage}</pre>
          <BannerActions>
            <button
              type="button"
              className={`${styles.bannerBtn} ${styles.bannerBtnPrimary}`}
              data-ci-signoff-approve=""
              onClick={() =>
                void runAction("merge", () =>
                  onMergeWorktree({ ciWorkflowApproved: true }),
                )
              }
              disabled={busy}
            >
              {mergePending ? (
                <>
                  <Spinner />
                  Merging…
                </>
              ) : (
                "Sign off & merge"
              )}
            </button>
            <button
              type="button"
              className={styles.bannerBtn}
              data-ci-signoff-cancel=""
              onClick={() => setCiWorkflowMessage(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </BannerActions>
        </div>
      )}

      {conflictMessage && (
        <div
          className={styles.banner}
          role="alert"
          data-worktree-banner="conflict"
        >
          <pre className={styles.bannerText}>{conflictMessage}</pre>
          <BannerActions>
            {onStartRun && (
              <button
                type="button"
                className={`${styles.bannerBtn} ${styles.bannerBtnPrimary}`}
                data-conflict-resolve=""
                onClick={() => void handleResolve()}
                disabled={busy}
              >
                {resolving || (pendingMergeRetry && isWorking) ? (
                  <>
                    <Spinner />
                    {resolveLabel}
                  </>
                ) : (
                  "Let the agent resolve"
                )}
              </button>
            )}
            {onOpenWorktree && (
              <button
                type="button"
                className={styles.bannerBtn}
                onClick={onOpenWorktree}
              >
                Open worktree
              </button>
            )}
            <button
              type="button"
              className={
                onStartRun
                  ? styles.bannerBtn
                  : `${styles.bannerBtn} ${styles.bannerBtnPrimary}`
              }
              onClick={() => void runAction("merge", () => onMergeWorktree())}
              disabled={busy}
            >
              {mergePending ? (
                <>
                  <Spinner />
                  Merging…
                </>
              ) : (
                "Merge again"
              )}
            </button>
            <button
              type="button"
              className={styles.bannerBtn}
              onClick={() => {
                setConflictMessage(null);
                setPendingMergeRetry(false);
                sawWorkingRef.current = false;
              }}
            >
              Dismiss
            </button>
          </BannerActions>
        </div>
      )}

      {cardError && (
        <div
          className={`${styles.banner} ${styles.bannerError}`}
          role="alert"
          data-worktree-banner="error"
        >
          <span className={styles.bannerErrorText}>{cardError}</span>
          <button
            type="button"
            className={styles.bannerDismiss}
            onClick={() => setCardError(null)}
            aria-label="Dismiss error"
            title="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </>
  );

  return { toolbar, banner };
}

/** Stacked toolbar + banner for tests that do not mount ThreadView. */
export function WorktreeControl(props: WorktreeControlProps) {
  const { toolbar, banner } = useWorktreeChrome(props);
  return (
    <div data-worktree-chrome="">
      {toolbar}
      {banner}
    </div>
  );
}
