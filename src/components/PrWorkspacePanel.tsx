import { useCallback, useEffect, useState } from "react";
import { formatRelativeAge } from "../format";
import { canSubmitComment, canSubmitPr } from "../prUi";
import type {
  PrCommentResult,
  PrDetail,
  PrDetailResult,
  ThreadInfo,
} from "../shared/ipc";
import { Markdown } from "./Markdown";
import styles from "./PrWorkspacePanel.module.css";

function rejectReason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export interface PrWorkspacePanelProps {
  projectPath: string;
  prNumber: number;
  matchedThread: ThreadInfo | null;
  prDetail: (input: {
    projectPath: string;
    prNumber: number;
  }) => Promise<PrDetailResult>;
  prEdit: (input: {
    projectPath: string;
    prNumber: number;
    title?: string;
    body?: string;
  }) => Promise<PrDetailResult>;
  prComment: (input: {
    projectPath: string;
    prNumber: number;
    body: string;
  }) => Promise<PrCommentResult>;
  prClose: (input: {
    projectPath: string;
    prNumber: number;
  }) => Promise<PrDetailResult>;
  prReady: (input: {
    projectPath: string;
    prNumber: number;
    undo?: boolean;
  }) => Promise<PrDetailResult>;
  prMergeAt: (input: {
    projectPath: string;
    prNumber: number;
  }) => Promise<PrDetailResult>;
  onSelectThread: (id: string) => void;
  onClose: () => void;
}

