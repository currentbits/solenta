import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CoderApi,
  DiffResult,
  PermissionMode,
  ProjectInfo,
  ProviderInfo,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "./shared/ipc";
import { devCoder } from "./devCoder";
import { nextVisibleThreadId } from "./threadSelection";

export type WorkflowSaveInput = Omit<WorkflowTemplateInfo, "id" | "builtin"> & {
  id?: string;
};

function resolveApi(): CoderApi {
  const w = window as unknown as { coder?: CoderApi };
  return w.coder ?? devCoder;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export type CoderErrorScope = "project" | "run";

export interface CoderError {
  scope: CoderErrorScope;
  message: string;
}

export interface UseCoderResult {
  api: CoderApi;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  /** Provider registry loaded once at startup. */
  providers: ProviderInfo[];
  /** Workflow templates loaded at startup; refreshed after save/remove. */
  workflows: WorkflowTemplateInfo[];
  selectedThreadId: string | null;
  selectThread: (id: string | null) => void;
  detail: ThreadDetail | null;
  loading: boolean;
  /** Project of the selected thread, or first project if none selected. */
  selectedProjectId: string | null;
  error: CoderError | null;
  clearError: () => void;
  addProject: () => Promise<ProjectInfo | null>;
  /** Create in projectId when given; otherwise the currently selected project. */
  createThread: (
    title?: string,
    projectId?: string,
  ) => Promise<ThreadInfo | null>;
  startRun: (prompt: string) => Promise<void>;
  /**
   * Multi-phase Build workflow for the selected thread. Passes templateId to
   * runs.startWorkflow (backend validates phase providers).
   */
  startWorkflowRun: (prompt: string, templateId?: string) => Promise<void>;
  /** Persist a workflow template; refreshes the list. Saving a builtin creates a copy. */
  saveWorkflow: (template: WorkflowSaveInput) => Promise<WorkflowTemplateInfo>;
  /** Remove a non-builtin template; refreshes the list. */
  removeWorkflow: (id: string) => Promise<void>;
  /** Reload workflows.list() into state. */
  refreshWorkflows: () => Promise<void>;
  stopRun: () => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  /** Set provider and/or model on the selected thread (selectedRef-guarded). */
  setProvider: (input: {
    provider?: string;
    model?: string | null;
  }) => Promise<void>;
  /** Archive or unarchive the selected thread. Archiving moves selection off it. */
  setArchived: (archived: boolean) => Promise<void>;
  /** Permanently delete the selected thread (after caller confirms). */
  deleteThread: () => Promise<void>;
  setupWorktree: () => Promise<ThreadInfo | null>;
  mergeWorktree: () => Promise<ThreadInfo | null>;
  removeWorktree: (force?: boolean) => Promise<ThreadInfo | null>;
  fetchDiff: () => Promise<DiffResult>;
  projectById: Map<string, ProjectInfo>;
}

export function useCoder(): UseCoderResult {
  const api = useMemo(() => resolveApi(), []);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowTemplateInfo[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CoderError | null>(null);
  const selectedRef = useRef<string | null>(null);
  /** Bumped on every threads:changed push so a late initial list cannot clobber it. */
  const threadsListGen = useRef(0);
  const threadsRef = useRef<ThreadInfo[]>([]);

  useEffect(() => {
    selectedRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const applyThreads = useCallback((next: ThreadInfo[]) => {
    threadsRef.current = next;
    setThreads(next);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Initial load + subscriptions
  useEffect(() => {
    let cancelled = false;
    let unsubChanged: (() => void) | undefined;
    let unsubUpdated: (() => void) | undefined;

    unsubChanged = api.on("threads:changed", (next) => {
      threadsListGen.current += 1;
      applyThreads(next);
    });

    unsubUpdated = api.on("thread:updated", (next) => {
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === next.thread.id ? next.thread : t,
        ),
      );
      if (selectedRef.current === next.thread.id) {
        setDetail(next);
      }
    });

    const loadGen = threadsListGen.current;

    (async () => {
      try {
        const [p, list, prov, wfs] = await Promise.all([
          api.projects.list(),
          api.threads.list(),
          api.providers.list(),
          api.workflows.list(),
        ]);
        if (cancelled) return;
        setProjects(p);
        setProviders(prov);
        setWorkflows(wfs);
        if (threadsListGen.current === loadGen) {
          applyThreads(list);
        }
        const source =
          threadsListGen.current === loadGen ? list : threadsRef.current;
        const preferred =
          source.find((t) => !t.archived && t.status === "working")?.id ??
          source.find((t) => !t.archived)?.id ??
          null;
        setSelectedThreadId((prev) => prev ?? preferred);
        if (selectedRef.current == null && preferred) {
          selectedRef.current = preferred;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      unsubChanged?.();
      unsubUpdated?.();
    };
  }, [api, applyThreads]);

  // Load ThreadDetail when selection changes
  useEffect(() => {
    if (!selectedThreadId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await api.threads.get(selectedThreadId);
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, selectedThreadId]);

  const projectById = useMemo(() => {
    const m = new Map<string, ProjectInfo>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const selectedProjectId = useMemo(() => {
    if (selectedThreadId) {
      const t = threads.find((x) => x.id === selectedThreadId);
      if (t) return t.projectId;
    }
    return projects[0]?.id ?? null;
  }, [selectedThreadId, threads, projects]);

  const selectThread = useCallback((id: string | null) => {
    setSelectedThreadId(id);
  }, []);

  const addProject = useCallback(async () => {
    try {
      const p = await api.projects.addViaDialog();
      if (p) {
        setProjects((prev) => {
          if (prev.some((x) => x.id === p.id)) return prev;
          return [...prev, p];
        });
        setError(null);
      }
      return p;
    } catch (err) {
      setError({ scope: "project", message: errorMessage(err) });
      return null;
    }
  }, [api]);

  const createThread = useCallback(
    async (title = "New Thread", projectId?: string) => {
      const pid = projectId ?? selectedProjectId;
      if (!pid) return null;
      // Inherit provider+model from the currently selected thread when present.
      const inheritFrom = selectedRef.current
        ? threadsRef.current.find((x) => x.id === selectedRef.current)
        : undefined;
      let t = await api.threads.create({ projectId: pid, title });
      if (inheritFrom) {
        const needsProvider = inheritFrom.provider !== t.provider;
        const needsModel = inheritFrom.model !== t.model;
        if (needsProvider || needsModel) {
          t = await api.threads.setProvider({
            threadId: t.id,
            ...(needsProvider ? { provider: inheritFrom.provider } : {}),
            ...(needsModel || needsProvider
              ? { model: inheritFrom.model }
              : {}),
          });
        }
      }
      const next = threadsRef.current.some((x) => x.id === t.id)
        ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
        : [t, ...threadsRef.current];
      applyThreads(next);
      setSelectedThreadId(t.id);
      return t;
    },
    [api, selectedProjectId, applyThreads],
  );

  const startRun = useCallback(
    async (prompt: string) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        await api.runs.start({ threadId, prompt });
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

  const refreshWorkflows = useCallback(async () => {
    const list = await api.workflows.list();
    setWorkflows(list);
  }, [api]);

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

  const saveWorkflow = useCallback(
    async (template: WorkflowSaveInput) => {
      const saved = await api.workflows.save(template);
      await refreshWorkflows();
      return saved;
    },
    [api, refreshWorkflows],
  );

  const removeWorkflow = useCallback(
    async (workflowId: string) => {
      await api.workflows.remove({ id: workflowId });
      await refreshWorkflows();
    },
    [api, refreshWorkflows],
  );

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
    async (mode: PermissionMode) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        const thread = await api.threads.setPermissionMode({
          threadId,
          mode,
        });
        if (selectedRef.current !== threadId) return;
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
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setProvider = useCallback(
    async (input: { provider?: string; model?: string | null }) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        const thread = await api.threads.setProvider({
          threadId,
          ...input,
        });
        if (selectedRef.current !== threadId) return;
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
        throw err;
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const setArchived = useCallback(
    async (archived: boolean) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        const thread = await api.threads.setArchived({ threadId, archived });
        if (selectedRef.current !== threadId) return;
        const next = threadsRef.current.map((t) =>
          t.id === thread.id ? thread : t,
        );
        applyThreads(next);
        if (archived) {
          const nextId = nextVisibleThreadId(next, threadId);
          setSelectedThreadId(nextId);
          if (nextId == null) setDetail(null);
        } else {
          setDetail((prev) =>
            prev && prev.thread.id === thread.id
              ? { ...prev, thread }
              : prev,
          );
        }
        setError(null);
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
      }
    },
    [api, selectedThreadId, applyThreads],
  );

  const deleteThread = useCallback(async () => {
    if (!selectedThreadId) return;
    const threadId = selectedThreadId;
    try {
      await api.threads.delete({ threadId });
      const list = await api.threads.list();
      applyThreads(list);
      if (selectedRef.current === threadId) {
        const nextId = nextVisibleThreadId(list, threadId);
        setSelectedThreadId(nextId);
        setDetail(null);
      }
      setError(null);
    } catch (err) {
      setError({ scope: "run", message: errorMessage(err) });
    }
  }, [api, selectedThreadId, applyThreads]);

  const applyThreadUpdate = useCallback(
    (thread: ThreadInfo) => {
      applyThreads(
        threadsRef.current.map((t) => (t.id === thread.id ? thread : t)),
      );
      setDetail((prev) =>
        prev && prev.thread.id === thread.id
          ? { ...prev, thread }
          : prev,
      );
    },
    [applyThreads],
  );

  const setupWorktree = useCallback(async () => {
    if (!selectedThreadId) return null;
    const threadId = selectedThreadId;
    const thread = await api.git.setupWorktree({ threadId });
    if (selectedRef.current !== threadId) return thread;
    applyThreadUpdate(thread);
    // Refresh detail in case main also mutates other fields.
    const d = await api.threads.get(threadId);
    if (selectedRef.current === threadId) setDetail(d);
    return thread;
  }, [api, selectedThreadId, applyThreadUpdate]);

  const mergeWorktree = useCallback(async () => {
    if (!selectedThreadId) return null;
    const threadId = selectedThreadId;
    const thread = await api.git.mergeWorktree({ threadId });
    if (selectedRef.current !== threadId) return thread;
    applyThreadUpdate(thread);
    const d = await api.threads.get(threadId);
    if (selectedRef.current === threadId) setDetail(d);
    return thread;
  }, [api, selectedThreadId, applyThreadUpdate]);

  const removeWorktree = useCallback(
    async (force = false) => {
      if (!selectedThreadId) return null;
      const threadId = selectedThreadId;
      const thread = await api.git.removeWorktree({ threadId, force });
      if (selectedRef.current !== threadId) return thread;
      applyThreadUpdate(thread);
      const d = await api.threads.get(threadId);
      if (selectedRef.current === threadId) setDetail(d);
      return thread;
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const fetchDiff = useCallback(async () => {
    if (!selectedThreadId) {
      return { files: [], patch: "", truncated: false };
    }
    const threadId = selectedThreadId;
    return api.git.diff({ threadId });
  }, [api, selectedThreadId]);

  return {
    api,
    projects,
    threads,
    providers,
    workflows,
    selectedThreadId,
    selectThread,
    detail,
    loading,
    selectedProjectId,
    error,
    clearError,
    addProject,
    createThread,
    startRun,
    startWorkflowRun,
    saveWorkflow,
    removeWorkflow,
    refreshWorkflows,
    stopRun,
    setPermissionMode,
    setProvider,
    setArchived,
    deleteThread,
    setupWorktree,
    mergeWorktree,
    removeWorktree,
    fetchDiff,
    projectById,
  };
}
