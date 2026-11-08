import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UseCoderResult } from "../useCoder";
import { allTags } from "../sidebarFilters";
import { DEFAULT_RECORDING_PRIVACY, parseRecordingPrivacy, RECORDING_PRIVACY_KEY, recordingVisibility, type RecordingPrivacy } from "../recordingPrivacy";

export function useRecordingPrivacy(coder: UseCoderResult) {
  const [privacy, setPrivacy] = useState<RecordingPrivacy>(() => {
    try { return parseRecordingPrivacy(window.localStorage.getItem(RECORDING_PRIVACY_KEY)); }
    catch { return DEFAULT_RECORDING_PRIVACY; }
  });
  const updatePrivacy = useCallback((next: RecordingPrivacy) => {
    setPrivacy(next);
    try { window.localStorage.setItem(RECORDING_PRIVACY_KEY, JSON.stringify(next)); } catch { /* Session still works without storage. */ }
  }, []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === RECORDING_PRIVACY_KEY || event.key === null) {
        setPrivacy(parseRecordingPrivacy(event.key === null ? null : event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const visibility = useMemo(() => recordingVisibility(coder.threads, privacy), [coder.threads, privacy]);
  const latest = useRef(visibility);
  latest.current = visibility;
  const reads = useMemo(() => {
    const visible = (id: string) => latest.current.visible(id);
    const scope = (ids?: string[]) => {
      // Scope before the server cap as well as filtering replies. This also
      // guards an old request resolving after recording mode was enabled.
      const allowed = latest.current.threads.map((t) => t.id);
      return ids ? ids.filter(visible) : allowed;
    };
    const assertVisible = (id: string) => {
      if (!visible(id)) throw new Error("Thread hidden in recording mode");
    };
    return {
      selectThread: (id: string | null) => { if (id == null || visible(id)) coder.selectThread(id); },
      searchThreads: async (input: Parameters<UseCoderResult["searchThreads"]>[0]) => {
        const result = await coder.searchThreads({ ...input, ...(latest.current.enabled ? { threadIds: scope(input.threadIds) } : {}) });
        return { ...result, threads: result.threads.filter((t) => visible(t.id)) };
      },
      searchMessages: async (input: Parameters<UseCoderResult["searchMessages"]>[0]) => {
        const result = await coder.searchMessages({ ...input, ...(latest.current.enabled ? { threadIds: scope(input.threadIds) } : {}) });
        return { ...result, hits: result.hits.filter((hit) => visible(hit.threadId)) };
      },
      peekThread: async (id: string) => {
        assertVisible(id);
        const result = await coder.peekThread(id);
        assertVisible(id);
        return { ...result, thread: latest.current.presentThread(result.thread) };
      },
      listLanes: async (...args: Parameters<UseCoderResult["listLanes"]>) =>
        (await coder.listLanes(...args)).filter((lane) => visible(lane.threadId)),
      listAutomationRuns: async (id: string) => {
        const result = await coder.listAutomationRuns(id);
        return { ...result, runs: result.runs.filter((r) => visible(r.threadId)) };
      },
      listThreadSummaries: async (input?: Parameters<UseCoderResult["listThreadSummaries"]>[0]) =>
        (await coder.listThreadSummaries(input)).filter((t) => visible(t.id)),
      listCrewTasks: async (id: string) => {
        assertVisible(id);
        const result = await coder.listCrewTasks(id);
        assertVisible(id);
        return { ...result, tasks: result.tasks.filter((t) => !t.owner || visible(t.owner)) };
      },
      crewIntegration: async (id: string) => {
        assertVisible(id);
        const result = await coder.crewIntegration(id);
        assertVisible(id);
        return { ...result, workers: result.workers.filter((w) => visible(w.workerId)), receipts: result.receipts.filter((r) => visible(r.workerId)) };
      },
      listActivity: async (...args: Parameters<UseCoderResult["listActivity"]>) =>
        (await coder.listActivity(...args)).filter((r) => visible(r.threadId)),
      listDigest: async (...args: Parameters<UseCoderResult["listDigest"]>) => {
        const result = await coder.listDigest(...args);
        return { ...result, runs: result.runs.filter((r) => visible(r.threadId)) };
      },
      listUsageByDay: async () => {
        const result = await coder.listUsageByDay();
        return { ...result, threadsByDay: Object.fromEntries(Object.entries(result.threadsByDay).map(([day, rows]) => [day, Object.fromEntries(Object.entries(rows).filter(([id]) => visible(id)))])) };
      },
      api: {
        ...coder.api,
        threads: { ...coder.api.threads, pendingApprovals: async (...args: Parameters<UseCoderResult["api"]["threads"]["pendingApprovals"]>) => (await coder.api.threads.pendingApprovals(...args)).filter((r) => visible(r.threadId)) },
        fleet: { ...coder.api.fleet, evidence: async (...args: Parameters<UseCoderResult["api"]["fleet"]["evidence"]>) => {
          const result = await coder.api.fleet.evidence(...args);
          return { ...result, threads: result.threads.filter((t) => visible(t.threadId)), prs: result.prs.filter((p) => !p.threadId || visible(p.threadId)) };
        } },
        insights: { ...coder.api.insights, failureModes: async () =>
          // A sample is unattributed free text. Drop a whole mixed cluster
          // rather than exposing an error copied from a hidden thread.
          (await coder.api.insights.failureModes()).filter((m) => m.offenders.every((o) => visible(o.threadId))) },
      },
    };
  }, [coder.api, coder.selectThread, coder.searchThreads, coder.searchMessages, coder.peekThread, coder.listThreadSummaries, coder.listCrewTasks, coder.crewIntegration, coder.listActivity, coder.listDigest, coder.listUsageByDay, coder.listLanes, coder.listAutomationRuns]);

  const selectedVisible = !coder.selectedThreadId || visibility.visible(coder.selectedThreadId);
  return {
    privacy,
    updatePrivacy,
    knownTags: allTags(coder.threads),
    visibilityKey: visibility.key,
    isThreadVisible: visibility.visible,
    hiddenSelection: !selectedVisible,
    coder: {
      ...coder, ...reads,
      threads: visibility.threads,
      selectedThreadId: selectedVisible ? coder.selectedThreadId : null,
      detail: !privacy.enabled ? coder.detail : selectedVisible && coder.detail && visibility.visible(coder.detail.thread.id)
        ? { ...coder.detail, thread: visibility.presentThread(coder.detail.thread) } : null,
      error: selectedVisible ? coder.error : null,
      // Deleted rows do not carry tags, so do not show their copied titles
      // while recording. They remain available after ending recording mode.
      trashedThreads: privacy.enabled ? [] : coder.trashedThreads,
    },
  };
}
