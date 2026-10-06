import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  CoderApi,
  InputValues,
  PermissionDecision,
  PermissionMode,
  ReasoningEffort,
  SpecArtifact,
  ThreadDetail,
  ThreadInfo,
  ThreadMessagePin,
  WorkSuggestionStatus,
} from "../shared/ipc";
import type { CoderError } from "../useCoder";
import { errorMessage } from "./errorMessage";
import { nextVisibleThreadId } from "../threadSelection";

/**
 * Per-thread actions: stop, permissions, provider/effort, flags, notes,
 * spec/teach/ask/btw.
 */
export function useCoderThreadActions({
  api,
  selectedThreadId,
  setSelectedThreadId,
  setDetail,
  setError,
  selectedRef,
  threadsRef,
  applyThreads,
}: {
  api: CoderApi;
  selectedThreadId: string | null;
  setSelectedThreadId: Dispatch<SetStateAction<string | null>>;
  setDetail: Dispatch<SetStateAction<ThreadDetail | null>>;
  setError: Dispatch<SetStateAction<CoderError | null>>;
  selectedRef: RefObject<string | null>;
  threadsRef: RefObject<ThreadInfo[]>;
  applyThreads: (next: ThreadInfo[]) => void;
}) {
  const stopRun = useCallback(async () => {
    if (!selectedThreadId) return;
    const threadId = selectedThreadId;
    try {
      await api.runs.stop({ threadId });
      const d = await api.threads.get(threadId);
      if (selectedRef.current !== threadId) return;
      setDetail(d);
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === d.thread.id ? d.thread : t,
        ),
      );
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
    }
  }, [api, selectedThreadId, applyThreads]);

  const setPermissionMode = useCallback(
    async (mode: PermissionMode, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return;
      try {
        const thread = await api.threads.setPermissionMode({
          threadId,
          mode,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const respondPermission = useCallback(
    async (
      requestId: string,
      decision: PermissionDecision,
      answers?: Record<string, string>,
      updatedCommand?: string,
      inputValues?: InputValues,
      feedback?: string,
    ) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        // Updated detail (prompt cleared, decision event) arrives via
        // thread:updated pushed by the runner.
        await api.threads.respondPermission({
          threadId,
          requestId,
          decision,
          answers,
          updatedCommand,
          inputValues,
          ...(feedback ? { feedback } : {}),
        });
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId],
  );

  /**
   * Dismiss the persisted question card (issue #647). Answering it is an
   * ordinary send, which clears the card in the main process — only the
   * "no answer" path needs its own call.
   */
  const clearQuestion = useCallback(async () => {
    if (!selectedThreadId) return;
    try {
      await api.threads.clearQuestion({ threadId: selectedThreadId });
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
    }
  }, [api, selectedThreadId]);

  const setProvider = useCallback(
    async (input: {
      provider?: string;
      model?: string | null;
      threadId?: string;
    }) => {
      const threadId = input.threadId ?? selectedThreadId;
      if (!threadId) return;
      try {
        const thread = await api.threads.setProvider({
          threadId,
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setReasoningEffort = useCallback(
    async (effort: ReasoningEffort | null, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return;
      try {
        const thread = await api.threads.setReasoningEffort({
          threadId,
          effort,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setWebSearch = useCallback(
    async (webSearch: boolean, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return;
      try {
        const thread = await api.threads.setWebSearch({
          threadId,
          webSearch,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setArchived = useCallback(
    async (archived: boolean, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return false;
      try {
        const thread = await api.threads.setArchived({ threadId, archived });
        const next = threadsRef.current.map((t) =>
          t.id === thread.id ? thread : t,
        );
        applyThreads(next);
        // Only move selection when we archived the thread that was open.
        if (archived && selectedRef.current === threadId) {
          const nextId = nextVisibleThreadId(next, threadId);
          setSelectedThreadId(nextId);
          if (nextId == null) setDetail(null);
        } else if (selectedRef.current === threadId) {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
        return true;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return false;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setSettled = useCallback(
    async (
      threadId: string,
      override: "settled" | "active" | null,
    ) => {
      try {
        const thread = await api.threads.setSettled({ threadId, override });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setPinned = useCallback(
    async (threadId: string, pinned: boolean) => {
      try {
        const thread = await api.threads.setPinned({ threadId, pinned });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setSnoozed = useCallback(
    async (threadId: string, until: number | null) => {
      try {
        const thread = await api.threads.setSnoozed({ threadId, until });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setTags = useCallback(
    async (threadId: string, tags: string[]) => {
      try {
        const thread = await api.threads.setTags({ threadId, tags });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setThreadProject = useCallback(
    async (threadId: string, projectId: string) => {
      try {
        const thread = await api.threads.setThreadProject({
          threadId,
          projectId,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id
            ? { ...prev, thread }
            : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setMuted = useCallback(
    async (threadId: string, muted: boolean) => {
      try {
        const thread = await api.threads.setMuted({ threadId, muted });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setEjected = useCallback(
    async (threadId: string, ejected: boolean) => {
      try {
        const thread = await api.threads.setEjected({ threadId, ejected });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setCrossThreadInbound = useCallback(
    async (
      threadId: string,
      policy: "accept" | "queue-only" | "refuse",
    ) => {
      try {
        const thread = await api.threads.setCrossThreadInbound({
          threadId,
          policy,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setQuotaWaitAutoResume = useCallback(
    async (threadId: string, enabled: boolean | null) => {
      try {
        const thread = await api.threads.setQuotaWaitAutoResume({
          threadId,
          enabled,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const resumeQuotaWait = useCallback(
    async (threadId: string) => {
      try {
        await api.runs.resumeQuotaWait({ threadId });
        const d = await api.threads.get(threadId);
        if (selectedRef.current !== threadId) return;
        setDetail(d);
        applyThreads(
          threadsRef.current.map((t) =>
            t.id === d.thread.id ? d.thread : t,
          ),
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      try {
        const thread = await api.threads.rename({ threadId, title });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setNotes = useCallback(
    async (threadId: string, notes: string) => {
      try {
        const thread = await api.threads.setNotes({ threadId, notes });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, applyThreads],
  );

  const setMessagePins = useCallback(
    async (
      threadId: string,
      pins: ThreadMessagePin[],
    ) => {
      try {
        const thread = await api.threads.setMessagePins({ threadId, pins });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, applyThreads],
  );

  const setBaseBranch = useCallback(
    async (threadId: string, baseBranch: string | null) => {
      try {
        const thread = await api.threads.setBaseBranch({ threadId, baseBranch });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, applyThreads],
  );

  const setPendingWorktree = useCallback(
    async (threadId: string, worktree: boolean, fromOrigin?: boolean) => {
      try {
        const thread = await api.threads.setPendingWorktree({
          threadId,
          worktree,
          ...(fromOrigin === undefined ? {} : { fromOrigin }),
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, applyThreads],
  );

  const refreshWorkerSnapshot = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.refreshWorkerSnapshot({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, applyThreads],
  );

  const resolveSuggestion = useCallback(
    async (
      threadId: string,
      suggestionId: string,
      status: Exclude<WorkSuggestionStatus, "open">,
      extra?: { startedThreadId?: string; issueNumber?: number },
    ) => {
      try {
        const thread = await api.threads.resolveSuggestion({
          threadId,
          suggestionId,
          status,
          ...extra,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const setFeltEstimate = useCallback(
    async (threadId: string, savedMs: number | null) => {
      try {
        const thread = await api.threads.setFeltEstimate({ threadId, savedMs });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const startSpec = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.startSpec({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const stopSpec = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.stopSpec({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const reviewSpec = useCallback(
    async (
      threadId: string,
      decision: "approve" | "revise",
      feedback?: string,
    ) => {
      try {
        const thread = await api.threads.reviewSpec({
          threadId,
          decision,
          feedback,
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const specArtifact = useCallback(
    (threadId: string, stage: SpecArtifact) =>
      api.threads.specArtifact({ threadId, stage }),
    [api],
  );

  const dispatchSpec = useCallback(
    async (threadId: string) => {
      try {
        const result = await api.threads.dispatchSpec({ threadId });
        const thread = result.thread;
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const convergeSpec = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.convergeSpec({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const startTeach = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.startTeach({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const stopTeach = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.stopTeach({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const startAsk = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.startAsk({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const stopAsk = useCallback(
    async (threadId: string, opts?: { worktree?: boolean }) => {
      try {
        const thread = await api.threads.stopAsk({
          threadId,
          ...(opts?.worktree ? { worktree: true } : {}),
        });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const dismissBtw = useCallback(
    async (threadId: string, id: string) => {
      try {
        const thread = await api.threads.dismissBtw({ threadId, id });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const promoteBtw = useCallback(
    async (threadId: string, id: string) => {
      try {
        const thread = await api.threads.promoteBtw({ threadId, id });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  const requestTeachReview = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.threads.requestTeachReview({ threadId });
        applyThreads(
          threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
        );
        setDetail((prev) =>
          prev && prev.thread.id === thread.id ? { ...prev, thread } : prev,
        );
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, applyThreads],
  );

  return {
    stopRun,
    setPermissionMode,
    respondPermission,
    clearQuestion,
    setProvider,
    setReasoningEffort,
    setWebSearch,
    setArchived,
    setSettled,
    setPinned,
    setSnoozed,
    setTags,
    setThreadProject,
    setMuted,
    setEjected,
    setCrossThreadInbound,
    setQuotaWaitAutoResume,
    resumeQuotaWait,
    renameThread,
    setNotes,
    setMessagePins,
    setBaseBranch,
    setPendingWorktree,
    refreshWorkerSnapshot,
    resolveSuggestion,
    setFeltEstimate,
    startSpec,
    stopSpec,
    reviewSpec,
    specArtifact,
    dispatchSpec,
    convergeSpec,
    startTeach,
    stopTeach,
    startAsk,
    stopAsk,
    dismissBtw,
    promoteBtw,
    requestTeachReview,
  };
}
