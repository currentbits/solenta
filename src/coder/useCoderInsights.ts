import { useCallback } from "react";
import type { CoderApi, ThreadSummariesInput } from "../shared/ipc";

/** Activity, usage, digest, thread summaries and crew reads (IPC pass-throughs). */
export function useCoderInsights(api: CoderApi) {
  const listActivity = useCallback(async () => {
    return api.activity.list();
  }, [api]);

  const listUsageByDay = useCallback(async () => {
    return api.usage.byDay();
  }, [api]);

  const listProviderLimits = useCallback(async () => {
    return api.usage.providerLimits();
  }, [api]);

  const listDigest = useCallback(async (input?: { sinceMs?: number }) => {
    return api.digest.list(input);
  }, [api]);

  const markDigestSeen = useCallback(async () => {
    return api.digest.markSeen();
  }, [api]);

  const listThreadSummaries = useCallback(
    async (input?: ThreadSummariesInput) => api.threads.summaries(input),
    [api],
  );

  const listCrewTasks = useCallback(
    async (threadId: string) => {
      return api.threads.crewTasks({ threadId });
    },
    [api],
  );

  const crewIntegration = useCallback(
    async (threadId: string) => {
      return api.threads.crewIntegration({ threadId });
    },
    [api],
  );

  return {
    listActivity,
    listUsageByDay,
    listProviderLimits,
    listDigest,
    markDigestSeen,
    listThreadSummaries,
    listCrewTasks,
    crewIntegration,
  };
}
