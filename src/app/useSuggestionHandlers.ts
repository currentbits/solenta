import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ProjectInfo, WorkSuggestion } from "../shared/ipc";
import type { UseCoderResult } from "../useCoder";
import type { FixHandler } from "../fixSuggest";

/**
 * Suggested-work chip actions (start as a fork, file an issue, dismiss), and
 * the terminal / dev-server fix cards (#253).
 */
export function useSuggestionHandlers({
  selectedThreadId,
  project,
  forkThread,
  startRun,
  createIssue,
  resolveSuggestion,
  setChipError,
  restoreDraft,
}: {
  selectedThreadId: UseCoderResult["selectedThreadId"];
  project: ProjectInfo | null;
  forkThread: UseCoderResult["forkThread"];
  startRun: UseCoderResult["startRun"];
  createIssue: UseCoderResult["createIssue"];
  resolveSuggestion: UseCoderResult["resolveSuggestion"];
  setChipError: Dispatch<SetStateAction<string | null>>;
  restoreDraft: (draft: { threadId: string; text: string }) => void;
}) {
  const handleStartSuggestion = useCallback(
    async (s: WorkSuggestion) => {
      const threadId = selectedThreadId;
      if (!threadId) return;
      // Stay on the thread the chip was clicked from; the new worker nests
      // under it in the sidebar and runs in the background.
      const t = await forkThread(threadId, { worktree: true, select: false });
      if (!t) return;
      // Resolve before startRun so a failed kickoff cannot leave the chip
      // open — a retry would fork a second idle thread.
      await resolveSuggestion(threadId, s.id, "started", {
        startedThreadId: t.id,
      });
      try {
        await startRun(s.prompt, t.id);
      } catch {
        // startRun already set the run-scope error. The fork exists and
        // the chip is started; the new thread is nested under this one.
      }
    },
    [selectedThreadId, forkThread, startRun, resolveSuggestion],
  );

  const handleFileSuggestion = useCallback(
    async (s: WorkSuggestion) => {
      const threadId = selectedThreadId;
      const projectPath = project?.path;
      if (!threadId || !projectPath) return;
      const r = await createIssue(
        projectPath,
        s.title,
        `${s.prompt}\n\n_Filed from a Solenta suggested-work chip._`,
      );
      if (!r.ok) {
        // In-band like setIssuePlanStatus / planboard: show the reason, leave
        // the chip open. ArchiveToast is App's surface for action failures.
        setChipError(r.reason);
        return;
      }
      setChipError(null);
      await resolveSuggestion(threadId, s.id, "filed", {
        issueNumber: r.number,
      });
    },
    [selectedThreadId, project?.path, createIssue, resolveSuggestion],
  );

  const handleDismissSuggestion = useCallback(
    async (s: WorkSuggestion) => {
      if (!selectedThreadId) return;
      await resolveSuggestion(selectedThreadId, s.id, "dismissed");
    },
    [selectedThreadId, resolveSuggestion],
  );

  const handleFixSuggestion = useCallback<FixHandler>(
    (action, threadId, prompt) => {
      if (action === "draft") {
        restoreDraft({ threadId, text: prompt });
        return;
      }
      void (async () => {
        let target: string | undefined = threadId;
        if (action === "fork") {
          const t = await forkThread(threadId, { worktree: true, select: false });
          if (!t) return;
          target = t.id;
        }
        // startRun reports its own failure as the run-scope error.
        await startRun(prompt, target).catch(() => {});
      })();
    },
    [forkThread, startRun, restoreDraft],
  );

  return {
    handleFixSuggestion,
    handleStartSuggestion,
    handleFileSuggestion,
    handleDismissSuggestion,
  };
}
