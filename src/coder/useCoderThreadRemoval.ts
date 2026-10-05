import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  CoderApi,
  ProjectInfo,
  ThreadDetail,
  ThreadInfo,
} from "../shared/ipc";
import type { CoderError } from "../useCoder";
import type { ThreadDetailCache } from "../threadDetailCache";
import { errorMessage } from "./errorMessage";
import { nextVisibleThreadId } from "../threadSelection";

/** Trash/restore/purge a thread and remove a project, moving selection off it. */
export function useCoderThreadRemoval({
  api,
  selectedThreadId,
  setSelectedThreadId,
  setProjects,
  setDetail,
  setError,
  selectedRef,
  threadsRef,
  detailCacheRef,
  refreshTrashed,
  applyThreads,
}: {
  api: CoderApi;
  selectedThreadId: string | null;
  setSelectedThreadId: Dispatch<SetStateAction<string | null>>;
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>;
  setDetail: Dispatch<SetStateAction<ThreadDetail | null>>;
  setError: Dispatch<SetStateAction<CoderError | null>>;
  selectedRef: RefObject<string | null>;
  threadsRef: RefObject<ThreadInfo[]>;
  detailCacheRef: RefObject<ThreadDetailCache>;
  refreshTrashed: () => void;
  applyThreads: (next: ThreadInfo[]) => void;
}) {
  const deleteThread = useCallback(async () => {
    if (!selectedThreadId) return false;
    const threadId = selectedThreadId;
    try {
      await api.threads.delete({ threadId });
      const list = await api.threads.list();
      applyThreads(list);
      refreshTrashed();
      if (selectedRef.current === threadId) {
        const nextId = nextVisibleThreadId(list, threadId);
        setSelectedThreadId(nextId);
        setDetail(null);
      }
      setError(null);
      return true;
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
      return false;
    }
  }, [api, selectedThreadId, applyThreads, refreshTrashed]);

  const restoreThread = useCallback(
    async (threadId: string) => {
      const id = String(threadId ?? "");
      if (!id) return false;
      try {
        const thread = await api.threads.restore({ threadId: id });
        const list = await api.threads.list();
        applyThreads(list);
        refreshTrashed();
        setSelectedThreadId(thread.id);
        setError(null);
        return true;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return false;
      }
    },
    [api, applyThreads, refreshTrashed],
  );

  const purgeThread = useCallback(
    async (threadId: string) => {
      const id = String(threadId ?? "");
      if (!id) return false;
      try {
        await api.threads.purge({ threadId: id });
        const list = await api.threads.list();
        applyThreads(list);
        refreshTrashed();
        if (selectedRef.current === id) {
          const nextId = nextVisibleThreadId(list, id);
          setSelectedThreadId(nextId);
          setDetail(null);
        }
        setError(null);
        return true;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return false;
      }
    },
    [api, applyThreads, refreshTrashed],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      const pid = String(projectId ?? "");
      if (!pid) return;
      // Capture whether the open thread belongs to this project BEFORE the
      // remove — same "was the selected one the victim?" posture as deleteThread.
      const openId = selectedRef.current;
      const openBelongs =
        openId != null &&
        threadsRef.current.some(
          (t) => t.id === openId && t.projectId === pid,
        );
      try {
        await api.projects.remove({ projectId: pid });
        const [nextProjects, list] = await Promise.all([
          api.projects.list(),
          api.threads.list(),
        ]);
        setProjects(nextProjects);
        applyThreads(list);
        detailCacheRef.current.dropProject(pid);
        // Match deleteThread: only hand off when the selected thread was the
        // one that just vanished (here: lived in the removed project).
        if (openBelongs && openId != null && selectedRef.current === openId) {
          const nextId = nextVisibleThreadId(list, openId);
          setSelectedThreadId(nextId);
          setDetail(null);
        }
        setError(null);
      } catch (err) {
        // Re-throw so the App can show the error toast; do not swallow.
        throw err instanceof Error ? err : new Error(errorMessage(err));
      }
    },
    [api, applyThreads],
  );

  return {
    deleteThread,
    restoreThread,
    purgeThread,
    removeProject,
  };
}
