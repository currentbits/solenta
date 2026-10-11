import { useCallback, useEffect, useState } from "react";
import { formatRelativeAge } from "../format";
import { normalizePrLinks } from "../prLinks";
import { canSubmitComment, canSubmitPr } from "../prUi";
import type {
  CoderApi,
  MergeMethod,
  MergeOptionsResult,
  PrCommentResult,
  PrDetail,
  PrDetailResult,
  PrStackEntry,
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
