import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { DiffResult, FileChange } from "../../shared/ipc";
import {
  annotateHunkLines,
  commentGutterLabel,
  commentLineRef,
  diffLineKind,
  formatDiffCommentPrompt,
  isEmptyDiff,
  type DiffCommentAnchor,
  type DiffLineKind,
} from "../../diffView";
import { blastRadiusTitle, isCiWorkflowPath } from "../../blastRadius";
import {
  buildReviewItinerary,
  orderedPatches,
  parseReviewAnnotation,
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
  commentable = false,
  commenting = false,
  onCommentClick,
}: {
  line: string;
  kind?: DiffLineKind;
  oldLine?: number | null;
  newLine?: number | null;
  commentable?: boolean;
  commenting?: boolean;
  onCommentClick?: () => void;
}) {
  const kind = kindOverride ?? diffLineKind(line);
  const ref = commentLineRef({ kind, oldLine, newLine });
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
          onClick={onCommentClick}
        >
          {ref ? ref.n : "+"}
        </button>
      ) : (
        <span className={styles.diffLineGutter} data-static="" aria-hidden>
          {ref ? ref.n : ""}
        </span>
      )}
      <span className={styles.diffLineText}>{line || " "}</span>
    </div>
  );
});

function DiffCommentBox({
  draft,
  busy,
  error,
  submitLabel,
  onChange,
  onSend,
  onCancel,
}: {
  draft: string;
  busy: boolean;
  error: string | null;
  submitLabel: string;
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
        placeholder="Tell the agent what to change"
        rows={3}
        autoFocus
        value={draft}
        disabled={busy}
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
      {error ? (
        <div className={styles.inlineError} role="alert">
          {error}
        </div>
      ) : null}
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
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={busy || draft.trim() === ""}
          onClick={onSend}
        >
          {busy ? "Sending…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function FileRow({
  file,
  selected,
  staged,
  confirmRevert,
  reverting,
  onSelect,
  onToggleStage,
  onRevert,
}: {
  file: FileChange;
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
            title="CI workflow — privilege-escalation, human sign-off required"
          >
            CI
          </span>
        ) : null}
        <span className={styles.fileStats}>
          <span className={styles.adds}>+{file.additions}</span>
          <span className={styles.dels}>−{file.deletions}</span>
        </span>
      </button>
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
    </li>
  );
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
  isWorking = false,
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
  isWorking?: boolean;
  onFetchDiff: () => Promise<DiffResult>;
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
  /** Send a line comment as a follow-up prompt (issue #162). */
  onComment?: (prompt: string) => void | Promise<void>;
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
  const [commentTarget, setCommentTarget] = useState<{
    key: string;
    anchor: DiffCommentAnchor;
  } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [stagedPaths, setStagedPaths] = useState<Set<string>>(() => new Set());
  const knownFilesRef = useRef<Set<string>>(new Set());
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const load = async () => {
    const forThread = threadId;
    setLoading(true);
    setError(null);
    setDiff(null);
    try {
      const [result, context] = await Promise.all([
        onFetchDiff(),
        onFetchReviewContext
          ? onFetchReviewContext().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (threadIdRef.current !== forThread) return;
      setDiff(result);
      if (context) {
        setSymbols(Array.isArray(context.symbols) ? context.symbols : []);
        setAnnotation(parseReviewAnnotation(context.annotation));
        setAcceptedHunks(
          Array.isArray(context.acceptedHunks) ? context.acceptedHunks : [],
        );
      }
    } catch (err) {
      if (threadIdRef.current !== forThread) return;
      setError(
        err instanceof Error && err.message ? err.message : "Failed to load diff",
      );
    } finally {
      if (threadIdRef.current === forThread) setLoading(false);
    }
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
    setCommentBusy(false);
    setCommentError(null);
    setStagedPaths(new Set());
    knownFilesRef.current = new Set();
    onStagedPathsChange?.(null);
    // onStagedPathsChange is a stable setter from useCoder; threadId is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    if (!diff) return;
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
  }, [diff]);

  useEffect(() => {
    if (!diff || isEmptyDiff(diff)) return;
    onStagedPathsChange?.([...stagedPaths]);
  }, [diff, stagedPaths, onStagedPathsChange]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when panel opens / thread / openNonce
  }, [open, threadId, openNonce]);

  const itinerary: ReviewItinerary | null = useMemo(() => {
    if (!diff || isEmptyDiff(diff)) return null;
    return buildReviewItinerary({
      files: diff.files,
      patch: diff.patch,
      planText,
      threadTitle,
      symbols,
      annotation,
      acceptedHunks,
      testsFirst,
    });
  }, [diff, planText, threadTitle, symbols, annotation, acceptedHunks, testsFirst]);

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

  const patches = itinerary ? orderedPatches(itinerary) : [];
  const visiblePatches = selectedPath
    ? patches.filter((p) => p.path === selectedPath)
    : patches;

  const toggleComment = (key: string, anchor: DiffCommentAnchor) => {
    if (commentBusy) return;
    if (commentTarget?.key === key) {
      setCommentTarget(null);
      setCommentDraft("");
      setCommentError(null);
      return;
    }
    setCommentTarget({ key, anchor });
    setCommentDraft("");
    setCommentError(null);
  };

  const sendComment = async () => {
    if (!commentTarget || !onComment || commentBusy) return;
    const prompt = formatDiffCommentPrompt(commentTarget.anchor, commentDraft);
    if (!prompt) return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      await onComment(prompt);
      setCommentTarget(null);
      setCommentDraft("");
    } catch (err) {
      setCommentError(
        err instanceof Error && err.message ? err.message : "Failed to send comment",
      );
    } finally {
      setCommentBusy(false);
    }
  };

  const commentBox =
    commentTarget && onComment ? (
      <DiffCommentBox
        draft={commentDraft}
        busy={commentBusy}
        error={commentError}
        submitLabel={isWorking ? "Queue" : "Send"}
        onChange={setCommentDraft}
        onSend={() => void sendComment()}
        onCancel={() => {
          if (commentBusy) return;
          setCommentTarget(null);
          setCommentDraft("");
          setCommentError(null);
        }}
      />
    ) : null;

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
              <strong>Blast radius — CI workflow</strong>
              <span>{blastRadiusTitle(diff.blastRadius)}</span>
            </div>
          ) : null}
          <p className={styles.changesEmpty}>Working tree is clean</p>
        </>
      )}

      {diff && !empty && itinerary && (
        <>
          <div className={styles.changesSplit}>
            <div className={styles.changesFiles}>
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
              {visiblePatches.length === 0 ? (
                <p className={styles.changesEmpty}>No textual diff for this file</p>
              ) : (
                <div className={styles.patchScroll}>
                  {visiblePatches.map((p) => (
                    <Fragment key={p.path}>
                      {p.hunks.length === 0 &&
                        p.text.split("\n").map((line, i) => {
                          const kind = diffLineKind(line);
                          const key = `${p.path}:${i}`;
                          const commentable =
                            Boolean(onComment) &&
                            (kind === "add" || kind === "del") &&
                            !line.startsWith("\\");
                          return (
                            <Fragment key={key}>
                              <DiffLine
                                line={line}
                                kind={kind}
                                commentable={commentable}
                                commenting={commentTarget?.key === key}
                                onCommentClick={
                                  commentable
                                    ? () =>
                                        toggleComment(key, {
                                          path: p.path,
                                          kind,
                                          text: line,
                                          oldLine: null,
                                          newLine: null,
                                        })
                                    : undefined
                                }
                              />
                              {commentTarget?.key === key ? commentBox : null}
                            </Fragment>
                          );
                        })}
                      {p.hunks.map((hunk) => (
                        <div
                          key={hunk.id}
                          className={styles.hunkBlock}
                          data-review-hunk={hunk.id}
                          data-review-hunk-accepted={
                            hunk.accepted ? "" : undefined
                          }
                        >
                          <div className={styles.hunkBar}>
                            <span className={styles.hunkPath}>{p.path}</span>
                            <button
                              type="button"
                              className={styles.hunkSeen}
                              aria-pressed={hunk.accepted}
                              title={
                                hunk.accepted
                                  ? "Mark this hunk as new again"
                                  : "Mark this hunk reviewed"
                              }
                              onClick={() =>
                                toggleHunk(hunk.id, !hunk.accepted)
                              }
                            >
                              {hunk.accepted ? "Reviewed" : "Mark reviewed"}
                            </button>
                          </div>
                          <DiffLine line={hunk.header} />
                          {annotateHunkLines(hunk.header, hunk.body).map(
                            (row, i) => {
                              const key = `${hunk.id}:${i}`;
                              const commentable =
                                Boolean(onComment) && row.commentable;
                              return (
                                <Fragment key={key}>
                                  <DiffLine
                                    line={row.text}
                                    kind={row.kind}
                                    oldLine={row.oldLine}
                                    newLine={row.newLine}
                                    commentable={commentable}
                                    commenting={commentTarget?.key === key}
                                    onCommentClick={
                                      commentable
                                        ? () =>
                                            toggleComment(key, {
                                              path: p.path,
                                              kind: row.kind,
                                              text: row.text,
                                              oldLine: row.oldLine,
                                              newLine: row.newLine,
                                            })
                                        : undefined
                                    }
                                  />
                                  {commentTarget?.key === key
                                    ? commentBox
                                    : null}
                                </Fragment>
                              );
                            },
                          )}
                        </div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              )}
              {diff.truncated && (
                <p className={styles.truncatedNote}>Diff truncated</p>
              )}
            </div>
          </div>
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
        </>
      )}
    </section>
  );
}