export function PrWorkspacePanel({
  projectPath,
  prNumber,
  matchedThread,
  prDetail,
  prEdit,
  prComment,
  prClose,
  prReady,
  prMergeAt,
  onSelectThread,
  onClose,
}: PrWorkspacePanelProps) {
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"merge" | "close" | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await prDetail({ projectPath, prNumber });
      if (!result.ok) {
        setError(result.reason);
        setPr(null);
        return;
      }
      setPr(result.pr);
      setTitle(result.pr.title);
      setBody(result.pr.body);
      setError(null);
    } catch (err) {
      setError(rejectReason(err, "Couldn't load this pull request"));
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [prDetail, projectPath, prNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (
    kind: string,
    fn: () => Promise<PrDetailResult | PrCommentResult>,
  ) => {
    if (pending) return;
    setPending(kind);
    try {
      const result = await fn();
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setError(null);
      setConfirm(null);
      if ("pr" in result && result.pr) {
        setPr(result.pr);
        setTitle(result.pr.title);
        setBody(result.pr.body);
      } else {
        await load();
      }
      if (kind === "comment") setComment("");
    } catch (err) {
      setError(rejectReason(err, "Action failed"));
    } finally {
      setPending(null);
    }
  };

  const open = pr?.state === "OPEN";
  const dirty =
    pr != null && (title.trim() !== pr.title || body !== pr.body);
  const titleOk = canSubmitPr(title);

  return (
    <aside className={styles.panel} data-pr-workspace="">
      <header className={styles.header}>
        <h2 className={styles.heading}>#{prNumber}</h2>
        <button
          type="button"
          className={styles.icon}
          aria-label="Close pull request"
          data-pr-workspace-close=""
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {loading && !pr ? (
        <p className={styles.hint}>Loading pull request…</p>
      ) : error && !pr ? (
        <div className={styles.errorBox}>
          <p className={styles.error}>{error}</p>
          <button type="button" className={styles.ghost} onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : pr ? (
        <div className={styles.scroll}>
          <div className={styles.meta}>
            {pr.isDraft ? <span className={styles.draft}>Draft</span> : null}
            <span className={styles.state}>{pr.state.toLowerCase()}</span>
            {pr.headRefName ? (
              <span className={styles.branch}>{pr.headRefName}</span>
            ) : null}
            {pr.updatedAt ? (
              <span className={styles.age}>
                {formatRelativeAge(Date.parse(pr.updatedAt) || 0, now)}
              </span>
            ) : null}
          </div>

          <label className={styles.field}>
            <span className={styles.label}>Title</span>
            <input
              className={styles.input}
              data-pr-edit-title=""
              value={title}
              disabled={!open || pending != null}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.labelRow}>
              <span className={styles.label}>Body</span>
              <button
                type="button"
                className={styles.previewToggle}
                data-pr-preview=""
                aria-pressed={preview}
                onClick={() => setPreview((v) => !v)}
              >
                {preview ? "Edit" : "Preview"}
              </button>
            </span>
            {preview ? (
              <div className={styles.preview}>
                {body.trim() ? (
                  <Markdown text={body} />
                ) : (
                  <p className={styles.hint}>Nothing to preview</p>
                )}
              </div>
            ) : (
              <textarea
                className={styles.textarea}
                data-pr-edit-body=""
                value={body}
                rows={8}
                disabled={!open || pending != null}
                onChange={(event) => setBody(event.target.value)}
              />
            )}
          </label>

          {open && dirty ? (
            <button
              type="button"
              className={styles.primary}
              data-pr-save=""
              disabled={!titleOk || pending != null}
              onClick={() =>
                void runAction("edit", () =>
                  prEdit({
                    projectPath,
                    prNumber,
                    title: title.trim(),
                    body,
                  }),
                )
              }
            >
              {pending === "edit" ? "Saving…" : "Save"}
            </button>
          ) : null}

          <div className={styles.actions}>
            {open && pr.isDraft ? (
              <button
                type="button"
                className={styles.ghost}
                data-pr-ready=""
                disabled={pending != null}
                onClick={() =>
                  void runAction("ready", () =>
                    prReady({ projectPath, prNumber }),
                  )
                }
              >
                {pending === "ready" ? "Updating…" : "Mark ready"}
              </button>
            ) : null}
            {open && !pr.isDraft ? (
              <button
                type="button"
                className={styles.ghost}
                data-pr-draft=""
                disabled={pending != null}
                onClick={() =>
                  void runAction("draft", () =>
                    prReady({ projectPath, prNumber, undo: true }),
                  )
                }
              >
                {pending === "draft" ? "Updating…" : "Convert to draft"}
              </button>
            ) : null}
            {open ? (
              <button
                type="button"
                className={styles.primary}
                data-pr-merge=""
                disabled={pending != null}
                onClick={() => setConfirm("merge")}
              >
                Merge
              </button>
            ) : null}
            {open ? (
              <button
                type="button"
                className={styles.danger}
                data-pr-close=""
                disabled={pending != null}
                onClick={() => setConfirm("close")}
              >
                Close
              </button>
            ) : null}
            <a
              className={styles.link}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub
            </a>
            {matchedThread ? (
              <button
                type="button"
                className={styles.ghost}
                data-pr-open-thread=""
                onClick={() => onSelectThread(matchedThread.id)}
              >
                Open thread
              </button>
            ) : null}
          </div>

          {confirm ? (
            <div className={styles.confirm} data-pr-confirm={confirm}>
              <p className={styles.confirmText}>
                {confirm === "merge"
                  ? "Squash-merge this pull request?"
                  : "Close this pull request?"}
              </p>
              <button
                type="button"
                className={confirm === "merge" ? styles.primary : styles.danger}
                data-pr-confirm-yes=""
                disabled={pending != null}
                onClick={() =>
                  void runAction(confirm, () =>
                    confirm === "merge"
                      ? prMergeAt({ projectPath, prNumber })
                      : prClose({ projectPath, prNumber }),
                  )
                }
              >
                {pending === confirm
                  ? confirm === "merge"
                    ? "Merging…"
                    : "Closing…"
                  : confirm === "merge"
                    ? "Squash merge"
                    : "Close PR"}
              </button>
              <button
                type="button"
                className={styles.ghost}
                data-pr-confirm-no=""
                disabled={pending != null}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
            </div>
          ) : null}

          {error ? (
            <p className={styles.error} data-pr-workspace-error="">
              {error}
            </p>
          ) : null}

          <section className={styles.comments}>
            <h3 className={styles.subhead}>Discussion</h3>
            {pr.comments.length === 0 ? (
              <p className={styles.hint}>No comments yet</p>
            ) : (
              pr.comments.map((row, index) => (
                <article
                  key={row.url || `${row.author}-${index}`}
                  className={styles.comment}
                  data-pr-comment-item=""
                >
                  <div className={styles.commentMeta}>
                    <span className={styles.author}>{row.author}</span>
                    {row.createdAt ? (
                      <span className={styles.age}>
                        {formatRelativeAge(Date.parse(row.createdAt) || 0, now)}
                      </span>
                    ) : null}
                  </div>
                  <Markdown text={row.body} />
                </article>
              ))
            )}
            {open ? (
              <form
                className={styles.commentForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!canSubmitComment(comment) || pending) return;
                  void runAction("comment", () =>
                    prComment({
                      projectPath,
                      prNumber,
                      body: comment.trim(),
                    }),
                  );
                }}
              >
                <textarea
                  className={styles.textarea}
                  data-pr-comment=""
                  placeholder="Leave a comment"
                  value={comment}
                  rows={4}
                  disabled={pending != null}
                  onChange={(event) => setComment(event.target.value)}
                />
                <button
                  type="submit"
                  className={styles.primary}
                  data-pr-comment-submit=""
                  disabled={!canSubmitComment(comment) || pending != null}
                >
                  {pending === "comment" ? "Posting…" : "Comment"}
                </button>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}
    </aside>
  );
}
