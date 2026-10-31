import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  DiffOptions,
  DiffResult,
  DiffScope,
  FileChange,
  ImageDiffInput,
  ImageDiffResult,
} from "../../shared/ipc";
import {
  annotateHunkLines,
  commentGutterLabel,
  commentLineRef,
  diffHighlightGroups,
  diffLineKind,
  isEmptyDiff,
  reviewCommentFromAnchors,
  type AnnotatedDiffLine,
  type DiffCommentAnchor,
  type DiffLineKind,
  type ReviewComment,
} from "../../diffView";
import {
  splitLineText,
  splitRowIndices,
  type SplitRowIndex,
} from "../../turnDiff";
import {
  languageForPath,
  useHighlightedLines,
} from "../../syntaxHighlight";
import {
  getDiffScope,
  setDiffIgnoreWhitespace,
  setDiffScope,
  setDiffSplit,
  setDiffWrap,
  useDiffFilesCollapsed,
  useDiffHideTests,
  useDiffIgnoreWhitespace,
  useDiffSplit,
  useDiffTreeView,
  useDiffWrap,
} from "../../uiPrefs";
import {
  FileCollapseHeader,
  TestFilesBar,
  TreeCollapseAllButton,
  TreeListToggle,
  filterTestFiles,
  fileCollapsed,
} from "../TurnDiffPanel";
import {
  allDirPaths,
  buildFileTree,
  type FileTreeDir,
  type FileTreeNode,
} from "../../fileTree";
import { blastRadiusTitle, isCiWorkflowPath } from "../../blastRadius";
import { middleTruncate } from "../../format";
import type { PrSteps } from "../../prProgress";
import { PrStepList } from "../PrStepList";
import {
  buildReviewItinerary,
  hunkPatch,
  orderedPatches,
  parseReviewAnnotation,
  type ReviewFilePatch,
  type ReviewHunk,
  type ReviewItinerary,
  type ReviewSymbol,
} from "../../reviewItinerary";
import {
  ChunkRationale,
  ReviewItineraryView,
} from "../ReviewItinerary";
import { useDiffFind } from "./useDiffFind";
import {
  getChangesPanelSnap,
  setChangesPanelSnap,
} from "./changesPanelMemory";
import { ImageDiff, isImagePath } from "./ImageDiff";
import { showContextMenu, type ContextMenuItem } from "../../contextMenu";
import { isMacPlatform } from "../../keybindings";
import { isWindowsPlatform } from "../../browsePath";
import type { CoderApi } from "../../shared/ipc";
import styles from "../ThreadView.module.css";

/** Desktop-only shell.reveal/openPath, same seam as coderGit() (#1766). */
function coderShell(): CoderApi["shell"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { coder?: CoderApi }).coder?.shell;
}

/** "Reveal in Finder" on macOS, "Show in Explorer" on Windows, else "Show in folder". */
export function revealFileLabel(
  mac: boolean = isMacPlatform(),
  platform: string = typeof navigator !== "undefined" ? navigator.platform || "" : "",
): string {
  if (mac) return "Reveal in Finder";
  if (isWindowsPlatform(platform)) return "Show in Explorer";
  return "Show in folder";
}

/** Parent folder of a repo-relative path; "." (the worktree root) for a top-level file. */
function parentDir(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "." : relPath.slice(0, i);
}

/**
 * Right-click a Changes row: open the file with the user's default editor
 * (shell:openPath, same IPC the worktree-level "Open in Editor" button
 * uses) or reveal it on disk (shell:reveal). Both already resolve a
 * relative path against the thread's worktree and reject anything outside
 * it (ipc-files.js resolveAllowedShellPath) — no new IPC needed. A deleted
 * file has nothing to open, and nothing to reveal but its parent folder.
 */
function openFileContextMenu(
  e: { preventDefault(): void; clientX: number; clientY: number },
  file: FileChange,
  threadId: string | null,
): void {
  e.preventDefault();
  if (!threadId) return;
  const deleted = file.status === "D";
  const items: ContextMenuItem[] = [
    {
      id: "open",
      label: "Open in editor",
      disabled: deleted,
      attrs: { "data-file-open-editor": "" },
    },
    {
      id: "reveal",
      label: revealFileLabel(),
      attrs: { "data-file-reveal": "" },
    },
    {
      id: "copy-path",
      label: "Copy path",
      attrs: { "data-file-copy-path-menu": "" },
    },
  ];
  void showContextMenu(items, { x: e.clientX, y: e.clientY }).then((id) => {
    if (!id) return;
    if (id === "copy-path") {
      void navigator.clipboard?.writeText(file.path).catch(() => {});
      return;
    }
    const shell = coderShell();
    if (!shell) return;
    if (id === "open" && !deleted) {
      void shell.openPath({ threadId, path: file.path });
    } else if (id === "reveal") {
      void shell.reveal({
        threadId,
        path: deleted ? parentDir(file.path) : file.path,
      });
    }
  });
}

const DiffLine = memo(function DiffLine({
  line,
  kind: kindOverride,
  oldLine = null,
  newLine = null,
  side,
  html = null,
  commentable = false,
  commenting = false,
  onCommentClick,
}: {
  line: string;
  kind?: DiffLineKind;
  oldLine?: number | null;
  newLine?: number | null;
  /** Split view cell: show that side's number and drop the +/- prefix. */
  side?: "left" | "right";
  /** Highlighted code (prefix stripped), or null to print `line` as is. */
  html?: string | null;
  commentable?: boolean;
  commenting?: boolean;
  /** `extend`: ⇧-click grows the open comment into a range. */
  onCommentClick?: (extend: boolean) => void;
}) {
  const kind = kindOverride ?? diffLineKind(line);
  const ref = commentLineRef({ kind, oldLine, newLine });
  const n = side === "left" ? oldLine : side === "right" ? newLine : ref?.n;
  const code = splitLineText(line, kind);
  const marker = side || code === line ? "" : line[0];
  return (
    <div
      className={styles.diffLine}
      data-kind={kind}
      data-commenting={commenting ? "" : undefined}
    >
      {commentable && onCommentClick ? (
        <button
          type="button"
          className={styles.diffLineGutter}
          data-diff-comment-gutter=""
          aria-label={commentGutterLabel({ kind, oldLine, newLine })}
          title={commentGutterLabel({ kind, oldLine, newLine })}
          aria-expanded={commenting}
          onClick={(e) => onCommentClick(e.shiftKey)}
        >
          {n ?? "+"}
        </button>
      ) : (
        <span className={styles.diffLineGutter} data-static="" aria-hidden>
          {n ?? ""}
        </span>
      )}
      {html != null ? (
        <span className={styles.diffLineText} data-highlighted="">
          {marker ? <span className={styles.diffMarker}>{marker}</span> : null}
          <span dangerouslySetInnerHTML={{ __html: html || " " }} />
        </span>
      ) : (
        <span className={styles.diffLineText}>{(side ? code : line) || " "}</span>
      )}
    </div>
  );
});

