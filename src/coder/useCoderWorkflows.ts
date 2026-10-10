import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AutomationInfo,
  AutomationWrite,
  CoderApi,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "../shared/ipc";
import type { CoderError, WorkflowSaveInput } from "../useCoder";
import { errorMessage } from "./errorMessage";

function upsertWorkflow(
  list: WorkflowTemplateInfo[],
  saved: WorkflowTemplateInfo,
): WorkflowTemplateInfo[] {
  const idx = list.findIndex((w) => w.id === saved.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = saved;
    return next;
  }
  return [...list, saved];
}

/** Workflow templates, automations, and workflow runs on the selected thread. */
export function useCoderWorkflows({
  api,
  selectedThreadId,
  setWorkflows,
  setWorkflowListError,
  setAutomations,
  setDetail,
  setError,
  selectedRef,
  threadsRef,
  applyThreads,
}: {
  api: CoderApi;
  selectedThreadId: string | null;
  setWorkflows: Dispatch<SetStateAction<WorkflowTemplateInfo[]>>;
  setWorkflowListError: Dispatch<SetStateAction<string | null>>;
  setAutomations: Dispatch<SetStateAction<AutomationInfo[]>>;
  setDetail: Dispatch<SetStateAction<ThreadDetail | null>>;
  setError: Dispatch<SetStateAction<CoderError | null>>;
  selectedRef: RefObject<string | null>;
  threadsRef: RefObject<ThreadInfo[]>;
  applyThreads: (next: ThreadInfo[]) => void;
}) {
  const refreshWorkflows = useCallback(async () => {
    try {
      const list = await api.workflows.list();
      setWorkflows(list);
      setWorkflowListError(null);
    } catch (err) {
      setWorkflowListError(
        `The workflow list failed to refresh: ${errorMessage(err)}`,
      );
      throw err;
    }
  }, [api]);

  const refreshAutomations = useCallback(async () => {
    const list = await api.automations.list();
    setAutomations(list);
  }, [api]);

  const addAutomation = useCallback(
    async (input: AutomationWrite) => {
      const created = await api.automations.add(input);
      await refreshAutomations();
      return created;
    },
    [api, refreshAutomations],
  );

  const updateAutomation = useCallback(
    async (input: Partial<AutomationWrite> & { id: string }) => {
      const updated = await api.automations.update(input);
      await refreshAutomations();
      return updated;
    },
    [api, refreshAutomations],
  );

  const removeAutomation = useCallback(
    async (automationId: string) => {
      await api.automations.remove({ id: automationId });
      await refreshAutomations();
    },
    [api, refreshAutomations],
  );

  const runAutomationNow = useCallback(
    async (automationId: string) => {
      try {
        return await api.automations.runNow({ id: automationId });
      } finally {
        // runNow rethrows the agent failure AFTER the main process has already
        // written lastError, so the row only shows it if we resync on the
        // throwing path too (issue #85).
        await refreshAutomations();
      }
    },
    [api, refreshAutomations],
  );

  const listAutomationRuns = useCallback(
    async (automationId: string) => {
      return api.automations.listRuns({ id: automationId });
    },
    [api],
  );

  const startWorkflowRun = useCallback(
    async (prompt: string, templateId?: string) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        await api.runs.startWorkflow({
          threadId,
          prompt,
          ...(templateId ? { templateId } : {}),
        });
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
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const retryWorkflowAgent = useCallback(
    async (agentId: string) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        await api.runs.retryWorkflowAgent({ threadId, agentId });
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
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const saveWorkflow = useCallback(
    async (template: WorkflowSaveInput) => {
      setWorkflowListError(null);
      const saved = await api.workflows.save(template);
      // Adopt the write immediately. A later list rejection must not hide
      // the new id or the next Save will create another template (#1138).
      setWorkflows((prev) => upsertWorkflow(prev, saved));
      try {
        await refreshWorkflows();
      } catch (err) {
        setWorkflowListError(
          `Saved, but the list failed to refresh: ${errorMessage(err)}`,
        );
      }
      return saved;
    },
    [api, refreshWorkflows],
  );

  const removeWorkflow = useCallback(
    async (workflowId: string) => {
      setWorkflowListError(null);
      await api.workflows.remove({ id: workflowId });
      setWorkflows((prev) => prev.filter((w) => w.id !== workflowId));
      try {
        await refreshWorkflows();
      } catch (err) {
        setWorkflowListError(
          `Removed, but the list failed to refresh: ${errorMessage(err)}`,
        );
      }
    },
    [api, refreshWorkflows],
  );

  const exportWorkflowToRepo = useCallback(
    async (workflowId: string, overwrite: boolean) => {
      if (!selectedThreadId) throw new Error("Select a thread first");
      return api.workflows.exportToRepo({
        id: workflowId,
        threadId: selectedThreadId,
        overwrite,
      });
    },
    [api, selectedThreadId],
  );

  return {
    exportWorkflowToRepo,
    refreshWorkflows,
    refreshAutomations,
    addAutomation,
    updateAutomation,
    removeAutomation,
    runAutomationNow,
    listAutomationRuns,
    startWorkflowRun,
    retryWorkflowAgent,
    saveWorkflow,
    removeWorkflow,
  };
}
