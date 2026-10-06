import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  CoderApi,
  ListPrsOptions,
  MergeMethod,
  PlanStatus,
  ThreadDetail,
  ThreadInfo,
} from "../shared/ipc";
import type { CoderError } from "../useCoder";
import { errorMessage } from "./errorMessage";
import { isCiWorkflowBlockMessage } from "../blastRadius";

/** Branch push, pull requests (selected thread and by number), PR checkout, issues. */
export function useCoderGitHub({
  api,
  selectedThreadId,
  setSelectedThreadId,
  setDetail,
  setError,
  selectedRef,
  threadsRef,
  applyThreads,
  applyThreadUpdate,
}: {
  api: CoderApi;
  selectedThreadId: string | null;
  setSelectedThreadId: Dispatch<SetStateAction<string | null>>;
  setDetail: Dispatch<SetStateAction<ThreadDetail | null>>;
  setError: Dispatch<SetStateAction<CoderError | null>>;
  selectedRef: RefObject<string | null>;
  threadsRef: RefObject<ThreadInfo[]>;
  applyThreads: (next: ThreadInfo[]) => void;
  applyThreadUpdate: (thread: ThreadInfo) => void;
}) {
  const pushBranch = useCallback(async () => {
    if (!selectedThreadId) {
      throw new Error("No thread selected");
    }
    const threadId = selectedThreadId;
    try {
      const result = await api.git.push({ threadId });
      setError(null);
      return result;
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
      throw err;
    }
  }, [api, selectedThreadId]);

  const createPr = useCallback(
    async (input: {
      title: string;
      body?: string;
      draft?: boolean;
      allowOversize?: boolean;
    }) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      try {
        const pr = await api.git.createPr({
          threadId,
          title: input.title,
          body: input.body,
          draft: input.draft,
          allowOversize: input.allowOversize,
        });
        if (selectedRef.current !== threadId) return pr;
        // createPr records prNumber/prUrl on the thread; refresh so the badge updates.
        const d = await api.threads.get(threadId);
        if (selectedRef.current === threadId) {
          applyThreadUpdate(d.thread);
          setDetail(d);
        }
        setError(null);
        return pr;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        throw err;
      }
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const prStatus = useCallback(async () => {
    const threadId = selectedThreadId;
    if (!threadId) return null;
    const pr = await api.git.prStatus({ threadId });
    // prStatus records prNumber/prUrl on the thread; refresh the open header.
    if (pr && selectedRef.current === threadId) {
      const d = await api.threads.get(threadId);
      if (selectedRef.current === threadId) {
        applyThreadUpdate(d.thread);
        setDetail(d);
      }
    }
    return pr;
  }, [api, selectedThreadId, applyThreadUpdate]);

  const prChecks = useCallback(async () => {
    if (!selectedThreadId) return { ok: false as const, reason: "no PR" };
    return api.git.prChecks({ threadId: selectedThreadId });
  }, [api, selectedThreadId]);

  const prMerge = useCallback(async (opts?: {
    ciWorkflowApproved?: boolean;
    method?: MergeMethod;
    auto?: boolean;
  }) => {
    if (!selectedThreadId) {
      throw new Error("No thread selected");
    }
    const threadId = selectedThreadId;
    try {
      const pr = await api.git.prMerge({
        threadId,
        ciWorkflowApproved: opts?.ciWorkflowApproved,
        method: opts?.method,
        auto: opts?.auto,
      });
      if (selectedRef.current !== threadId) return pr;
      const d = await api.threads.get(threadId);
      if (selectedRef.current === threadId) {
        applyThreadUpdate(d.thread);
        setDetail(d);
      }
      setError(null);
      return pr;
    } catch (err) {
      const msg = errorMessage(err);
      if (!isCiWorkflowBlockMessage(msg)) {
        setError({ scope: "run", message: msg });
      }
      throw err;
    }
  }, [api, selectedThreadId, applyThreadUpdate]);

  const listPrs = useCallback(
    async (projectPath: string, opts?: ListPrsOptions) => {
      return api.git.listPrs(projectPath, opts);
    },
    [api],
  );

  const prTemplate = useCallback(
    async (projectPath: string) => {
      return api.git.prTemplate({ projectPath });
    },
    [api],
  );

  const prDetail = useCallback(
    async (input: { projectPath: string; prNumber: number }) => {
      return api.git.prDetail(input);
    },
    [api],
  );

  const prEdit = useCallback(
    async (input: {
      projectPath: string;
      prNumber: number;
      title?: string;
      body?: string;
    }) => {
      return api.git.prEdit(input);
    },
    [api],
  );

  const prComment = useCallback(
    async (input: {
      projectPath: string;
      prNumber: number;
      body: string;
    }) => {
      return api.git.prComment(input);
    },
    [api],
  );

  const prClose = useCallback(
    async (input: { projectPath: string; prNumber: number }) => {
      return api.git.prClose(input);
    },
    [api],
  );

  const prReady = useCallback(
    async (input: {
      projectPath: string;
      prNumber: number;
      undo?: boolean;
    }) => {
      return api.git.prReady(input);
    },
    [api],
  );

  const prMergeAt = useCallback(
    async (input: { projectPath: string; prNumber: number }) => {
      return api.git.prMergeAt(input);
    },
    [api],
  );

  const checkoutPr = useCallback(
    async (input: { projectId: string; prNumber: number }) => {
      const result = await api.git.checkoutPr(input);
      if (!result.ok) return result;
      const t = result.thread;
      const next = threadsRef.current.some((x) => x.id === t.id)
        ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
        : [t, ...threadsRef.current];
      applyThreads(next);
      selectedRef.current = t.id;
      setSelectedThreadId(t.id);
      return result;
    },
    [api, applyThreads],
  );

  const listIssues = useCallback(
    async (projectPath: string) => {
      return api.issues.list(projectPath);
    },
    [api],
  );

  const setIssuePlanStatus = useCallback(
    async (projectPath: string, number: number, status: PlanStatus) => {
      return api.issues.setPlanStatus({ projectPath, number, status });
    },
    [api],
  );

  const createIssue = useCallback(
    async (projectPath: string, title: string, body: string) => {
      return api.issues.create({ projectPath, title, body });
    },
    [api],
  );

  const fetchIssue = useCallback(
    async (projectPath: string, ref: string) => {
      return api.issues.fetch({ projectPath, ref });
    },
    [api],
  );

  return {
    pushBranch,
    createPr,
    prStatus,
    prChecks,
    prMerge,
    listPrs,
    prTemplate,
    prDetail,
    prEdit,
    prComment,
    prClose,
    prReady,
    prMergeAt,
    checkoutPr,
    listIssues,
    setIssuePlanStatus,
    createIssue,
    fetchIssue,
  };
}
