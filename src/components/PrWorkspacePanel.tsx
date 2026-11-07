import { useCallback, useEffect, useRef, useState } from "react";
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
import { Markdown, MarkdownBody, type MarkdownTask } from "./Markdown";
import { toggleDescriptionTask } from "../descriptionTasks";
import { PrCompletionTextarea } from "./PrCompletionTextarea";
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
  agentThreads?: ThreadInfo[];
  onAddToAgent?: (input: { threadId: string | null; pr: PrDetail; comment: PrComment }) => Promise<void>;
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
  agentThreads = [],
  onAddToAgent,
  onSelectThread,
  onClose,
}: PrWorkspacePanelProps) {
  const matchedAgentId = agentThreads.some((thread) => thread.id === matchedThread?.id)
    ? matchedThread?.id ?? ""
    : "";
  const [agentThreadId, setAgentThreadId] = useState(matchedAgentId);
  useEffect(() => {
    setAgentThreadId(matchedAgentId);
  }, [projectPath, prNumber, matchedAgentId]);
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checklistError, setChecklistError] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<string | null>(null);
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
  const identity = `${projectPath}\0${prNumber}\0${activeRepo || ""}\0${activePr}`;
  const selection = useRef({ identity, generation: 0 });
  if (selection.current.identity !== identity) selection.current = { identity, generation: selection.current.generation + 1 };
  const generation = selection.current.generation;
  const taskBusy = useRef<number | null>(null);
  useEffect(() => { setPending(null); setChecklistError(false); }, [identity]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [stack, setStack] = useState<PrStackEntry[]>([]);
  const [stackBusy, setStackBusy] = useState<string | null>(null);
  const links = normalizePrLinks(matchedThread || { prNumber, prUrl: null, prState: null });

  useEffect(() => {
    setActivePr(prNumber);
    setActiveRepo(undefined);
    setTab("conversation");
  }, [prNumber]);

  const load = useCallback(async (commentsOnly = false) => {
    const requestedGeneration = generation;
    setLoading(true);
    try {
      const result = await prDetail({
        projectPath,
        prNumber: activePr,
        ...(activeRepo ? { repo: activeRepo } : {}),
      });
      if (!mounted.current || selection.current.generation !== requestedGeneration) return;
      if (!result.ok) {
        setError(result.reason);
        if (!commentsOnly) setPr(null);
        return;
      }
      setPr((previous) => {
        const samePr = previous?.url === result.pr.url;
        const comments = samePr && result.pr.commentsError
          ? [...new Map([...previous.comments, ...result.pr.comments].map((row) => [
              `${row.type}:${row.id ?? row.url ?? `${row.author}:${row.createdAt}:${row.body}`}`, row,
            ])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          : result.pr.comments;
        return commentsOnly && samePr
          ? { ...previous, comments, commentsError: result.pr.commentsError }
          : { ...result.pr, comments };
      });
      if (!commentsOnly) {
        setTitle(result.pr.title);
        setBody(result.pr.body);
      }
      setError(null);
      setChecklistError(false);
    } catch (err) {
      if (!mounted.current || selection.current.generation !== requestedGeneration) return;
      setError(rejectReason(err, "Couldn't load this pull request"));
      if (!commentsOnly) setPr(null);
    } finally {
      if (mounted.current && selection.current.generation === requestedGeneration) setLoading(false);
    }
  }, [prDetail, projectPath, activePr, activeRepo, generation]);

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
    if (!prCommentEdit || row.id == null || row.type === "review-summary" || pending) return;
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
      comments: pr.comments.map((c) => (c.type === row.type && c.id === rowId ? { ...c, reactions: list } : c)),
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
  const toggleTask = async (task: MarkdownTask) => {
    if (!pr || !open || dirty || pending || taskBusy.current === generation) return;
    taskBusy.current = generation;
    const requestedGeneration = generation;
    setPending("checklist");
    setChecklistError(false);
    try {
      const latest = await prDetail(prArgs);
      if (!mounted.current || selection.current.generation !== requestedGeneration) return;
      if (!latest.ok) throw new Error(latest.reason);
      if (latest.pr.url !== pr.url || latest.pr.state !== "OPEN") throw new Error("This pull request changed. Reload and try again.");
      const patched = toggleDescriptionTask(body, latest.pr.body, task);
      // The forge CLI has no conditional description write. Fetching directly
      // before writing narrows, but cannot eliminate, the remote write race.
      const saved = await prEdit({ ...prArgs, body: patched });
      if (!mounted.current || selection.current.generation !== requestedGeneration) return;
      if (!saved.ok) throw new Error(saved.reason);
      setPr(saved.pr);
      setTitle(saved.pr.title);
      setBody(saved.pr.body);
      setError(null);
    } catch (err) {
      if (mounted.current && selection.current.generation === requestedGeneration) {
        setError(rejectReason(err, "Couldn't update checklist"));
        setChecklistError(true);
      }
    } finally {
      if (taskBusy.current === requestedGeneration) taskBusy.current = null;
      if (mounted.current && selection.current.generation === requestedGeneration) setPending(null);
    }
  };

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
          disabled={pr?.forge === "gitlab"}
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
                  <MarkdownBody text={body} onTaskToggle={toggleTask} tasksDisabled={!open || dirty || pending != null} />
                ) : (
                  <p className={styles.hint}>Nothing to preview</p>
                )}
              </div>
            ) : (
              <PrCompletionTextarea projectPath={projectPath} repo={activeRepo} scope={String(activePr)}
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
            {open && pr.forge !== "gitlab" && prUpdateBranch && pr.mergeStateStatus === "BEHIND" ? (
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
            {open && pr.forge !== "gitlab" && pr.isDraft ? (
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
            {open && pr.forge !== "gitlab" && !pr.isDraft ? (
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
                disabled={pending != null || pr.forge === "gitlab"}
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
                disabled={pending != null || pr.forge === "gitlab"}
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

          {checklistError && error ? (
            <button type="button" className={styles.ghost} data-pr-checklist-reload=""
              disabled={dirty || pending != null || loading} onClick={() => void load()}>
              Reload pull request
            </button>
          ) : null}
          {error ? (
            <p className={styles.error} data-pr-workspace-error="">
              {error}
            </p>
          ) : null}

          <section className={styles.comments}>
            <h3 className={styles.subhead}>Discussion</h3>
            {onAddToAgent ? (
              <label className={styles.codePicker}>
                Add comments to
                <select
                  aria-label="Agent draft"
                  value={agentThreadId}
                  onChange={(event) => setAgentThreadId(event.target.value)}
                >
                  <option value="">New thread</option>
                  {agentThreads.map((thread) => (
                    <option key={thread.id} value={thread.id}>{thread.title}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {pr.commentsError ? (
              <div className={styles.actions}>
                <p className={styles.error} role="status">{pr.commentsError}</p>
                <button type="button" className={styles.ghost} disabled={loading} onClick={() => void load(true)}>
                  Retry comments
                </button>
              </div>
            ) : null}
            {pr.comments.length === 0 ? (
              <p className={styles.hint}>No comments yet</p>
            ) : (
              pr.comments.map((row, index) => {
                const editing = row.id != null && editingComment === `${row.type}:${row.id}`;
                return (
                  <article
                    key={`${row.type}:${row.id ?? row.url ?? `${row.author}-${index}`}`}
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
                      {onAddToAgent ? (
                        <button
                          type="button"
                          className={styles.ghost}
                          data-pr-comment-add-to-agent=""
                          disabled={pending != null}
                          onClick={async () => {
                            if (pending) return;
                            setPending("addToAgent");
                            try {
                              await onAddToAgent({ threadId: agentThreadId || null, pr, comment: row });
                            } catch (err) {
                              setError(rejectReason(err, "Couldn't add this comment to the draft"));
                            } finally {
                              setPending(null);
                            }
                          }}
                        >
                          Add to agent
                        </button>
                      ) : null}
                      {pr.forge !== "gitlab" && prCommentEdit && row.type !== "review-summary" && row.mine && row.id != null && !editing ? (
                        <button
                          type="button"
                          className={styles.ghost}
                          data-pr-comment-edit=""
                          disabled={pending != null}
                          onClick={() => {
                            setEditingComment(`${row.type}:${row.id}`);
                            setEditCommentBody(row.body);
                          }}
                        >
                          Edit
                        </button>
                      ) : null}
                    </div>
                    {row.path ? <span className={styles.hint}>{row.path}{row.line != null ? `:${row.line}` : ""}{row.outdated ? " (outdated)" : ""}</span> : null}
                    {editing ? (
                      <div className={styles.commentForm} data-pr-comment-edit-form="">
                        <PrCompletionTextarea projectPath={projectPath} repo={activeRepo} scope={String(activePr)}
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
                    {pr.forge !== "gitlab" && prReaction && row.type === "issue" && row.id != null ? (
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
                <PrCompletionTextarea projectPath={projectPath} repo={activeRepo} scope={String(activePr)}
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
