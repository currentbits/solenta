import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { applyMention, getMentionQuery, type MentionQuery } from "../../mention";
import {
  filterMentionExtras,
  sourceMentionRows,
  type ContextChip,
  type MentionExtra,
  type MentionIssueApi,
  type MentionSourceApi,
} from "../../contextChips";
import type { MentionCommit, PromptSnippet } from "../../shared/ipc";

type SourceExtra = Extract<MentionExtra, { kind: "source" | "commit" }>;

/**
 * The @-mention popup: the token under the caret, a debounced file lookup,
 * and accepting a row into the draft. No effects, so it cannot reorder
 * Composer's effects wherever it is called.
 */
export function useMentionMenu({
  textareaRef,
  onListFiles,
  promptSnippets,
  mentionExtras,
  onAcceptExtra,
  mentionSources,
  onAcceptSource,
  mentionIssueApi,
  onPickMentionFolder,
  disabled,
  writeDraft,
  setLocalError,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onListFiles?: (query: string) => Promise<string[]>;
  /** Saved snippets (issue #189), listed above files when `@name` matches. */
  promptSnippets?: readonly PromptSnippet[];
  mentionExtras?: readonly MentionExtra[];
  onAcceptExtra?: (chip: ContextChip) => void;
  /** @url/@terminal/@problems/@git-changes/@<commit> rows (#1722). */
  mentionSources?: MentionSourceApi;
  onAcceptSource?: (extra: SourceExtra) => void;
  /** Open-issue/discussion rows (#1805), fetched lazily once per menu open. */
  mentionIssueApi?: MentionIssueApi;
  onPickMentionFolder?: () => Promise<string | null>;
  disabled: boolean;
  writeDraft: (text: string, caret?: number) => void;
  setLocalError: Dispatch<SetStateAction<string | null>>;
}) {
  /** @-mention popup state; `mention` null means closed. */
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stale-response guard: only the latest lookup may paint the popup. */
  const mentionSeq = useRef(0);
  const snippetMatches = mention
    ? (promptSnippets ?? []).filter((sn) =>
        sn.name.toLowerCase().startsWith(mention.query.toLowerCase()),
      )
    : [];
  /** Recent commits, fetched once each time the popup opens. */
  const [commits, setCommits] = useState<readonly MentionCommit[]>([]);
  const commitsAsked = useRef(false);
  /** Open issues/discussions, fetched once each time the popup opens (#1805). */
  const [issueRows, setIssueRows] = useState<
    readonly { number: number; title: string }[]
  >([]);
  const [discussionRows, setDiscussionRows] = useState<
    readonly { number: number; title: string }[]
  >([]);
  const issuesAsked = useRef(false);
  const sourceRows =
    mention && mentionSources
      ? sourceMentionRows(mention.query, {
          verifyCommand: mentionSources.verifyCommand,
          commits,
        })
      : { sources: [], commits: [] };
  const issueExtras: MentionExtra[] = issueRows.map((r) => ({
    kind: "issue",
    number: r.number,
    title: r.title,
  }));
  const discussionExtras: MentionExtra[] = discussionRows.map((r) => ({
    kind: "discussion",
    number: r.number,
    title: r.title,
  }));
  const extraMatches = mention
    ? [
        ...sourceRows.sources,
        ...filterMentionExtras(
          [...(mentionExtras ?? []), ...issueExtras, ...discussionExtras],
          mention.query,
        ),
        ...sourceRows.commits,
      ]
    : [];
  /** Snippets, then sources, threads/PRs/skills, commits, then files. */
  const mentionCount =
    snippetMatches.length + extraMatches.length + mentionFiles.length;
  // Files land 150ms after the query changes; clamp so a shorter snippet
  // list never leaves the highlight past the end in between.
  const mentionActive = Math.max(0, Math.min(mentionIndex, mentionCount - 1));
  const mentionOpen =
    mention != null && (mentionCount > 0 || Boolean(onPickMentionFolder));

  const closeMention = useCallback(() => {
    if (mentionTimer.current) {
      clearTimeout(mentionTimer.current);
      mentionTimer.current = null;
    }
    setMention((prev) => (prev == null ? prev : null));
    commitsAsked.current = false;
    issuesAsked.current = false;
    setMentionFiles((prev) => (prev.length === 0 ? prev : []));
    setIssueRows((prev) => (prev.length === 0 ? prev : []));
    setDiscussionRows((prev) => (prev.length === 0 ? prev : []));
    setMentionIndex((prev) => (prev === 0 ? prev : 0));
  }, []);

  /** Recompute the active @token from the live textarea and (re)fetch files. */
  const refreshMention = useCallback(() => {
    const el = textareaRef.current;
    if (
      !el ||
      (!onListFiles &&
        !promptSnippets?.length &&
        !mentionExtras?.length &&
        !mentionSources &&
        !mentionIssueApi) ||
      disabled
    ) {
      closeMention();
      return;
    }
    const q = getMentionQuery(el.value, el.selectionStart ?? el.value.length);
    if (!q) {
      closeMention();
      return;
    }
    setMention((prev) =>
      prev && prev.start === q.start && prev.query === q.query ? prev : q,
    );
    if (mentionSources && !commitsAsked.current) {
      commitsAsked.current = true;
      mentionSources
        .listCommits()
        .then(setCommits)
        .catch(() => setCommits([]));
    }
    if (mentionIssueApi && !issuesAsked.current) {
      issuesAsked.current = true;
      mentionIssueApi
        .listOpenIssues()
        .then(setIssueRows)
        .catch(() => setIssueRows([]));
      mentionIssueApi
        .listDiscussions?.()
        .then(setDiscussionRows)
        .catch(() => setDiscussionRows([]));
    }
    if (mentionTimer.current) clearTimeout(mentionTimer.current);
    if (!onListFiles) return;
    const seq = ++mentionSeq.current;
    mentionTimer.current = setTimeout(() => {
      onListFiles(q.query)
        .then((files) => {
          if (mentionSeq.current !== seq) return;
          setMentionFiles(files);
          setMentionIndex(0);
        })
        .catch(() => {
          if (mentionSeq.current !== seq) return;
          setMentionFiles([]);
        });
    }, 150);
  }, [
    onListFiles,
    promptSnippets,
    mentionExtras,
    mentionSources,
    mentionIssueApi,
    disabled,
    closeMention,
  ]);

  const acceptMention = useCallback(
    (path: string) => {
      const el = textareaRef.current;
      if (!el || !mention) return;
      const next = applyMention(
        el.value,
        el.selectionStart ?? el.value.length,
        mention.start,
        path,
      );
      writeDraft(next.text, next.caret);
      closeMention();
    },
    [mention, closeMention, writeDraft],
  );

  /** Replace the `@query` token with the snippet's text, caret after it. */
  const acceptSnippet = useCallback(
    (snippet: PromptSnippet) => {
      const el = textareaRef.current;
      if (!el || !mention) return;
      const caret = el.selectionStart ?? el.value.length;
      const head = el.value.slice(0, mention.start) + snippet.text;
      writeDraft(head + el.value.slice(caret), head.length);
      closeMention();
    },
    [mention, closeMention, writeDraft],
  );

  const acceptExtra = useCallback(
    (extra: MentionExtra) => {
      const el = textareaRef.current;
      if (!el || !mention) return;
      const caret = el.selectionStart ?? el.value.length;
      if (extra.kind === "source" || extra.kind === "commit") {
        if (extra.kind === "source" && extra.unavailable) {
          closeMention();
          mentionSources?.onOpenVerifySettings?.();
          return;
        }
        if (extra.kind === "source" && extra.source === "url" && !extra.arg) {
          // Bare @url row: leave `@https://` for the user to finish typing.
          const head = `${el.value.slice(0, mention.start)}@https://`;
          writeDraft(head + el.value.slice(caret), head.length);
          setMention({ start: mention.start, query: "https://" });
          return;
        }
        writeDraft(el.value.slice(0, mention.start) + el.value.slice(caret), mention.start);
        onAcceptSource?.(extra);
        closeMention();
        return;
      }
      if (!onAcceptExtra) return;
      writeDraft(el.value.slice(0, mention.start) + el.value.slice(caret), mention.start);
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `chip-${Date.now()}`;
      if (extra.kind === "thread") {
        onAcceptExtra({
          id,
          kind: "thread",
          threadId: extra.id,
          title: extra.title,
        });
      } else if (extra.kind === "pr") {
        onAcceptExtra({
          id,
          kind: "pr",
          number: extra.number,
          title: extra.title,
        });
      } else if (extra.kind === "issue" || extra.kind === "discussion") {
        onAcceptExtra({
          id,
          kind: extra.kind,
          number: extra.number,
          title: extra.title,
        });
      } else if (extra.kind === "skill") {
        onAcceptExtra({
          id,
          kind: "skill",
          name: extra.name,
          description: extra.description,
        });
      }
      closeMention();
    },
    [mention, closeMention, writeDraft, onAcceptExtra, onAcceptSource, mentionSources],
  );

  const browseMentionFolder = useCallback(() => {
    if (!onPickMentionFolder || disabled) return;
    void onPickMentionFolder()
      .then((path) => {
        if (path) acceptMention(path);
      })
      .catch((err) => {
        const msg =
          err instanceof Error && err.message
            ? err.message
            : "Failed to pick folder";
        setLocalError(msg);
      });
  }, [onPickMentionFolder, disabled, acceptMention]);
  return {
    mentionFiles,
    snippetMatches,
    extraMatches,
    mentionCount,
    mentionActive,
    setMentionIndex,
    mentionOpen,
    closeMention,
    refreshMention,
    acceptMention,
    acceptSnippet,
    acceptExtra,
    browseMentionFolder,
  };
}
