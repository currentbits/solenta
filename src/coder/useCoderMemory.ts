import { useCallback } from "react";
import type {
  CoderApi,
  MemoryCitation,
  MemoryEntryInfo,
  MemoryReviewResolution,
} from "../shared/ipc";

/** Shared memory and code-map reads/writes (IPC pass-throughs). */
export function useCoderMemory(api: CoderApi) {
  const searchMemory = useCallback(
    async (input: {
      query: string;
      project?: string;
      type?: MemoryEntryInfo["type"];
    }) => {
      return api.memory.search(input);
    },
    [api],
  );

  const recentMemory = useCallback(
    async (input?: {
      limit?: number;
      offset?: number;
      project?: string;
      type?: MemoryEntryInfo["type"];
    }) => {
      const wantLimit =
        input?.limit != null && input.limit > 0 ? Math.floor(input.limit) : 20;
      const offset =
        input?.offset != null && input.offset > 0 ? Math.floor(input.offset) : 0;
      const project =
        input?.project != null && input.project !== ""
          ? input.project
          : undefined;
      const type = input?.type;
      const list = await api.memory.recent({
        limit: wantLimit,
        ...(offset > 0 ? { offset } : {}),
        ...(project ? { project } : {}),
        ...(type ? { type } : {}),
      });
      return list.slice(0, wantLimit);
    },
    [api],
  );

  const getMemory = useCallback(
    async (input: { id: string }) => {
      return api.memory.get(input);
    },
    [api],
  );

  const updateMemory = useCallback(
    async (input: { id: string; title: string; body: string }) => {
      return api.memory.update(input);
    },
    [api],
  );

  const removeMemory = useCallback(
    async (input: { id: string }) => {
      return api.memory.remove(input);
    },
    [api],
  );

  const storeMemory = useCallback(
    async (input: {
      type: MemoryEntryInfo["type"];
      title: string;
      body: string;
      project?: string;
      citations?: MemoryCitation[];
    }) => {
      return api.memory.store(input);
    },
    [api],
  );

  const maintenanceMemory = useCallback(
    async (input?: { project?: string; summary?: boolean }) => {
      return api.memory.maintenance(input);
    },
    [api],
  );

  const resolveMemory = useCallback(
    async (input: { id: number; resolution: MemoryReviewResolution }) => {
      return api.memory.resolve(input);
    },
    [api],
  );

  const loadCodeMap = useCallback(
    async (input: { projectId: string }) => {
      return api.projects.codeMap(input);
    },
    [api],
  );

  return {
    searchMemory,
    recentMemory,
    getMemory,
    updateMemory,
    removeMemory,
    storeMemory,
    maintenanceMemory,
    resolveMemory,
    loadCodeMap,
  };
}
