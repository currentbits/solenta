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
} from "../../shared/ipc";
import {
  annotateHunkLines,
  commentGutterLabel,
  commentLineRef,
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
  useDiffIgnoreWhitespace,
  useDiffSplit,
  useDiffWrap,
} from "../../uiPrefs";
import { blastRadiusTitle, isCiWorkflowPath } from "../../blastRadius";
import {
  buildReviewItinerary,
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
import styles from "../ThreadView.module.css";

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

function FileRow({
  file,
  editable,
  selected,
  staged,
  confirmRevert,
  reverting,
  onSelect,
  onToggleStage,
  onRevert,
}: {
  file: FileChange;
  /** Uncommitted scope: stage and discard apply. */
  editable: boolean;
  selected: boolean;
  staged: boolean;
  confirmRevert: string | null;
  reverting: string | null;
  onSelect: (path: string) => void;
  onToggleStage: (path: string, next: boolean) => void;
  onRevert: (f: FileChange) => void;
}) {
  return (
    <li>
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
          onToggleStage(file.path, !staged);
        }}
      >
        {staged ? "✓" : ""}
      </button>
      ) : null}
      <button
        type="button"
        className={styles.fileRow}
        data-file-row=""
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(file.path)}
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

/** One file's hunks, unified or side by side, with syntax colour. */
function FilePatch({
  patch,
  split,
  comments,
  onToggleHunk,
}: {
  patch: ReviewFilePatch;
  split: boolean;
  comments: CommentWiring;
  onToggleHunk: (hunk: ReviewHunk) => void;
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
  const html = useHighlightedLines(languageForPath(patch.path), codes);

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
          <span className={styles.hunkPath}>{patch.path}</span>
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

export function ChangesPanel({
  open,
  embedded = false,
  threadId,
  threadTitle,
  threadBranch,
  threadBaseBranch,
  planText,
  openNonce,
  onFetchDiff,
  onFetchReviewContext,
  onSetReviewAccepted,
  onCommit,
  onStagedPathsChange,
  onRevert,
  onSuggest,
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
  planText: string;
  openNonce: number;
  onFetchDiff: (opts?: DiffOptions) => Promise<DiffResult>;
  onFetchReviewContext?: () => Promise<{
    annotation: unknown;
    symbols: ReviewSymbol[];
    acceptedHunks: string[];
  }>;
  onSetReviewAccepted?: (hashes: string[]) => Promise<void>;
  onCommit: (message: string, paths?: string[]) => Promise<{ subject: string }>;
  onStagedPathsChange?: (paths: string[] | null) => void;
  onRevert: (path: string, status: string) => Promise<{ path: string }>;
  onSuggest: () => Promise<{ message: string }>;
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
  const [busy, setBusy] = useState<"commit" | "generate" | null>(null);
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
  const knownFilesRef = useRef<Set<string>>(new Set());
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  // Scope lives in uiPrefs per thread; the reducer re-reads it after a pick.
  const [, bumpScope] = useReducer((n: number) => n + 1, 0);
  const scope = getDiffScope(threadId);
  const editable = scope === "uncommitted";
  const split = useDiffSplit();
  const wrap = useDiffWrap();
  const ignoreWhitespace = useDiffIgnoreWhitespace();
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

  // Never show one thread's diff under another thread.
  useEffect(() => {
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
    setFilePatches({});
    knownFilesRef.current = new Set();
    onStagedPathsChange?.(null);
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

  useEffect(() => {
    if (!diff || isEmptyDiff(diff) || !editable) return;
    onStagedPathsChange?.([...stagedPaths]);
  }, [diff, stagedPaths, onStagedPathsChange, editable]);

  useEffect(() => {
    if (!diff || diff.files.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (selectedPath && diff.files.some((f) => f.path === selectedPath)) return;
    setSelectedPath(diff.files[0]!.path);
  }, [diff, selectedPath]);

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
    () => (selectedPath ? patches.filter((p) => p.path === selectedPath) : patches),
    [patches, selectedPath],
  );

  if (!open) return null;

  const empty = !loading && !error && diff != null && isEmptyDiff(diff);

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

  const toggleStage = (path: string, next: boolean) => {
    setStagedPaths((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(path);
      else copy.delete(path);
      return copy;
    });
  };

  const doCommit = async () => {
    const msg = message.trim();
    if (!msg || busy || !diff) return;
    const paths = diff.files.map((f) => f.path).filter((p) => stagedPaths.has(p));
    if (paths.length === 0) return;
    setBusy("commit");
    setError(null);
    try {
      await onCommit(msg, paths);
      setMessage("");
      await load();
    } catch (err) {
      setError(failMessage(err, "Failed to commit"));
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
      className={styles.changesPane}
      data-git-pane=""
      aria-label="Git"
    >
      <header className={styles.changesHead}>
        <div className={styles.changesTitleGroup}>
          {embedded ? null : <span className={styles.changesTitle}>Git</span>}
          {threadBranch ? (
            <span className={styles.changesBranch} title={threadBranch}>
              {threadBranch}
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
            <div className={styles.changesFiles}>
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
              <ReviewItineraryView
                itinerary={itinerary}
                testsFirst={testsFirst}
                onToggleTestsFirst={() => setTestsFirst((v) => !v)}
              />
              {itinerary.chunks.map((chunk) => (
                <div key={chunk.area}>
                  <ChunkRationale itinerary={itinerary} area={chunk.area} />
                  <ul className={styles.fileList}>
                    {chunk.files.map((f) => (
                      <FileRow
                        key={f.path}
                        file={f}
                        editable={editable}
                        selected={selectedPath === f.path}
                        staged={stagedPaths.has(f.path)}
                        confirmRevert={confirmRevert}
                        reverting={reverting}
                        onSelect={setSelectedPath}
                        onToggleStage={toggleStage}
                        onRevert={(file) => void revert(file)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className={styles.changesDiff}>
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
              {visiblePatches.length === 0 ? (
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
                  {visiblePatches.map((p) => (
                    <Fragment key={p.path}>
                      {p.hunks.length === 0 &&
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
                      <FilePatch
                        patch={p}
                        split={split}
                        comments={commentWiring}
                        onToggleHunk={(hunk) => toggleHunk(hunk.id, !hunk.accepted)}
                      />
                    </Fragment>
                  ))}
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
                {busy === "commit"
                  ? "Committing…"
                  : stagedPaths.size === 0 ||
                      stagedPaths.size === (diff?.files.length ?? 0)
                    ? "Commit"
                    : stagedPaths.size === 1
                      ? "Commit 1 file"
                      : `Commit ${stagedPaths.size} files`}
              </button>
            </div>
          </div>
          ) : null}
        </>
      )}
    </section>
  );
}
