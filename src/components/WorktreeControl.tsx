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
import { mergeOntoLabel, sourceSnapshotLabel } from "../crewIntegration";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./WorktreeControl.module.css";
import type { EditorId, EditorOption } from "../shared/ipc";

const EDITOR_PREF_KEY = "solenta:openInEditor";

type GitAction = "setup" | "merge" | "remove" | null;

export interface WorktreeControlProps {
  thread: ThreadInfo | null;
  project: ProjectInfo | null;
  isWorking: boolean;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: (opts?: {
    ciWorkflowApproved?: boolean;
  }) => Promise<unknown>;
  /** Crew worker: jump to the lead Integration view (#954). */
  onOpenCrewLead?: (leadId: string) => void;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  onStartRun?: (prompt: string, threadId?: string) => void | Promise<void>;
  conflictContext?: (threadId: string) => Promise<ConflictContext>;
  onOpenWorktree?: (() => void) | null;
  /** Installed editors for the "Open in ‹editor› ▾" row (#1411). */
  listEditors?: () => Promise<EditorOption[]>;
  /** Open the worktree with one of `listEditors()`. */
  onOpenWorktreeIn?: (editor: EditorId) => void;
  /** Local branches for the post-create stacked-base picker (#187). */
  listBaseBranches?: () => Promise<{ defaultBranch: string; branches: string[] }>;
  /** Persist a new merge/PR base, or null to clear to the repo default. */
  onSetBaseBranch?: (baseBranch: string | null) => Promise<unknown>;
  /**
   * orchWorker threads: open the lead's Integration section instead of
   * treating this header Merge as crew staging (issue #982).
   */
  onOpenCrewIntegration?: (leadThreadId: string) => void;
  /** Retarget this idle worker onto the lead's current committed HEAD. */
  onRefreshWorkerSnapshot?: () => Promise<unknown>;
}

export interface WorktreeChrome {
  toolbar: ReactNode;
  banner: ReactNode;
  /**
   * Thread details layout (#1411): one row per fact / action instead of the
   * header's pill + Merge split button. Same data attributes, so callers and
   * tests reach the same controls. Null when there is no worktree yet (the
   * setup / pending toolbar is used then).
   */
  rows: {
    workspace: ReactNode;
    versionControl: ReactNode;
    danger: ReactNode;
  } | null;
}

