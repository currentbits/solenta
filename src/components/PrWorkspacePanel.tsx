import { useCallback, useEffect, useState } from "react";
import { formatRelativeAge, middleTruncate } from "../format";
import { normalizePrLinks } from "../prLinks";
import { canSubmitComment, canSubmitPr } from "../prUi";
import type {
  CoderApi,
  MergeMethod,
  MergeOptionsResult,
  PrComment,
  PrCommentResult,
  PrDetail,
  PrDetailResult,
  PrReactionResult,
  PrStackEntry,
  ReactionContent,
  ThreadInfo,
} from "../shared/ipc";
import { Markdown } from "./Markdown";
import { PrCodeTab } from "./PrCodeTab";
import styles from "./PrWorkspacePanel.module.css";

const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash merge",
  merge: "Merge commit",
  rebase: "Rebase merge",
};

/**
 * GitHub's 8 comment reactions (#1795 feature 3): the emoji shown in the "+"
 * picker and under each comment, the REST `content` the IPC call sends, and
 * the `ReactionContent` enum the fetch reports back in `reactionGroups`.
 */
const PR_REACTIONS: ReadonlyArray<{ emoji: string; content: string; enum: ReactionContent }> = [
  { emoji: "👍", content: "+1", enum: "THUMBS_UP" },
  { emoji: "👎", content: "-1", enum: "THUMBS_DOWN" },
  { emoji: "😄", content: "laugh", enum: "LAUGH" },
  { emoji: "🎉", content: "hooray", enum: "HOORAY" },
  { emoji: "😕", content: "confused", enum: "CONFUSED" },
  { emoji: "❤️", content: "heart", enum: "HEART" },
  { emoji: "🚀", content: "rocket", enum: "ROCKET" },
  { emoji: "👀", content: "eyes", enum: "EYES" },
];

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
    repo?: string;
  }) => Promise<PrDetailResult>;
  prEdit: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
    title?: string;
    body?: string;
  }) => Promise<PrDetailResult>;
  prComment: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
    body: string;
  }) => Promise<PrCommentResult>;
  prClose: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
  }) => Promise<PrDetailResult>;
  prReady: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
    undo?: boolean;
  }) => Promise<PrDetailResult>;
  prMergeAt: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
    method?: MergeMethod;
  }) => Promise<PrDetailResult>;
  /** Shown as "Update branch" when the PR is BEHIND (#1795 feature 1). Omit to hide the button. */
  prUpdateBranch?: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
  }) => Promise<PrDetailResult>;
  /** Edits a comment in place (#1795 feature 2). Omit to hide the Edit affordance. */
  prCommentEdit?: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
    commentId: number;
    type?: "issue" | "review";
    body: string;
  }) => Promise<PrDetailResult>;
  /** Adds/removes the viewer's reaction (#1795 feature 3). Omit to hide the reaction picker. */
  prReaction?: (input: {
    projectPath: string;
    prNumber: number;
    repo?: string;
    commentId: number;
    content: string;
    remove?: boolean;
    reactionId?: number;
  }) => Promise<PrReactionResult>;
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
  prUpdateBranch,
  prCommentEdit,
  prReaction,
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
  const [editingComment, setEditingComment] = useState<number | null>(null);
  const [editCommentBody, setEditCommentBody] = useState("");
  const [reactionPickerFor, setReactionPickerFor] = useState<number | null>(null);
  // Reaction id cached per comment+content from a same-session add, so a
  // same-session remove skips the list-by-login round trip (#1795 feature 3).
  const [reactionIds, setReactionIds] = useState<Record<string, number>>({});
  const [confirm, setConfirm] = useState<"merge" | "close" | null>(null);
  const [mergeOpts, setMergeOpts] = useState<MergeOptionsResult | null>(null);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  // Repo-allowed merge methods for the confirm bar's picker (#1493 D).
  useEffect(() => {
    const load =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as { coder?: CoderApi }).coder?.git?.mergeOptions;
    if (typeof load !== "function") return;
    let live = true;
    load({ projectPath })
      .then((r) => live && setMergeOpts(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath]);
  const methods = mergeOpts?.ok ? mergeOpts.methods : null;
  const chosen = method ?? (mergeOpts?.ok ? mergeOpts.defaultMethod : "squash");
  const [now] = useState(() => Date.now());
  const [tab, setTab] = useState<"conversation" | "code">("conversation");
  const [activePr, setActivePr] = useState(prNumber);
  const [activeRepo, setActiveRepo] = useState<string | undefined>(undefined);
  const [stack, setStack] = useState<PrStackEntry[]>([]);
  const [stackBusy, setStackBusy] = useState<string | null>(null);
  const links = normalizePrLinks(matchedThread || { prNumber, prUrl: null, prState: null });

  useEffect(() => {
    setActivePr(prNumber);
    setActiveRepo(undefined);
    setTab("conversation");
  }, [prNumber]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await prDetail({
        projectPath,
        prNumber: activePr,
        ...(activeRepo ? { repo: activeRepo } : {}),
      });
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
  }, [prDetail, projectPath, activePr, activeRepo]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const git =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as { coder?: CoderApi }).coder?.git;
    if (typeof git?.prStack !== "function") return;
    let live = true;
    git
      .prStack({
        projectPath,
        prNumber: activePr,
        ...(activeRepo ? { repo: activeRepo } : {}),
      })
      .then((out) => {
        if (live && out.ok) setStack(out.stack);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, activePr, activeRepo]);

  const runStack = async (kind: "rebase" | "merge") => {
    const git =
      typeof window === "undefined"
        ? undefined
        : (window as unknown as { coder?: CoderApi }).coder?.git;
    const fn = kind === "rebase" ? git?.prRebaseStack : git?.prMergeStack;
    if (!fn || stackBusy) return;
    setStackBusy(kind);
    try {
      const out = await fn({
        projectPath,
        prNumber: activePr,
        ...(activeRepo ? { repo: activeRepo } : {}),
        ...(kind === "merge" ? { method: chosen } : {}),
      });
      if (!out.ok) {
        setError(out.reason);
        return;
      }
      setError(null);
      if (out.ok && "stack" in out) setStack(out.stack);
      await load();
    } catch (err) {
      setError(rejectReason(err, "Stack action failed"));
    } finally {
      setStackBusy(null);
    }
  };

  const prArgs = { projectPath, prNumber: activePr, ...(activeRepo ? { repo: activeRepo } : {}) };

  const saveCommentEdit = async (row: PrComment) => {
    if (!prCommentEdit || row.id == null || pending) return;
    setPending("editComment");
    try {
      const result = await prCommentEdit({
        ...prArgs,
        commentId: row.id,
        type: row.type,
        body: editCommentBody,
      });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setError(null);
      setPr(result.pr);
      setEditingComment(null);
    } catch (err) {
      setError(rejectReason(err, "Edit failed"));
    } finally {
      setPending(null);
    }
  };

  const toggleReaction = async (
    row: PrComment,
    choice: { emoji: string; content: string; enum: ReactionContent },
  ) => {
    if (!prReaction || row.id == null || !pr) return;
    const rowId = row.id;
    const existing = row.reactions?.find((r) => r.content === choice.enum);
    const removing = Boolean(existing?.viewerHasReacted);
    const cacheKey = `${rowId}:${choice.content}`;
    const prevPr = pr;

    const list = row.reactions ? [...row.reactions] : [];
    const idx = list.findIndex((r) => r.content === choice.enum);
    if (removing && idx >= 0) {
      const count = Math.max(0, list[idx].count - 1);
      if (count === 0) list.splice(idx, 1);
      else list[idx] = { ...list[idx], count, viewerHasReacted: false };
    } else if (!removing) {
      if (idx >= 0) {
        list[idx] = { ...list[idx], count: list[idx].count + 1, viewerHasReacted: true };
      } else {
        list.push({ content: choice.enum, count: 1, viewerHasReacted: true });
      }
    }
    setPr({
      ...pr,
      comments: pr.comments.map((c) => (c.id === rowId ? { ...c, reactions: list } : c)),
    });
    setReactionPickerFor(null);
    try {
      const result = await prReaction({
        ...prArgs,
        commentId: rowId,
        content: choice.content,
        remove: removing,
        ...(removing ? { reactionId: reactionIds[cacheKey] } : {}),
      });
      if (!result.ok) {
        setPr(prevPr);
        setError(result.reason);
        return;
      }
      setError(null);
      setReactionIds((prev) => {
        const next = { ...prev };
        if (!removing && result.reactionId != null) next[cacheKey] = result.reactionId;
        else if (removing) delete next[cacheKey];
        return next;
      });
    } catch (err) {
      setPr(prevPr);
      setError(rejectReason(err, "Reaction failed"));
    }
  };

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
    <aside className={styles.panel} data-pr-workspace="" data-pr-tab={tab}>
      <header className={styles.header}>
        {links.length > 1 ? (
          <select
            className={styles.prPicker}
            data-pr-link=""
            aria-label="Linked pull requests"
            value={`${activeRepo || ""}#${activePr}`}
            onChange={(event) => {
              const [repo, num] = event.target.value.split("#");
              setActivePr(Number(num));
              setActiveRepo(repo || undefined);
            }}
          >
            {links.map((link) => (
              <option key={`${link.repo || ""}#${link.number}`} value={`${link.repo || ""}#${link.number}`}>
                {link.repo ? `${link.repo}#${link.number}` : `#${link.number}`}
              </option>
            ))}
          </select>
        ) : (
          <h2 className={styles.heading}>#{activePr}</h2>
        )}
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
      <div className={styles.tabs} role="tablist" aria-label="Pull request">
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-pr-tab="conversation"
          aria-selected={tab === "conversation"}
          onClick={() => setTab("conversation")}
        >
          Conversation
        </button>
        <button
          type="button"
          role="tab"
          className={styles.tab}
          data-pr-tab="code"
          aria-selected={tab === "code"}
          onClick={() => setTab("code")}
        >
          Code
        </button>
      </div>

      {loading && !pr ? (
        <p className={styles.hint}>Loading pull request…</p>
      ) : error && !pr ? (
        <div className={styles.errorBox}>
          <p className={styles.error}>{error}</p>
          <button type="button" className={styles.ghost} onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : pr && tab === "code" ? (
        <div className={styles.scroll}>
          <PrCodeTab
            projectPath={projectPath}
            prNumber={activePr}
            repo={activeRepo}
          />
        </div>
      ) : pr ? (
        <div className={styles.scroll}>
          <div className={styles.meta}>
            {pr.isDraft ? <span className={styles.draft}>Draft</span> : null}
            <span className={styles.state}>{pr.state.toLowerCase()}</span>
            {pr.headRefName ? (
              <span className={styles.branch} title={pr.headRefName}>
                {middleTruncate(pr.headRefName, 26, 0.65)}
              </span>
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
                    ...prArgs,
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
            {open && prUpdateBranch && pr.mergeStateStatus === "BEHIND" ? (
              <button
                type="button"
                className={styles.ghost}
                data-pr-update-branch=""
                disabled={pending != null}
                onClick={() =>
                  void runAction("updateBranch", () => prUpdateBranch(prArgs))
                }
              >
                {pending === "updateBranch" ? "Updating…" : "Update branch"}
              </button>
            ) : null}
            {open && pr.isDraft ? (
              <button
                type="button"
                className={styles.ghost}
                data-pr-ready=""
                disabled={pending != null}
                onClick={() =>
                  void runAction("ready", () =>
                    prReady(prArgs),
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
                    prReady({ ...prArgs, undo: true }),
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
            {stack.length >= 2 ? (
              <>
                <button
                  type="button"
                  className={styles.ghost}
                  data-pr-rebase-stack=""
                  disabled={stackBusy != null || pending != null}
                  onClick={() => void runStack("rebase")}
                >
                  {stackBusy === "rebase" ? "Rebasing…" : "Rebase stack"}
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  data-pr-merge-stack=""
                  disabled={stackBusy != null || pending != null}
                  onClick={() => void runStack("merge")}
                >
                  {stackBusy === "merge" ? "Merging…" : "Merge stack"}
                </button>
              </>
            ) : null}
          </div>

          {confirm ? (
            <div className={styles.confirm} data-pr-confirm={confirm}>
              <p className={styles.confirmText}>
                {confirm === "merge"
                  ? `${MERGE_LABEL[chosen]} this pull request?`
                  : "Close this pull request?"}
              </p>
              {confirm === "merge" && methods && methods.length > 1 ? (
                <select
                  data-merge-method=""
                  aria-label="Merge method"
                  value={chosen}
                  disabled={pending != null}
                  onChange={(e) => setMethod(e.target.value as MergeMethod)}
                >
                  {methods.map((m) => (
                    <option key={m} value={m}>
                      {MERGE_LABEL[m]}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className={confirm === "merge" ? styles.primary : styles.danger}
                data-pr-confirm-yes=""
                disabled={pending != null}
                onClick={() =>
                  void runAction(confirm, () =>
                    confirm === "merge"
                      ? prMergeAt({ ...prArgs, method: chosen })
                      : prClose(prArgs),
                  )
                }
              >
                {pending === confirm
                  ? confirm === "merge"
                    ? "Merging…"
                    : "Closing…"
                  : confirm === "merge"
                    ? MERGE_LABEL[chosen]
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
              pr.comments.map((row, index) => {
                const editing = row.id != null && editingComment === row.id;
                return (
                  <article
                    key={row.id ?? row.url ?? `${row.author}-${index}`}
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
                      {prCommentEdit && row.mine && row.id != null && !editing ? (
                        <button
                          type="button"
                          className={styles.ghost}
                          data-pr-comment-edit=""
                          disabled={pending != null}
                          onClick={() => {
                            setEditingComment(row.id!);
                            setEditCommentBody(row.body);
                          }}
                        >
                          Edit
                        </button>
                      ) : null}
                    </div>
                    {editing ? (
                      <div className={styles.commentForm} data-pr-comment-edit-form="">
                        <textarea
                          className={styles.textarea}
                          data-pr-comment-edit-body=""
                          value={editCommentBody}
                          rows={4}
                          disabled={pending != null}
                          onChange={(event) => setEditCommentBody(event.target.value)}
                        />
                        <div className={styles.actions}>
                          <button
                            type="button"
                            className={styles.primary}
                            data-pr-comment-edit-save=""
                            disabled={!canSubmitComment(editCommentBody) || pending != null}
                            onClick={() => void saveCommentEdit(row)}
                          >
                            {pending === "editComment" ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            className={styles.ghost}
                            data-pr-comment-edit-cancel=""
                            disabled={pending != null}
                            onClick={() => setEditingComment(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <Markdown text={row.body} />
                    )}
                    {prReaction && row.id != null ? (
                      <div className={styles.reactionsRow} data-pr-reactions="">
                        {(row.reactions || [])
                          .filter((r) => r.count > 0)
                          .map((r) => {
                            const choice = PR_REACTIONS.find((p) => p.enum === r.content);
                            if (!choice) return null;
                            return (
                              <button
                                key={r.content}
                                type="button"
                                className={styles.reactionChip}
                                data-pr-reaction={r.content}
                                aria-pressed={r.viewerHasReacted}
                                disabled={pending != null}
                                onClick={() => void toggleReaction(row, choice)}
                              >
                                {choice.emoji} {r.count}
                              </button>
                            );
                          })}
                        <div className={styles.reactionPickerWrap}>
                          <button
                            type="button"
                            className={styles.reactionAdd}
                            data-pr-reaction-add=""
                            aria-label="Add reaction"
                            disabled={pending != null}
                            onClick={() =>
                              setReactionPickerFor((cur) => (cur === row.id ? null : row.id!))
                            }
                          >
                            +
                          </button>
                          {reactionPickerFor === row.id ? (
                            <div className={styles.reactionPicker} data-pr-reaction-picker="">
                              {PR_REACTIONS.map((choice) => (
                                <button
                                  key={choice.content}
                                  type="button"
                                  className={styles.reactionOption}
                                  data-pr-reaction-option={choice.content}
                                  onClick={() => void toggleReaction(row, choice)}
                                >
                                  {choice.emoji}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
            {open ? (
              <form
                className={styles.commentForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!canSubmitComment(comment) || pending) return;
                  void runAction("comment", () =>
                    prComment({
                      ...prArgs,
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