function DiffCommentBox({
  draft,
  onChange,
  onSend,
  onCancel,
}: {
  draft: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  // Escape with a non-empty draft arms a discard confirm first (same two-step
  // pattern as the revert "Sure?" button); a second Escape discards. Typing
  // disarms. Empty drafts still cancel immediately.
  const [discardArmed, setDiscardArmed] = useState(false);
  return (
    <div className={styles.diffComment} data-diff-comment-box="">
      <textarea
        className={styles.diffCommentInput}
        aria-label="Diff comment"
        placeholder="Tell the agent what to change. ⇧-click a line to select a range."
        rows={3}
        autoFocus
        value={draft}
        onChange={(e) => {
          setDiscardArmed(false);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (draft.trim() !== "" && !discardArmed) {
              setDiscardArmed(true);
              return;
            }
            onCancel();
            return;
          }
          if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "Enter") {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {discardArmed ? (
        <div
          className={styles.diffCommentHint}
          role="status"
          data-diff-comment-discard-hint=""
        >
          Press Escape again to discard the comment
        </div>
      ) : null}
      <div className={styles.diffCommentActions}>
        <button type="button" className={styles.btn} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={draft.trim() === ""}
          onClick={onSend}
        >
          Add to prompt
        </button>
      </div>
    </div>
  );
}

/** Same glyph as WorktreeControl's copy-path button (#1772). */
function CopyGlyph() {
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
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  );
}

function FileRow({
  file,
  threadId,
  editable,
  selected,
  staged,
  confirmRevert,
  reverting,
  depth = 0,
  copied = false,
  onSelect,
  onToggleStage,
  onRevert,
  onCopyPath,
}: {
  file: FileChange;
  /** For the row's "Open in editor" / reveal context menu (#1766). */
  threadId: string | null;
  /** Uncommitted scope: stage and discard apply. */
  editable: boolean;
  selected: boolean;
  /** "mixed" = some hunks left out (#191). */
  staged: boolean | "mixed";
  confirmRevert: string | null;
  reverting: string | null;
  /** Tree view indent (#1772); 0 in the flat List view. */
  depth?: number;
  /** This row's path was just copied: flip the button to a checkmark. */
  copied?: boolean;
  onSelect: (path: string) => void;
  onToggleStage: (path: string, next: boolean) => void;
  onRevert: (f: FileChange) => void;
  /** Copy path (#1772); `absolute` is Alt-click, repo path otherwise. */
  onCopyPath?: (file: FileChange, absolute: boolean) => void;
}) {
  return (
    <li style={depth ? { paddingLeft: depth * 14 } : undefined}>
      {editable ? (
      <button
        type="button"
        className={styles.fileStage}
        data-stage-file={file.path}
        role="checkbox"
        aria-checked={staged}
        aria-label={`Stage ${file.path}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStage(file.path, staged !== true);
        }}
      >
        {staged === true ? "✓" : staged ? "–" : ""}
      </button>
      ) : null}
      <button
        type="button"
        className={styles.fileRow}
        data-file-row=""
        data-file-path={file.path}
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(file.path)}
        onContextMenu={(e) => openFileContextMenu(e, file, threadId)}
      >
        <span className={styles.fileStatus}>{file.status}</span>
        <span className={styles.filePath}>{file.path}</span>
        {isCiWorkflowPath(file.path) ? (
          <span
            className={styles.fileBlast}
            data-blast-radius-file=""
            title="CI workflow: privilege-escalation, human sign-off required"
          >
            CI
          </span>
        ) : null}
        <span className={styles.fileStats}>
          <span className={styles.adds}>+{file.additions}</span>
          <span className={styles.dels}>−{file.deletions}</span>
        </span>
      </button>
      {onCopyPath ? (
      <button
        type="button"
        className={styles.fileCopy}
        data-file-copy-path={file.path}
        aria-label={`Copy path ${file.path}`}
        title="Copy path"
        onClick={(e) => {
          e.stopPropagation();
          onCopyPath(file, e.altKey);
        }}
      >
        {copied ? "✓" : <CopyGlyph />}
      </button>
      ) : null}
      {editable ? (
      <button
        type="button"
        className={styles.fileRevert}
        title={
          file.status === "??" || file.status === "A"
            ? confirmRevert === file.path
              ? "Click again to delete this file"
              : "Discard (deletes the file)"
            : "Discard changes"
        }
        aria-label={`Discard changes to ${file.path}`}
        disabled={reverting != null}
        onClick={() => onRevert(file)}
      >
        {reverting === file.path
          ? "…"
          : confirmRevert === file.path
            ? "Sure?"
            : "↩"}
      </button>
      ) : null}
    </li>
  );
}

/** Tree view (#1772) directory row: file count, summed +/-, collapsible. */
function DirRow({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: FileTreeDir<FileChange>;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <li style={depth ? { paddingLeft: depth * 14 } : undefined}>
      <button
        type="button"
        className={styles.dirRow}
        data-dir-row={node.path}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span
          className={styles.dirTwisty}
          data-open={collapsed ? undefined : ""}
          aria-hidden
        >
          ›
        </span>
        <span className={styles.dirName} title={node.path}>
          {node.name}
        </span>
        <span className={styles.fileStats}>
          <span className={styles.dirCount}>{node.fileCount}</span>
          <span className={styles.adds}>+{node.additions}</span>
          <span className={styles.dels}>−{node.deletions}</span>
        </span>
      </button>
    </li>
  );
}

/** Comment plumbing the patch view borrows from ChangesPanel. */
interface CommentWiring {
  enabled: boolean;
  inComment: (group: string, index: number) => boolean;
  boxAt: (group: string, index: number) => ReactNode;
  pick: (
    group: string,
    index: number,
    rows: DiffCommentAnchor[],
    extend: boolean,
  ) => void;
}

type HunkLayout = {
  rows: Array<AnnotatedDiffLine & { path: string }>;
  pairs: SplitRowIndex[];
  /** First row's index into the file's flat highlight list. */
  offset: number;
};

/** Per-hunk stage checkbox and discard (#191); absent = view only. */
interface HunkStaging {
  staged: (hunk: ReviewHunk) => boolean;
  onToggle: (hunk: ReviewHunk) => void;
  onDiscard: ((hunk: ReviewHunk) => void) | null;
  reverting: string | null;
}

/** One file's hunks, unified or side by side, with syntax colour. */
function FilePatch({
  patch,
  split,
  comments,
  onToggleHunk,
  stage,
}: {
  patch: ReviewFilePatch;
  split: boolean;
  comments: CommentWiring;
  onToggleHunk: (hunk: ReviewHunk) => void;
  stage: HunkStaging | null;
}) {
  // Keyed on the text, not the object: "Mark reviewed" rebuilds the
  // itinerary and must not restart highlighting.
  const layout = useMemo((): HunkLayout[] => {
    let offset = 0;
    return patch.hunks.map((hunk) => {
      const rows = annotateHunkLines(hunk.header, hunk.body).map((row) => ({
        ...row,
        path: patch.path,
      }));
      const out = { rows, pairs: splitRowIndices(rows), offset };
      offset += rows.length;
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hunks derive from text
  }, [patch.path, patch.text]);
  const codes = useMemo(
    () => layout.flatMap((h) => h.rows.map((r) => splitLineText(r.text, r.kind))),
    [layout],
  );
  const groups = useMemo(() => diffHighlightGroups(layout), [layout]);
  const html = useHighlightedLines(languageForPath(patch.path), codes, groups);

  const line = (h: HunkLayout, group: string, i: number, side?: "left" | "right") => {
    const row = h.rows[i]!;
    const commentable = comments.enabled && row.commentable;
    return (
      <DiffLine
        line={row.text}
        kind={row.kind}
        oldLine={row.oldLine}
        newLine={row.newLine}
        side={side}
        html={row.text.startsWith("\\") ? null : (html[h.offset + i] ?? null)}
        commentable={commentable}
        commenting={comments.inComment(group, i)}
        onCommentClick={
          commentable
            ? (extend) => comments.pick(group, i, h.rows, extend)
            : undefined
        }
      />
    );
  };

  return patch.hunks.map((hunk, hi) => {
    const h = layout[hi];
    if (!h) return null;
    return (
      <div
        key={hunk.id}
        className={styles.hunkBlock}
        data-review-hunk={hunk.id}
        data-review-hunk-accepted={hunk.accepted ? "" : undefined}
      >
        <div className={styles.hunkBar}>
          {stage ? (
            <button
              type="button"
              className={styles.fileStage}
              data-stage-hunk={hunk.id}
              role="checkbox"
              aria-checked={stage.staged(hunk)}
              aria-label={`Stage hunk ${hunk.header}`}
              onClick={() => stage.onToggle(hunk)}
            >
              {stage.staged(hunk) ? "✓" : ""}
            </button>
          ) : null}
          <span className={styles.hunkPath}>{patch.path}</span>
          {stage?.onDiscard ? (
            <button
              type="button"
              className={styles.fileRevert}
              data-revert-hunk={hunk.id}
              title="Discard this hunk"
              aria-label={`Discard hunk ${hunk.header}`}
              disabled={stage.reverting != null}
              onClick={() => stage.onDiscard?.(hunk)}
            >
              {stage.reverting === hunk.id ? "…" : "↩"}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.hunkSeen}
            aria-pressed={hunk.accepted}
            title={
              hunk.accepted
                ? "Mark this hunk as new again"
                : "Mark this hunk reviewed"
            }
            onClick={() => onToggleHunk(hunk)}
          >
            {hunk.accepted ? "Reviewed" : "Mark reviewed"}
          </button>
        </div>
        <DiffLine line={hunk.header} />
        {split
          ? h.pairs.map((pair, r) => {
              const box =
                (pair.right != null ? comments.boxAt(hunk.id, pair.right) : null) ??
                (pair.left != null && pair.left !== pair.right
                  ? comments.boxAt(hunk.id, pair.left)
                  : null);
              return (
                <Fragment key={`${hunk.id}:s${r}`}>
                  <div className={styles.diffSplitRow} data-diff-split-row="">
                    {pair.left != null ? (
                      line(h, hunk.id, pair.left, "left")
                    ) : (
                      <div className={styles.diffLine} data-kind="empty" aria-hidden />
                    )}
                    {pair.right != null ? (
                      line(h, hunk.id, pair.right, "right")
                    ) : (
                      <div className={styles.diffLine} data-kind="empty" aria-hidden />
                    )}
                  </div>
                  {box}
                </Fragment>
              );
            })
          : h.rows.map((_, i) => (
              <Fragment key={`${hunk.id}:${i}`}>
                {line(h, hunk.id, i)}
                {comments.boxAt(hunk.id, i)}
              </Fragment>
            ))}
      </div>
    );
  });
}

/** A file whose patch is fetched on its own (#1493). */
type FilePatchState = {
  patch: string;
  truncated: boolean;
  loading?: boolean;
  error?: string;
};

/** Placeholder for a file whose patch is not in the list payload. */
function OmittedPatch({
  file,
  state,
  onShow,
}: {
  file: FileChange | null;
  state: FilePatchState | undefined;
  onShow: (path: string) => void;
}) {
  if (state?.loading) {
    return <p className={styles.changesEmpty}>Loading diff…</p>;
  }
  if (state?.error) {
    return (
      <p className={styles.inlineError} role="alert">
        {state.error}
      </p>
    );
  }
  if (file?.patchOmitted === "large" && !state) {
    const lines = file.additions + file.deletions;
    return (
      <div className={styles.changesEmpty} data-diff-large={file.path}>
        <p className={styles.largeDiffNote}>
          Large diff, {lines.toLocaleString()} changed lines. Hidden to keep
          review fast.
        </p>
        <button type="button" className={styles.btn} onClick={() => onShow(file.path)}>
          Show anyway
        </button>
      </div>
    );
  }
  return <p className={styles.changesEmpty}>No textual diff for this file</p>;
}

const SCOPES: Array<{ id: DiffScope; label: string; title: string }> = [
  { id: "uncommitted", label: "Uncommitted", title: "Working tree vs the last commit" },
  { id: "branch", label: "Whole branch", title: "Everything since this branch left its base, committed or not" },
  { id: "turn", label: "This turn", title: "What the agent changed in its last turn" },
];

function emptyCopy(scope: DiffScope, diff: DiffResult | null): string {
  if (scope === "branch") return "No changes on this branch yet";
  if (scope === "turn") {
    return diff?.scopeLabel ? "No changes in the last turn" : "No turn checkpoint yet";
  }
  return "Working tree is clean";
}

export const ChangesPanel = memo(function ChangesPanel({
  open,
  embedded = false,
  threadId,
  threadTitle,
  threadBranch,
  threadBaseBranch,
  threadWorktreePath = null,
  planText,
  openNonce,
  focus = null,
  onFetchDiff,
  onFetchReviewContext,
  onSetReviewAccepted,
  onFetchImageDiff,
  onCommit,
  onStagedPathsChange,
  onRevert,
  onRevertHunk,
  onSuggest,
  onCommitAndPr,
  prSteps,
  onComment,
}: {
  open: boolean;
  /** Hide the "Git" title when the pane chrome already names it. */
  embedded?: boolean;
  threadId: string | null;
  threadTitle: string;
  threadBranch: string | null;
  /** Recorded merge/PR base (#187). Null/absent = repo default. */
  threadBaseBranch?: string | null;
  /** Absolute checkout path, for the copy-path button's Alt-click (#1772). */
  threadWorktreePath?: string | null;
  planText: string;
  openNonce: number;
  /** File an agent pointed at (show_user, #293); a new object re-selects. */
  focus?: { path: string } | null;
  onFetchDiff: (opts?: DiffOptions) => Promise<DiffResult>;
  onFetchReviewContext?: () => Promise<{
    annotation: unknown;
    symbols: ReviewSymbol[];
    acceptedHunks: string[];
  }>;
  onSetReviewAccepted?: (hashes: string[]) => Promise<void>;
  onFetchImageDiff?: (input: ImageDiffInput) => Promise<ImageDiffResult>;
  onCommit: (
    message: string,
    paths?: string[],
    patches?: Array<{ path: string; patch: string }>,
  ) => Promise<{ subject: string }>;
  onStagedPathsChange?: (paths: string[] | null) => void;
  onRevert: (path: string, status: string) => Promise<{ path: string }>;
  /** Discard one hunk; `patch` is the file header plus that hunk. */
  onRevertHunk?: (path: string, patch: string) => Promise<{ path: string }>;
  onSuggest: () => Promise<{ message: string }>;
  /**
   * Push and open (or update) the PR after a commit (#363). Shows the
   * one-click Commit & PR button; absent = no forge PR path here.
   */
  onCommitAndPr?: () => Promise<unknown>;
  /**
   * Committing/Pushing/Creating PR/Linking progress for an in-flight
   * Commit & PR (issue #1803). Shown instead of the plain "Opening PR…"
   * label while present.
   */
  prSteps?: PrSteps | null;
  /**
   * Hand a line or range comment to the composer draft (issue #162, #1493).
   * Comments batch there and go out with the next send, not one run each.
   */
  onComment?: (comment: ReviewComment) => void;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<ReviewSymbol[]>([]);
  const [annotation, setAnnotation] = useState<
    ReturnType<typeof parseReviewAnnotation>
  >(null);
  const [acceptedHunks, setAcceptedHunks] = useState<string[]>([]);
  const [testsFirst, setTestsFirst] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  /** Which footer action is running; null = idle. */
  const [busy, setBusy] = useState<
    "commit" | "generate" | "pr" | null
  >(null);
  const [reverting, setReverting] = useState<string | null>(null);
  /** Untracked-path revert arms a confirm first (it deletes the file). */
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
  /**
   * Open comment: rows `from`..`to` of one hunk (`group`). `pivot` is the
   * first row clicked, so ⇧-click extends either way from it.
   */
  const [commentTarget, setCommentTarget] = useState<{
    group: string;
    pivot: number;
    from: number;
    to: number;
    anchors: DiffCommentAnchor[];
  } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [stagedPaths, setStagedPaths] = useState<Set<string>>(() => new Set());
  /** Hunk ids left out of a staged file (#191); empty = whole files. */
  const [unstagedHunks, setUnstagedHunks] = useState<Set<string>>(
    () => new Set(),
  );
  /** Tree view (#1772) collapse state; kept while the panel stays mounted. */
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(
    () => new Set(),
  );
  /** Files explicitly opened (click header or select) this thread (#1787). */
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(),
  );
  const startFilesCollapsed = useDiffFilesCollapsed();
  const expandFile = (path: string) =>
    setExpandedFiles((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
  const toggleFileCollapse = (path: string) =>
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const selectFile = (path: string) => {
    setSelectedPath(path);
    expandFile(path);
  };
  /** Copy-path feedback (#1772): which path was just copied, if any. */
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    };
  }, []);
  const knownFilesRef = useRef<Set<string>>(new Set());
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  /**
   * Per-thread "where was I" (#1779): file-list and diff-body scroll
   * containers, and render-fresh mirrors of the state the switch effect's
   * cleanup needs. Mirrors (not the state itself) because that cleanup is
   * closed over the OUTGOING thread's render and must read the LATEST
   * selection/collapse, not whatever they were when this effect last fired.
   */
  const fileListRef = useRef<HTMLDivElement | null>(null);
  const diffBodyRef = useRef<HTMLDivElement | null>(null);
  const liveSelectedPathRef = useRef(selectedPath);
  liveSelectedPathRef.current = selectedPath;
  const liveCollapsedDirsRef = useRef(collapsedDirs);
  liveCollapsedDirsRef.current = collapsedDirs;
  /** Saved selection waiting for the new thread's diff to confirm it (one-shot). */
  const restoreWantRef = useRef<string | null>(null);
  /** Saved scroll waiting for the new thread's content to render (one-shot). */
  const pendingScrollRef = useRef<{
    fileListScrollTop: number;
    diffScrollTop: number;
  } | null>(null);
  /** Snapshot `forThreadId`'s current spot (#1779). Scroll reads the DOM
   * directly, so this is accurate at any instant, no separate scroll state. */
  const persistSnap = (forThreadId: string) => {
    setChangesPanelSnap(forThreadId, {
      selectedPath: liveSelectedPathRef.current,
      collapsedDirs: [...liveCollapsedDirsRef.current],
      fileListScrollTop: fileListRef.current?.scrollTop ?? 0,
      diffScrollTop: diffBodyRef.current?.scrollTop ?? 0,
    });
  };
  // Scope lives in uiPrefs per thread; the reducer re-reads it after a pick.
  const [, bumpScope] = useReducer((n: number) => n + 1, 0);
  const scope = getDiffScope(threadId);
  const editable = scope === "uncommitted";
  const split = useDiffSplit();
  const wrap = useDiffWrap();
  const ignoreWhitespace = useDiffIgnoreWhitespace();
  const treeView = useDiffTreeView();
  /** Patches fetched one file at a time: lazy or "Show anyway" (#1493). */
  const [filePatches, setFilePatches] = useState<Record<string, FilePatchState>>({});
  /** Bumped per load so a slow fetch from an old scope cannot land. */
  const loadGenRef = useRef(0);

  const viewOptions = (): DiffOptions | undefined => {
    if (editable && !ignoreWhitespace) return undefined;
    return {
      ...(editable ? {} : { scope }),
      ...(ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    };
  };

  const load = async () => {
    const forThread = threadId;
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    setDiff(null);
    setFilePatches({});
    try {
      const [result, context] = await Promise.all([
        onFetchDiff(viewOptions()),
        onFetchReviewContext
          ? onFetchReviewContext().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (threadIdRef.current !== forThread || loadGenRef.current !== gen) return;
      setDiff(result);
      if (context) {
        setSymbols(Array.isArray(context.symbols) ? context.symbols : []);
        setAnnotation(parseReviewAnnotation(context.annotation));
        setAcceptedHunks(
          Array.isArray(context.acceptedHunks) ? context.acceptedHunks : [],
        );
      }
    } catch (err) {
      if (threadIdRef.current !== forThread || loadGenRef.current !== gen) return;
      setError(
        err instanceof Error && err.message ? err.message : "Failed to load diff",
      );
    } finally {
      if (threadIdRef.current === forThread && loadGenRef.current === gen) {
        setLoading(false);
      }
    }
  };

  const fetchFilePatch = async (path: string, full: boolean) => {
    const gen = loadGenRef.current;
    setFilePatches((prev) => ({
      ...prev,
      [path]: { patch: "", truncated: false, loading: true },
    }));
    try {
      const result = await onFetchDiff({
        ...viewOptions(),
        path,
        ...(full ? { full: true } : {}),
      });
      if (loadGenRef.current !== gen) return;
      setFilePatches((prev) => ({
        ...prev,
        [path]: { patch: result.patch, truncated: result.truncated },
      }));
    } catch (err) {
      if (loadGenRef.current !== gen) return;
      setFilePatches((prev) => ({
        ...prev,
        [path]: {
          patch: "",
          truncated: false,
          error: err instanceof Error && err.message ? err.message : "Failed to load diff",
        },
      }));
    }
  };

  const changeScope = (next: DiffScope) => {
    if (!threadId || next === scope) return;
    setDiffScope(threadId, next);
    // Drop the old scope's diff now so staging never reconciles against it.
    setDiff(null);
    setFilePatches({});
    setCommentTarget(null);
    bumpScope();
  };

  // Never show one thread's diff under another thread. Clear first, then
  // queue the new thread's remembered spot (#1779): restoreWantRef and
  // pendingScrollRef are consumed once that thread's diff and content
  // actually render, below. The cleanup fires on the OUTGOING thread first
  // (React runs all effect cleanups before any new effect body in the same
  // commit), using the live-ref mirrors so it saves the latest selection and
  // collapse even though this effect itself only reruns on a thread change.
  useEffect(() => {
    const saved = threadId ? getChangesPanelSnap(threadId) : null;
    setDiff(null);
    setError(null);
    setMessage("");
    setConfirmRevert(null);
    setSymbols([]);
    setAnnotation(null);
    setAcceptedHunks([]);
    setSelectedPath(null);
    setCommentTarget(null);
    setCommentDraft("");
    setStagedPaths(new Set());
    setUnstagedHunks(new Set());
    setFilePatches({});
    setCollapsedDirs(new Set(saved?.collapsedDirs ?? []));
    setExpandedFiles(new Set());
    setCopiedPath(null);
    knownFilesRef.current = new Set();
    onStagedPathsChange?.(null);
    restoreWantRef.current = saved?.selectedPath ?? null;
    pendingScrollRef.current = saved
      ? {
          fileListScrollTop: saved.fileListScrollTop,
          diffScrollTop: saved.diffScrollTop,
        }
      : null;
    return () => {
      if (threadId) persistSnap(threadId);
    };
    // onStagedPathsChange is a stable setter from useCoder; threadId is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Staging is an Uncommitted-scope idea; a branch or turn diff (cleared on
  // every scope switch) must not reconcile into it.
  useEffect(() => {
    if (!diff || !editable) return;
    setStagedPaths((prev) => {
      const next = new Set<string>();
      const known = knownFilesRef.current;
      const first = known.size === 0;
      for (const f of diff.files) {
        if (first || !known.has(f.path) || prev.has(f.path)) next.add(f.path);
      }
      knownFilesRef.current = new Set(diff.files.map((f) => f.path));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- diff is the trigger
  }, [diff]);

  // Held until a diff that has the file lands: the panel may still be loading.
  const wantPathRef = useRef<string | null>(null);
  useEffect(() => {
    wantPathRef.current = focus ? focus.path : null;
    const want = focus?.path;
    if (want && diff?.files.some((f) => f.path === want)) {
      wantPathRef.current = null;
      setSelectedPath(want);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus is the trigger
  }, [focus]);

  // Display only: staging, find and lazy fetches keep the full diff.files.
  const hideTests = useDiffHideTests();
  const testFilter = useMemo(
    () => filterTestFiles(diff?.files ?? [], hideTests, focus?.path),
    [diff, hideTests, focus],
  );
  const shownPaths = useMemo(
    () => new Set(testFilter.shown.map((f) => f.path)),
    [testFilter],
  );
  /** Summed +/- across the visible files (#1772), same cut as the list below. */
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of testFilter.shown) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { count: testFilter.shown.length, additions, deletions };
  }, [testFilter]);
  /** Tree view (#1772): built from the same visible files as the flat list. */
  const tree = useMemo(() => buildFileTree(testFilter.shown), [testFilter]);
  /** Expand/collapse all (#1796): every directory path in the current tree. */
  const allDirs = useMemo(() => allDirPaths(tree), [tree]);

  useEffect(() => {
    if (!diff || diff.files.length === 0) {
      setSelectedPath(null);
      return;
    }
    const want = wantPathRef.current;
    if (want && diff.files.some((f) => f.path === want)) {
      wantPathRef.current = null;
      setSelectedPath(want);
      return;
    }
    // Remembered selection (#1779) beats the default, but only once: decide
    // now, on the first diff that actually has files, and fall back to the
    // default below if the saved path is stale (file renamed/reverted/gone).
    const restore = restoreWantRef.current;
    restoreWantRef.current = null;
    if (restore && diff.files.some((f) => f.path === restore)) {
      setSelectedPath(restore);
      return;
    }
    if (selectedPath && shownPaths.has(selectedPath)) return;
    setSelectedPath(testFilter.shown[0]?.path ?? null);
  }, [diff, selectedPath, testFilter, shownPaths]);

  // Restore (#1779) the remembered scroll once this thread's content has
  // actually rendered: after the diff lands, a frame later so the file
  // list / diff body have painted at full height.
  useEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending || !diff) return;
    pendingScrollRef.current = null;
    const raf = requestAnimationFrame(() => {
      if (fileListRef.current) fileListRef.current.scrollTop = pending.fileListScrollTop;
      if (diffBodyRef.current) diffBodyRef.current.scrollTop = pending.diffScrollTop;
    });
    return () => cancelAnimationFrame(raf);
  }, [diff]);

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when panel opens / thread / openNonce / view
  }, [open, threadId, openNonce, scope, ignoreWhitespace]);

  const selectedFile = diff?.files.find((f) => f.path === selectedPath) ?? null;
  useEffect(() => {
    if (selectedFile?.patchOmitted !== "lazy" || filePatches[selectedFile.path]) return;
    void fetchFilePatch(selectedFile.path, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per opened file
  }, [selectedFile, filePatches]);

  const itinerary: ReviewItinerary | null = useMemo(() => {
    if (!diff || isEmptyDiff(diff)) return null;
    return buildReviewItinerary({
      files: diff.files,
      patch: [diff.patch, ...Object.values(filePatches).map((f) => f.patch)]
        .filter(Boolean)
        .join("\n"),
      planText,
      threadTitle,
      symbols,
      annotation,
      acceptedHunks,
      testsFirst,
    });
  }, [diff, filePatches, planText, threadTitle, symbols, annotation, acceptedHunks, testsFirst]);

  const patches = useMemo(
    () => (itinerary ? orderedPatches(itinerary) : []),
    [itinerary],
  );
  const visiblePatches = useMemo(
    () =>
      patches.filter((p) =>
        selectedPath ? p.path === selectedPath : shownPaths.has(p.path),
      ),
    [patches, selectedPath, shownPaths],
  );
  const find = useDiffFind(
    diff?.files ?? [],
    patches,
    setSelectedPath,
    threadId,
  );

  // Hunks only apply back to the worktree from the plain Uncommitted diff:
  // -w hunks and branch/turn ranges do not match it, and lazily fetched or
  // truncated patches can stop mid-hunk.
  const hunkable = (path: string) =>
    editable &&
    !ignoreWhitespace &&
    diff != null &&
    !diff.truncated &&
    diff.files.some((f) => f.path === path && !f.patchOmitted);
  /** Staged files with some hunks left out, mapped to their kept-hunk patch. */
  const partialPatches = patches.flatMap((p) => {
    if (!stagedPaths.has(p.path) || !hunkable(p.path)) return [];
    const kept = p.hunks.filter((h) => !unstagedHunks.has(h.id));
    return kept.length < p.hunks.length
      ? [{ path: p.path, patch: hunkPatch(p, kept) }]
      : [];
  });
  const partialKey = partialPatches.map((p) => p.path).join("\0");

  // Merge squashes whole files, so partial files stay out; the merge then
  // refuses on the leftover instead of landing hunks the user unticked.
  useEffect(() => {
    if (!diff || isEmptyDiff(diff) || !editable) return;
    const partial = new Set(partialKey ? partialKey.split("\0") : []);
    onStagedPathsChange?.([...stagedPaths].filter((p) => !partial.has(p)));
  }, [diff, stagedPaths, partialKey, onStagedPathsChange, editable]);

  /** File row staging state, same cut used by both the flat list and the tree. */
  const fileStaged = (path: string): boolean | "mixed" =>
    partialPatches.some((p) => p.path === path) ? "mixed" : stagedPaths.has(path);

  if (!open) return null;

  const empty = !loading && !error && diff != null && isEmptyDiff(diff);
  const imageFile =
    selectedFile && onFetchImageDiff && isImagePath(selectedFile.path) ? selectedFile : null;

  const failMessage = (err: unknown, fallback: string) =>
    err instanceof Error && err.message ? err.message : fallback;

  const revert = async (f: FileChange) => {
    // Untracked and staged-new reverts delete the file; arm a confirm first.
    const destructive = f.status === "??" || f.status === "A";
    if (destructive && confirmRevert !== f.path) {
      setConfirmRevert(f.path);
      return;
    }
    setConfirmRevert(null);
    setReverting(f.path);
    setError(null);
    try {
      await onRevert(f.path, f.status);
      await load();
    } catch (err) {
      setError(failMessage(err, "Failed to discard changes"));
    } finally {
      setReverting(null);
    }
  };

  /** Copy path (#1772): repo-relative, or absolute in the worktree on Alt-click. */
  const copyPath = (file: FileChange, absolute: boolean) => {
    const text =
      absolute && threadWorktreePath
        ? `${threadWorktreePath}/${file.path}`
        : file.path;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopiedPath(file.path);
        if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          setCopiedPath(null);
          copyTimerRef.current = null;
        }, 1400);
      },
      () => {},
    );
  };

  const toggleDir = (path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** Tree view (#1772) rows: same FileRow as the flat list, nested under DirRow. */
  const renderTree = (
    nodes: FileTreeNode<FileChange>[],
    depth: number,
  ): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const node of nodes) {
      if (node.kind === "file") {
        const f = node.file;
        rows.push(
          <FileRow
            key={node.path}
            file={f}
            threadId={threadId}
            editable={editable}
            selected={selectedPath === f.path}
            staged={fileStaged(f.path)}
            confirmRevert={confirmRevert}
            reverting={reverting}
            depth={depth}
            copied={copiedPath === f.path}
            onSelect={selectFile}
            onToggleStage={toggleStage}
            onRevert={(file) => void revert(file)}
            onCopyPath={copyPath}
          />,
        );
        continue;
      }
      const collapsed = collapsedDirs.has(node.path);
      rows.push(
        <DirRow
          key={node.path}
          node={node}
          depth={depth}
          collapsed={collapsed}
          onToggle={() => toggleDir(node.path)}
        />,
      );
      if (!collapsed) rows.push(...renderTree(node.children, depth + 1));
    }
    return rows;
  };

  const toggleHunk = (id: string, next: boolean) => {
    const hashes = next
      ? acceptedHunks.includes(id)
        ? acceptedHunks
        : [...acceptedHunks, id]
      : acceptedHunks.filter((h) => h !== id);
    setAcceptedHunks(hashes);
    void onSetReviewAccepted?.(hashes);
  };

  const suggest = async () => {
    if (busy) return;
    setBusy("generate");
    setError(null);
    try {
      const result = await onSuggest();
      setMessage(result.message);
    } catch (err) {
      setError(failMessage(err, "Failed to generate a message"));
    } finally {
      setBusy(null);
    }
  };

  /** File checkbox: always all-or-nothing, so it clears hunk exclusions. */
  const toggleStage = (path: string, next: boolean) => {
    setStagedPaths((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(path);
      else copy.delete(path);
      return copy;
    });
    const ids = patches.find((p) => p.path === path)?.hunks.map((h) => h.id);
    if (ids?.length) {
      setUnstagedHunks((prev) => {
        const copy = new Set(prev);
        for (const id of ids) copy.delete(id);
        return copy;
      });
    }
  };

  const hunkStaged = (path: string, id: string) =>
    stagedPaths.has(path) && !unstagedHunks.has(id);

  const toggleHunkStage = (p: ReviewFilePatch, id: string) => {
    const ids = p.hunks.map((h) => h.id);
    const excluded = new Set(unstagedHunks);
    const staged = new Set(stagedPaths);
    if (!staged.has(p.path)) {
      // Ticking one hunk of an unstaged file stages just that hunk.
      for (const h of ids) {
        if (h === id) excluded.delete(h);
        else excluded.add(h);
      }
      staged.add(p.path);
    } else if (excluded.has(id)) {
      excluded.delete(id);
    } else {
      excluded.add(id);
      if (ids.every((h) => excluded.has(h))) {
        for (const h of ids) excluded.delete(h);
        staged.delete(p.path);
      }
    }
    setUnstagedHunks(excluded);
    setStagedPaths(staged);
  };

  const revertHunk = async (p: ReviewFilePatch, hunk: ReviewHunk) => {
    if (!onRevertHunk) return;
    setReverting(hunk.id);
    setError(null);
    try {
      await onRevertHunk(p.path, hunkPatch(p, [hunk]));
      await load();
    } catch (err) {
      setError(failMessage(err, "Failed to discard hunk"));
    } finally {
      setReverting(null);
    }
  };

  /**
   * Commit the staged files. With `andPr` (#363): draft the message first
   * when the box is blank, then push and open the PR.
   */
  const doCommit = async (andPr = false) => {
    let msg = message.trim();
    if ((!msg && !andPr) || busy || !diff) return;
    const paths = diff.files.map((f) => f.path).filter((p) => stagedPaths.has(p));
    if (paths.length === 0) return;
    setError(null);
    let committed = false;
    try {
      if (!msg) {
        setBusy("generate");
        msg = (await onSuggest()).message.trim();
        setMessage(msg);
      }
      setBusy("commit");
      await onCommit(
        msg,
        paths,
        partialPatches.length ? partialPatches : undefined,
      );
      committed = true;
      setMessage("");
      await load();
      if (andPr && onCommitAndPr) {
        setBusy("pr");
        await onCommitAndPr();
      }
    } catch (err) {
      setError(
        committed
          ? `Committed, but the PR failed: ${failMessage(err, "unknown error")}`
          : failMessage(err, "Failed to commit"),
      );
    } finally {
      setBusy(null);
    }
  };

  const closeComment = () => {
    setCommentTarget(null);
    setCommentDraft("");
  };

  const pickCommentRow = (
    group: string,
    index: number,
    rows: DiffCommentAnchor[],
    extend: boolean,
  ) => {
    // ponytail: a range stays inside one hunk; across hunks it starts over.
    if (extend && commentTarget?.group === group) {
      const from = Math.min(commentTarget.pivot, index);
      const to = Math.max(commentTarget.pivot, index);
      setCommentTarget({
        ...commentTarget,
        from,
        to,
        anchors: rows.slice(from, to + 1),
      });
      return;
    }
    if (
      commentTarget?.group === group &&
      commentTarget.from === index &&
      commentTarget.to === index
    ) {
      closeComment();
      return;
    }
    setCommentTarget({
      group,
      pivot: index,
      from: index,
      to: index,
      anchors: [rows[index]!],
    });
    setCommentDraft("");
  };

  const addComment = () => {
    if (!commentTarget || !onComment || !commentDraft.trim()) return;
    onComment(
      reviewCommentFromAnchors(
        commentTarget.anchors,
        commentDraft,
        crypto.randomUUID(),
      ),
    );
    closeComment();
  };

  const inComment = (group: string, index: number) =>
    commentTarget?.group === group &&
    index >= commentTarget.from &&
    index <= commentTarget.to;

  const commentBoxAt = (group: string, index: number) =>
    commentTarget?.group === group && commentTarget.to === index && onComment ? (
      <DiffCommentBox
        draft={commentDraft}
        onChange={setCommentDraft}
        onSend={addComment}
        onCancel={closeComment}
      />
    ) : null;

  const commentWiring: CommentWiring = {
    enabled: Boolean(onComment),
    inComment,
    boxAt: commentBoxAt,
    pick: pickCommentRow,
  };

  return (
    <section
      ref={find.rootRef}
      className={styles.changesPane}
      data-git-pane=""
      aria-label="Git"
    >
      {find.bar}
      <header className={styles.changesHead}>
        <div className={styles.changesTitleGroup}>
          {embedded ? null : <span className={styles.changesTitle}>Git</span>}
          {threadBranch ? (
            <span className={styles.changesBranch} title={threadBranch}>
              {middleTruncate(threadBranch, 34, 0.65)}
            </span>
          ) : null}
          {threadBranch ? (
            <span
              className={styles.changesBase}
              data-stacked-base=""
              title={
                threadBaseBranch
                  ? `Merge and PR land on ${threadBaseBranch}`
                  : "Merge and PR land on the repo default"
              }
            >
              → {threadBaseBranch || "repo default"}
            </span>
          ) : null}
        </div>
        <div className={styles.changesActions}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className={styles.diffScopeBar}>
        <div className={styles.diffSeg} role="group" aria-label="Review scope">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={styles.diffSegBtn}
              data-diff-scope={s.id}
              aria-pressed={scope === s.id}
              title={s.title}
              onClick={() => changeScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {diff?.scopeLabel ? (
          <span className={styles.diffScopeLabel} data-diff-scope-label="">
            {diff.scopeLabel}
          </span>
        ) : null}
      </div>

      {error && (
        <div className={styles.inlineError} role="alert">
          {error}
        </div>
      )}

      {loading && !diff && (
        <p className={styles.changesEmpty}>Loading diff…</p>
      )}

      {empty && (
        <>
          {diff?.blastRadius ? (
            <div
              className={styles.committedBlast}
              role="alert"
              data-blast-radius="ci-workflow"
            >
              <strong>Blast radius: CI workflow</strong>
              <span>{blastRadiusTitle(diff.blastRadius)}</span>
            </div>
          ) : null}
          <p className={styles.changesEmpty}>{emptyCopy(scope, diff)}</p>
        </>
      )}

      {diff && !empty && itinerary && (
        <>
          <div className={styles.changesSplit}>
            <div className={styles.changesFiles} ref={fileListRef}>
              {editable ? (
              <div className={styles.stageBar}>
                <button
                  type="button"
                  className={styles.fileStage}
                  data-stage-all=""
                  role="checkbox"
                  aria-label="Stage all files"
                  aria-checked={
                    diff.files.length > 0 &&
                    stagedPaths.size === diff.files.length
                      ? true
                      : stagedPaths.size === 0
                        ? false
                        : "mixed"
                  }
                  onClick={() => {
                    setUnstagedHunks(new Set());
                    if (stagedPaths.size === diff.files.length) {
                      setStagedPaths(new Set());
                    } else {
                      setStagedPaths(new Set(diff.files.map((f) => f.path)));
                    }
                  }}
                >
                  {stagedPaths.size === diff.files.length ? "✓" : ""}
                </button>
                {stagedPaths.size}/{diff.files.length} staged
              </div>
              ) : null}
              <div className={styles.changesSummary} data-changes-summary="">
                <span className={styles.changesSummaryCount}>
                  {totals.count} file{totals.count === 1 ? "" : "s"}
                </span>
                <span className={styles.fileStats}>
                  <span className={styles.adds}>+{totals.additions}</span>
                  <span className={styles.dels}>−{totals.deletions}</span>
                </span>
                <TreeListToggle />
                {treeView ? (
                  <TreeCollapseAllButton
                    allDirs={allDirs}
                    collapsedDirs={collapsedDirs}
                    onSetCollapsed={setCollapsedDirs}
                  />
                ) : null}
              </div>
              <TestFilesBar {...testFilter} />
              <ReviewItineraryView
                itinerary={itinerary}
                testsFirst={testsFirst}
                onToggleTestsFirst={() => setTestsFirst((v) => !v)}
              />
              {treeView ? (
                <ul className={styles.fileList} data-file-tree="">
                  {renderTree(tree, 0)}
                </ul>
              ) : (
                itinerary.chunks.map((chunk) =>
                  chunk.files.some((f) => shownPaths.has(f.path)) ? (
                  <div key={chunk.area}>
                    <ChunkRationale itinerary={itinerary} area={chunk.area} />
                    <ul className={styles.fileList}>
                      {chunk.files.filter((f) => shownPaths.has(f.path)).map((f) => (
                        <FileRow
                          key={f.path}
                          file={f}
                          threadId={threadId}
                          editable={editable}
                          selected={selectedPath === f.path}
                          staged={fileStaged(f.path)}
                          confirmRevert={confirmRevert}
                          reverting={reverting}
                          copied={copiedPath === f.path}
                          onSelect={selectFile}
                          onToggleStage={toggleStage}
                          onRevert={(file) => void revert(file)}
                          onCopyPath={copyPath}
                        />
                      ))}
                    </ul>
                  </div>
                  ) : null,
                )
              )}
            </div>
            <div className={styles.changesDiff} ref={diffBodyRef}>
              {imageFile ? null : (
              <div className={styles.diffToolbar} role="group" aria-label="Diff view">
                <button
                  type="button"
                  className={styles.diffSegBtn}
                  data-diff-toggle="split"
                  aria-pressed={split}
                  onClick={() => setDiffSplit(!split)}
                >
                  Split
                </button>
                <button
                  type="button"
                  className={styles.diffSegBtn}
                  data-diff-toggle="wrap"
                  aria-pressed={wrap}
                  onClick={() => setDiffWrap(!wrap)}
                >
                  Wrap
                </button>
                <button
                  type="button"
                  className={styles.diffSegBtn}
                  data-diff-toggle="whitespace"
                  aria-pressed={ignoreWhitespace}
                  title="Hide whitespace-only changes"
                  onClick={() => setDiffIgnoreWhitespace(!ignoreWhitespace)}
                >
                  Ignore whitespace
                </button>
              </div>
              )}
              {imageFile && onFetchImageDiff ? (
                <ImageDiff
                  threadId={threadId}
                  scope={scope}
                  file={imageFile}
                  reloadKey={diff}
                  onFetch={onFetchImageDiff}
                />
              ) : visiblePatches.length === 0 ? (
                <OmittedPatch
                  file={selectedFile}
                  state={selectedFile ? filePatches[selectedFile.path] : undefined}
                  onShow={(path) => void fetchFilePatch(path, true)}
                />
              ) : (
                <div
                  className={styles.patchScroll}
                  data-wrap={wrap ? "" : undefined}
                  data-split={split ? "" : undefined}
                >
                  {visiblePatches.map((p) => {
                    const collapsed = fileCollapsed(
                      startFilesCollapsed,
                      expandedFiles,
                      p.path,
                    );
                    return (
                    <Fragment key={p.path}>
                      {startFilesCollapsed ? (
                        <FileCollapseHeader
                          path={p.path}
                          collapsed={collapsed}
                          onToggle={() => toggleFileCollapse(p.path)}
                        />
                      ) : null}
                      {!collapsed && p.hunks.length === 0 &&
                        (() => {
                          const rows = p.text.split("\n").map((line) => ({
                            path: p.path,
                            kind: diffLineKind(line),
                            text: line,
                            oldLine: null,
                            newLine: null,
                          }));
                          return rows.map((row, i) => {
                            const key = `${p.path}:${i}`;
                            const commentable =
                              Boolean(onComment) &&
                              (row.kind === "add" || row.kind === "del") &&
                              !row.text.startsWith("\\");
                            return (
                              <Fragment key={key}>
                                <DiffLine
                                  line={row.text}
                                  kind={row.kind}
                                  commentable={commentable}
                                  commenting={inComment(p.path, i)}
                                  onCommentClick={
                                    commentable
                                      ? (extend) =>
                                          pickCommentRow(p.path, i, rows, extend)
                                      : undefined
                                  }
                                />
                                {commentBoxAt(p.path, i)}
                              </Fragment>
                            );
                          });
                        })()}
                      {collapsed ? null : (
                      <FilePatch
                        patch={p}
                        split={split}
                        comments={commentWiring}
                        onToggleHunk={(hunk) => toggleHunk(hunk.id, !hunk.accepted)}
                        stage={
                          hunkable(p.path)
                            ? {
                                staged: (hunk) => hunkStaged(p.path, hunk.id),
                                onToggle: (hunk) => toggleHunkStage(p, hunk.id),
                                onDiscard: onRevertHunk
                                  ? (hunk) => void revertHunk(p, hunk)
                                  : null,
                                reverting,
                              }
                            : null
                        }
                      />
                      )}
                    </Fragment>
                    );
                  })}
                </div>
              )}
              {selectedFile && filePatches[selectedFile.path]?.truncated ? (
                <p className={styles.truncatedNote}>
                  Diff cut at 1 MB. Open the file to see the rest.
                </p>
              ) : diff.truncated ? (
                <p className={styles.truncatedNote}>Diff truncated</p>
              ) : null}
            </div>
          </div>
          {editable ? (
          <div className={styles.commitBox}>
            <textarea
              className={styles.commitInput}
              rows={2}
              placeholder="Commit message"
              aria-label="Commit message"
              value={message}
              disabled={busy != null}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className={styles.commitActions}>
              <button
                type="button"
                className={styles.btn}
                disabled={busy != null}
                onClick={() => void suggest()}
              >
                {busy === "generate" ? "Generating…" : "Generate"}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                data-commit-changes=""
                disabled={
                  message.trim() === "" ||
                  busy != null ||
                  stagedPaths.size === 0
                }
                onClick={() => void doCommit()}
              >
                {busy === "commit" || busy === "pr"
                  ? "Committing…"
                  : stagedPaths.size === 0 ||
                      (stagedPaths.size === (diff?.files.length ?? 0) &&
                        partialPatches.length === 0)
                    ? "Commit"
                    : stagedPaths.size === 1
                      ? "Commit 1 file"
                      : `Commit ${stagedPaths.size} files`}
              </button>
              {onCommitAndPr ? (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  data-commit-and-pr=""
                  title="Commit, push and open a pull request. A blank message is generated first."
                  disabled={busy != null || stagedPaths.size === 0}
                  onClick={() => void doCommit(true)}
                >
                  {busy === "pr" ? "Opening PR…" : "Commit & PR"}
                </button>
              ) : null}
            </div>
            {prSteps ? <PrStepList steps={prSteps} /> : null}
          </div>
          ) : null}
        </>
      )}
    </section>
  );
});