export function classifyGitError(msg: string): {
  kind: "dirty" | "conflict" | "rebase-conflict" | "ci" | "error";
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
  const rebaseConflict = after("WORKTREE_REBASE_CONFLICT:");
  if (rebaseConflict) return { kind: "rebase-conflict", text: rebaseConflict };
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
    onOpenCrewLead,
    onRemoveWorktree,
    onStartRun,
    conflictContext,
    onOpenWorktree,
    listBaseBranches,
    onSetBaseBranch,
    onOpenCrewIntegration,
    onRefreshWorkerSnapshot,
    listEditors,
    onOpenWorktreeIn,
  } = props;
  const [editors, setEditors] = useState<EditorOption[] | null>(null);
  const [editorPref, setEditorPref] = useState<EditorId | null>(() => {
    try {
      return (window.localStorage.getItem(EDITOR_PREF_KEY) as EditorId | null) ?? null;
    } catch {
      return null;
    }
  });
  const [editorMenu, setEditorMenu] = useState(false);
  const worktreeOpenable = Boolean(thread?.worktreePath);
  useEffect(() => {
    if (!worktreeOpenable || !listEditors || editors) return;
    let live = true;
    listEditors().then(
      (rows) => live && setEditors(rows),
      () => live && setEditors([]),
    );
    return () => {
      live = false;
    };
  }, [worktreeOpenable, listEditors, editors]);
  const pickEditor = (id: EditorId) => {
    setEditorPref(id);
    setEditorMenu(false);
    try {
      window.localStorage.setItem(EDITOR_PREF_KEY, id);
    } catch {
      // storage blocked: still open
    }
    onOpenWorktreeIn?.(id);
  };

  const [gitAction, setGitAction] = useState<GitAction>(null);
  const [basePicker, setBasePicker] = useState<{
    defaultBranch: string;
    branches: string[];
  } | null>(null);
  const [baseQuery, setBaseQuery] = useState("");
  const [dirtyMessage, setDirtyMessage] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [conflictKind, setConflictKind] = useState<"merge" | "rebase">("merge");
  const [ciWorkflowMessage, setCiWorkflowMessage] = useState<string | null>(
    null,
  );
  const [cardError, setCardError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pendingMergeRetry, setPendingMergeRetry] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sawWorkingRef = useRef(false);
  const onMergeRef = useRef(onMergeWorktree);
  onMergeRef.current = onMergeWorktree;
  const menuRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasWorktree = Boolean(thread?.worktreePath);
  const busy = isWorking || gitAction != null || resolving || refreshing;
  // Remote and Scratch (#1411, no git) projects have no worktree flow.
  const visible = Boolean(thread && !project?.remoteHost && !project?.scratch);

  useEffect(() => {
    setDirtyMessage(null);
    setConflictMessage(null);
    setConflictKind("merge");
    setCiWorkflowMessage(null);
    setCardError(null);
    setGitAction(null);
    setResolving(false);
    setPendingMergeRetry(false);
    setMenuOpen(false);
    setBasePicker(null);
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
        setBasePicker(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEscapeClose(menuOpen, () => {
    setMenuOpen(false);
    setBasePicker(null);
    menuRef.current?.querySelector<HTMLButtonElement>("[data-worktree-menu]")?.focus();
  });

  const openBasePicker = async () => {
    if (!listBaseBranches) return;
    try {
      const listed = await listBaseBranches();
      setBaseQuery("");
      setBasePicker(listed);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not list branches";
      setCardError(msg);
    }
  };

  const pickBase = async (name: string | null) => {
    if (!onSetBaseBranch || busy) return;
    setMenuOpen(false);
    setBasePicker(null);
    setCardError(null);
    setConflictMessage(null);
    try {
      await onSetBaseBranch(name);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not change base";
      const classified = classifyGitError(msg);
      if (
        classified.kind === "rebase-conflict" ||
        classified.kind === "conflict"
      ) {
        setConflictKind(
          classified.kind === "rebase-conflict" ? "rebase" : "merge",
        );
        setConflictMessage(classified.text);
      } else {
        setCardError(classified.text);
      }
    }
  };

  const baseMatches =
    basePicker?.branches.filter(
      (name) =>
        name !== basePicker.defaultBranch &&
        name.toLowerCase().includes(baseQuery.trim().toLowerCase()),
    ) ?? [];

  const handleRefreshSnapshot = async () => {
    if (!onRefreshWorkerSnapshot || busy) return;
    setRefreshing(true);
    setCardError(null);
    setConflictMessage(null);
    try {
      await onRefreshWorkerSnapshot();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not refresh snapshot";
      const classified = classifyGitError(msg);
      if (classified.kind === "dirty") setDirtyMessage(classified.text);
      else if (
        classified.kind === "rebase-conflict" ||
        classified.kind === "conflict"
      ) {
        setConflictKind(
          classified.kind === "rebase-conflict" ? "rebase" : "merge",
        );
        setConflictMessage(classified.text);
      } else {
        setCardError(classified.text);
      }
    } finally {
      setRefreshing(false);
    }
  };

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
        setConflictKind("merge");
        setConflictMessage(classified.text);
      } else if (classified.kind === "rebase-conflict") {
        setConflictKind("rebase");
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
    return { toolbar: null, banner: null, rows: null };
  }

  const branch = thread.branch ?? null;
  const path = thread.worktreePath ?? null;
  const setupPending = gitAction === "setup";
  const mergePending = gitAction === "merge";
  const removePending = gitAction === "remove" && !dirtyMessage;
  const resolveLabel =
    pendingMergeRetry && isWorking ? "Resolving…" : "Starting…";

  const openLead =
    thread.handoffFrom && (onOpenCrewIntegration || onOpenCrewLead)
      ? () => {
          const id = thread.handoffFrom!;
          if (onOpenCrewIntegration) onOpenCrewIntegration(id);
          else onOpenCrewLead?.(id);
        }
      : null;

  const leadPointer = openLead ? (
      <button
        type="button"
        className={styles.leadLink}
        data-crew-integration-lead=""
        data-crew-lead=""
        onClick={openLead}
      >
        Crew integration on lead
      </button>
    ) : null;

  const startSnapshot = thread.leadSnapshotSha ? (
    <span
      className={styles.snapshot}
      data-start-snapshot=""
      title={`Started from ${thread.leadSnapshotBranch || "lead"} ${thread.leadSnapshotSha}`}
    >
      from {sourceSnapshotLabel(thread.leadSnapshotBranch, thread.leadSnapshotSha)}
    </span>
  ) : null;
  const startDirty = thread.leadSnapshotDirty ? (
    <span className={styles.snapshotDirty} data-start-snapshot-dirty="">
      inherits committed work only
    </span>
  ) : null;
  const refreshSnapshot =
    onRefreshWorkerSnapshot && thread.orchWorker ? (
      <button
        type="button"
        className={styles.leadLink}
        data-refresh-snapshot=""
        disabled={busy}
        title="Retarget this worker onto the lead's current committed HEAD. Uncommitted lead edits are not copied."
        onClick={() => void handleRefreshSnapshot()}
      >
        {refreshing ? "Refreshing…" : "Refresh snapshot"}
      </button>
    ) : null;

  const toolbar = hasWorktree ? (
    <div className={styles.toolbarCluster}>
    <div className={styles.group} data-worktree-control="ready">
      <div className={styles.metaWrap} ref={menuRef}>
        <button
          type="button"
          className={styles.meta}
          data-worktree-menu=""
          aria-haspopup={basePicker ? "dialog" : "menu"}
          aria-expanded={menuOpen}
          aria-label="Worktree actions"
          title={path ?? "Worktree"}
          onClick={() => {
            setMenuOpen((v) => !v);
            setBasePicker(null);
          }}
        >
          <BranchGlyph />
          <span className={styles.branch} title={branch ?? undefined}>
            {branch ?? "worktree"}
          </span>
          <span className={styles.baseSep} aria-hidden>
            →
          </span>
          <span
            className={styles.base}
            data-stacked-base=""
            title={
              thread.baseBranch
                ? `Merge and PR land on ${thread.baseBranch}`
                : "Merge and PR land on the repo default"
            }
          >
            {thread.baseBranch || "repo default"}
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
          <div
            className={styles.menu}
            role={basePicker ? "dialog" : "menu"}
            aria-label={basePicker ? "Change base" : undefined}
          >
            {onOpenWorktree && (
              <button
                type="button"
                className={styles.menuItem}
                role={basePicker ? undefined : "menuitem"}
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
                role={basePicker ? undefined : "menuitem"}
                data-worktree-copy-path=""
                onClick={() => void handleCopyPath()}
              >
                {copiedPath ? "Copied path" : "Copy path"}
              </button>
            )}
            {onSetBaseBranch && !thread.prNumber && (
              <>
                <button
                  type="button"
                  className={styles.menuItem}
                  role={basePicker ? undefined : "menuitem"}
                  data-change-base=""
                  disabled={busy || !listBaseBranches}
                  onClick={() => {
                    void openBasePicker();
                  }}
                >
                  Change base…
                </button>
                {basePicker && (
                  <>
                    <input
                      className={styles.branchFilter}
                      type="search"
                      aria-label="Filter base branches"
                      placeholder="Filter branches…"
                      autoFocus
                      value={baseQuery}
                      onChange={(event) => setBaseQuery(event.target.value)}
                    />
                    <button
                      type="button"
                      className={`${styles.menuItem} ${styles.menuItemNested}`}
                      data-base-branch=""
                      disabled={busy}
                      onClick={() => void pickBase(null)}
                    >
                      Repo default
                    </button>
                    {baseMatches.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className={`${styles.menuItem} ${styles.menuItemNested}`}
                        data-base-branch={name}
                        disabled={busy}
                        onClick={() => void pickBase(name)}
                      >
                        {name}
                      </button>
                    ))}
                    {baseMatches.length === 0 && (
                      <p className={styles.menuItem} role="status">
                        No matching branches
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {openLead ? (
              <button
                type="button"
                className={styles.menuItem}
                role={basePicker ? undefined : "menuitem"}
                onClick={() => {
                  setMenuOpen(false);
                  openLead();
                }}
              >
                Crew integration on lead
              </button>
            ) : null}
            <button
              type="button"
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              role={basePicker ? undefined : "menuitem"}
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
        title={
          thread.handoffFrom
            ? `${mergeOntoLabel(thread.baseBranch)}. Crew staging is on the lead Integration section.`
            : mergeOntoLabel(thread.baseBranch)
        }
        onClick={() => void runAction("merge", () => onMergeWorktree())}
      >
        {mergePending ? (
          <>
            <Spinner />
            Merging…
          </>
        ) : (
          mergeOntoLabel(thread.baseBranch)
        )}
      </button>
    </div>
    {startSnapshot}
    {startDirty}
    {refreshSnapshot}
    {leadPointer}
    </div>
  ) : thread.pendingWorktree ? (
    <div className={styles.toolbarCluster}>
      <span
        className={styles.pendingNote}
        data-worktree-control="pending"
        title="The worktree and its branch are created when the first message is sent"
      >
        <BranchGlyph />
        Worktree on first send
        {thread.baseBranch ? ` · from ${thread.baseBranch}` : ""}
      </span>
      {startSnapshot}
      {startDirty}
      {refreshSnapshot}
    </div>
  ) : (
    <div className={styles.toolbarCluster}>
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
    {startSnapshot}
    {startDirty}
    {refreshSnapshot}
    </div>
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
            {conflictKind === "merge" && onStartRun && (
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
            {conflictKind === "merge" && (
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
            )}
            <button
              type="button"
              className={
                conflictKind === "rebase"
                  ? `${styles.bannerBtn} ${styles.bannerBtnPrimary}`
                  : styles.bannerBtn
              }
              onClick={() => {
                setConflictMessage(null);
                setConflictKind("merge");
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

  const shortPath = path
    ? path.length > 34
      ? `…/${path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}`
      : path
    : "";
  const rows = hasWorktree ? {
    workspace: (
    <div className={styles.rows} data-worktree-control="ready" data-worktree-rows="">
      <div className={styles.row}>
        <span className={styles.rowKey}>Worktree</span>
        <span className={styles.rowMono} title={path ?? undefined}>
          {shortPath}
        </span>
        {path ? (
          <button
            type="button"
            className={styles.rowIcon}
            data-worktree-copy-path=""
            aria-label="Copy worktree path"
            title={copiedPath ? "Copied" : "Copy path"}
            onClick={() => void handleCopyPath()}
          >
            {copiedPath ? "Copied" : <CopyGlyph />}
          </button>
        ) : null}
      </div>
      {onOpenWorktreeIn && editors && editors.length > 0 ? (
        <div className={styles.row}>
          <span className={styles.rowKey}>Open in</span>
          {(() => {
            const current =
              editors.find((e) => e.id === editorPref) ?? editors[0]!;
            return (
              <span className={styles.editorPick}>
                <button
                  type="button"
                  className={styles.rowLink}
                  data-worktree-open=""
                  data-editor={current.id}
                  title={`Open the worktree in ${current.name}`}
                  onClick={() => onOpenWorktreeIn(current.id)}
                >
                  {current.name}
                </button>
                <button
                  type="button"
                  className={styles.rowIcon}
                  data-editor-menu=""
                  aria-haspopup="menu"
                  aria-expanded={editorMenu}
                  aria-label="Choose editor"
                  title="Choose editor"
                  onClick={() => setEditorMenu((v) => !v)}
                >
                  <svg width="10" height="10" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1.5 2.75 4 5.25 6.5 2.75" />
                  </svg>
                </button>
                {editorMenu ? (
                  <span className={styles.editorMenu} role="menu" aria-label="Open in">
                    {editors.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={e.id === current.id}
                        className={`${styles.menuItem} ${styles.menuItemNested}`}
                        data-editor-option={e.id}
                        onClick={() => pickEditor(e.id)}
                      >
                        {e.name}
                      </button>
                    ))}
                  </span>
                ) : null}
              </span>
            );
          })()}
        </div>
      ) : onOpenWorktree ? (
        <div className={styles.row}>
          <span className={styles.rowKey}>Open in</span>
          <button
            type="button"
            className={styles.rowLink}
            data-worktree-open=""
            onClick={() => onOpenWorktree()}
          >
            Editor
          </button>
        </div>
      ) : null}
    </div>
    ),
    versionControl: (
    <div className={styles.rows}>
      <div className={styles.row}>
        <span className={styles.rowKey}>Branch</span>
        <span className={styles.rowMono} title={branch ?? undefined}>
          {branch ?? "worktree"}
        </span>
        <span className={styles.rowFaint}>
          →{" "}
          <span
            data-stacked-base=""
            title={
              thread.baseBranch
                ? `Merge and PR land on ${thread.baseBranch}`
                : "Merge and PR land on the repo default"
            }
          >
            {thread.baseBranch || "repo default"}
          </span>
        </span>
      </div>
      {startSnapshot || startDirty || refreshSnapshot || leadPointer ? (
        <div className={styles.row}>
          <span className={styles.rowKey}>Snapshot</span>
          {startSnapshot}
          {startDirty}
          {refreshSnapshot}
          {leadPointer}
        </div>
      ) : null}
      <div className={styles.rowButtons}>
        <button
          type="button"
          className={styles.rowBtn}
          data-worktree-merge=""
          disabled={busy}
          title={
            thread.handoffFrom
              ? `${mergeOntoLabel(thread.baseBranch)}. Crew staging is on the lead Integration section.`
              : mergeOntoLabel(thread.baseBranch)
          }
          onClick={() => void runAction("merge", () => onMergeWorktree())}
        >
          {mergePending ? (
            <>
              <Spinner />
              Merging…
            </>
          ) : (
            mergeOntoLabel(thread.baseBranch)
          )}
        </button>
        {onSetBaseBranch && !thread.prNumber ? (
          <button
            type="button"
            className={styles.rowBtn}
            data-change-base=""
            aria-expanded={basePicker != null}
            disabled={busy || !listBaseBranches}
            onClick={() =>
              basePicker ? setBasePicker(null) : void openBasePicker()
            }
          >
            Change base
          </button>
        ) : null}
      </div>
      {basePicker ? (
        <div className={styles.rowPicker} role="dialog" aria-label="Change base">
          <input
            className={styles.branchFilter}
            type="search"
            aria-label="Filter base branches"
            placeholder="Filter branches…"
            autoFocus
            value={baseQuery}
            onChange={(event) => setBaseQuery(event.target.value)}
          />
          <button
            type="button"
            className={`${styles.menuItem} ${styles.menuItemNested}`}
            data-base-branch=""
            disabled={busy}
            onClick={() => void pickBase(null)}
          >
            Repo default
          </button>
          {baseMatches.map((name) => (
            <button
              key={name}
              type="button"
              className={`${styles.menuItem} ${styles.menuItemNested}`}
              data-base-branch={name}
              disabled={busy}
              onClick={() => void pickBase(name)}
            >
              {name}
            </button>
          ))}
          {baseMatches.length === 0 && (
            <p className={styles.menuItem} role="status">
              No matching branches
            </p>
          )}
        </div>
      ) : null}
    </div>
    ),
    danger: (
      <button
        type="button"
        className={styles.rowDanger}
        data-worktree-delete=""
        disabled={busy}
        onClick={() => void runAction("remove", () => onRemoveWorktree(false))}
      >
        {removePending ? "Deleting…" : "Delete worktree…"}
      </button>
    ),
  } : null;

  return { toolbar, banner, rows };
}

function CopyGlyph() {
  return (
    <svg
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
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
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
