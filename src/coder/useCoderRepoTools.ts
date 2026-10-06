import { useCallback, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  CoderApi,
  GitPullResult,
  GitRepoInfo,
  GitSyncInfo,
  ProjectInfo,
} from "../shared/ipc";
import type { TerminalApi } from "../components/TerminalPane";

/** Git sync, dev servers, merge lanes and the terminal bridge. */
export function useCoderRepoTools({
  api,
  setProjects,
}: {
  api: CoderApi;
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>;
}) {
  const gitSyncInfo = useCallback(
    async (threadId: string) => {
      try {
        return await api.git.syncInfo({ threadId });
      } catch {
        return { hasUpstream: false } as GitSyncInfo;
      }
    },
    [api],
  );

  const listDevScripts = useCallback(
    async (threadId: string) => {
      try {
        return await api.devserver.scripts({ threadId });
      } catch {
        return [];
      }
    },
    [api],
  );

  const gitFetch = useCallback(
    async (threadId: string) => {
      await api.git.fetch({ threadId });
    },
    [api],
  );

  const gitRepoInfo = useCallback(
    async (threadId: string): Promise<GitRepoInfo> => {
      try {
        return await api.git.repoInfo({ threadId });
      } catch {
        return { ok: false };
      }
    },
    [api],
  );

  const gitPull = useCallback(
    async (threadId: string): Promise<GitPullResult> => {
      try {
        return await api.git.pull({ threadId });
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error && err.message ? err.message : "Pull failed",
        };
      }
    },
    [api],
  );

  const claimLane = useCallback(
    async (input: { threadId: string }) => {
      return api.mergeQueue.claimLane(input);
    },
    [api],
  );

  const listLanes = useCallback(
    async (input: { projectId: string }) => {
      return api.mergeQueue.listLanes(input);
    },
    [api],
  );

  const previewLane = useCallback(
    async (input: { projectId: string; lane: number }) => {
      return api.mergeQueue.previewLane(input);
    },
    [api],
  );

  const restorePreview = useCallback(
    async (input: { projectId: string }) => {
      return api.mergeQueue.restorePreview(input);
    },
    [api],
  );

  const recycleWedgedLanes = useCallback(
    async (input: { projectId: string }) => {
      return api.mergeQueue.recycleWedgedLanes(input);
    },
    [api],
  );

  const setSpotlight = useCallback(
    async (input: { projectId: string; enabled: boolean }) => {
      const result = await api.mergeQueue.setSpotlight(input);
      try {
        setProjects(await api.projects.list());
      } catch {
        // Keep the local checkbox; list refresh is best-effort.
      }
      return result;
    },
    [api],
  );

  const spotlightLane = useCallback(
    async (input: { projectId: string; lane: number }) => {
      return api.mergeQueue.spotlightLane(input);
    },
    [api],
  );

  const heartbeatLane = useCallback(
    async (input: { threadId: string; now?: number }) => {
      return api.mergeQueue.heartbeatLane(input);
    },
    [api],
  );

  const startDevServer = useCallback(
    async (threadId: string, script: string) => {
      return api.devserver.start({ threadId, script });
    },
    [api],
  );

  const stopDevServer = useCallback(
    async (threadId: string) => {
      return api.devserver.stop({ threadId });
    },
    [api],
  );

  const devServerStatus = useCallback(
    async (threadId: string) => {
      return api.devserver.status({ threadId });
    },
    [api],
  );

  const terminal = useMemo<TerminalApi>(
    () => ({
      ...api.terminal,
      onData: (cb) => api.on("terminal:data", cb),
    }),
    [api],
  );

  return {
    gitSyncInfo,
    listDevScripts,
    gitFetch,
    gitRepoInfo,
    gitPull,
    claimLane,
    listLanes,
    previewLane,
    restorePreview,
    recycleWedgedLanes,
    setSpotlight,
    spotlightLane,
    heartbeatLane,
    startDevServer,
    stopDevServer,
    devServerStatus,
    terminal,
  };
}
