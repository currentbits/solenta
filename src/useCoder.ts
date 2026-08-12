import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AppStatus,
  CheckpointInfo,
  CoderApi,
  DiffResult,
  MemoryEntryInfo,
  PermissionMode,
  PrInfo,
  ProjectInfo,
  ProviderInfo,
  ReasoningEffort,
  ThreadDetail,
  ThreadInfo,
  WorkflowTemplateInfo,
} from "./shared/ipc";
import { resolveCoderApi } from "./coderApi";
import { isWebMode } from "./shared/wire";
import { nextVisibleThreadId } from "./threadSelection";

const STATUS_POLL_MS = 60_000;

export type WorkflowSaveInput = Omit<WorkflowTemplateInfo, "id" | "builtin"> & {
  id?: string;
};

function resolveApi(): CoderApi {
  return resolveCoderApi();
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
  /** Native: folder picker. Web: pass a filesystem path (projects.add). */
  addProject: (path?: string) => Promise<ProjectInfo | null>;
  /** Create in projectId when given; otherwise the currently selected project. */
  createThread: (
    title?: string,
    projectId?: string,
  ) => Promise<ThreadInfo | null>;
  /**
   * Fork / hand off a thread (threads.fork). Selects the new thread the same
   * way createThread does. Plain fork: no provider override. Hand-off: pass
   * provider (and optional model). Errors surface via error scope "run".
   */
  forkThread: (
    threadId: string,
    opts?: { provider?: string; model?: string | null },
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
  /** Set reasoning effort on the selected thread (selectedRef-guarded). */
  setReasoningEffort: (effort: ReasoningEffort | null) => Promise<void>;
  /**
   * Archive or unarchive a thread. Defaults to the selected thread.
   * Pass threadId when undoing archive after selection has already moved.
   * Archiving the selected thread moves selection off it.
   */
  setArchived: (archived: boolean, threadId?: string) => Promise<void>;
  /**
   * Set the settle override for a thread (sidebar hover action).
   * Does not require the thread to be selected.
   */
  setSettled: (
    threadId: string,
    override: "settled" | "active" | null,
  ) => Promise<void>;
  /** Pin or unpin a thread (sidebar hover). Does not require selection. */
  setPinned: (threadId: string, pinned: boolean) => Promise<void>;
  /**
   * Snooze until an epoch ms, or clear with null. Does not require selection.
   */
  setSnoozed: (threadId: string, until: number | null) => Promise<void>;
  /** Permanently delete the selected thread (after caller confirms). */
  deleteThread: () => Promise<void>;
  /**
   * Remove a project ENTRY and its threads' history (after caller confirms).
   * Repo on disk is never touched. On success refreshes projects + threads;
   * if the open thread belonged to that project, selection hands off exactly
   * like deleteThread (nextVisibleThreadId + clear detail). Rejects on
   * failure so the caller can show an error toast.
   */
  removeProject: (projectId: string) => Promise<void>;
  setupWorktree: () => Promise<ThreadInfo | null>;
  mergeWorktree: () => Promise<ThreadInfo | null>;
  removeWorktree: (force?: boolean) => Promise<ThreadInfo | null>;
  fetchDiff: () => Promise<DiffResult>;
  /** Commit all changes in the selected thread's cwd. */
  commitChanges: (message: string) => Promise<{ subject: string }>;
  /** Discard one changed file in the selected thread's cwd. */
  revertFile: (path: string, status: string) => Promise<{ path: string }>;
  /** Draft a commit message with the thread's provider (never commits). */
  suggestCommitMessage: () => Promise<{ message: string }>;
  /** File paths for the composer @-mention popup. */
  listFiles: (query: string) => Promise<string[]>;
  /** Push the selected thread's branch to origin. */
  pushBranch: () => Promise<{ remote: string; branch: string }>;
  /** Open (or re-return) a GitHub PR for the selected thread's branch. */
  createPr: (input: {
    title: string;
    body?: string;
    draft?: boolean;
  }) => Promise<PrInfo>;
  /** Live PR for the selected thread's branch, or null when none. */
  prStatus: () => Promise<PrInfo | null>;
  /** Worktree checkpoints for a thread (newest-first). */
  listCheckpoints: (threadId: string) => Promise<CheckpointInfo[]>;
  /** Hard-reset the thread worktree to a checkpoint sha. */
  restoreCheckpoint: (threadId: string, sha: string) => Promise<void>;
  /** Live spend + memory server status. */
  appStatus: AppStatus | null;
  /** Persisted app settings (daily budget). */
  settings: AppSettings | null;
  /** Patch settings; updates local state from the returned value. */
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** Re-fetch app.status() (e.g. after a run settles). */
  refreshStatus: () => Promise<void>;
  projectById: Map<string, ProjectInfo>;
  /** Thin memory passthroughs; callers hold list/search state locally. */
  searchMemory: (input: {
    query: string;
    project?: string;
  }) => Promise<MemoryEntryInfo[]>;
  recentMemory: (input?: {
    limit?: number;
    project?: string;
  }) => Promise<MemoryEntryInfo[]>;
  getMemory: (input: { id: string }) => Promise<MemoryEntryInfo>;
  updateMemory: (input: {
    id: string;
    title: string;
    body: string;
  }) => Promise<{ id: string }>;
  removeMemory: (input: { id: string }) => Promise<void>;
  storeMemory: (input: {
    type: MemoryEntryInfo["type"];
    title: string;
    body: string;
    project?: string;
  }) => Promise<{ id: string }>;
  /** Full-content thread search (titles + message text); Sidebar owns debounce/state. */
  searchThreads: (input: { query: string }) => Promise<ThreadInfo[]>;
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
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const selectedRef = useRef<string | null>(null);
  /** Bumped on every threads:changed push so a late initial list cannot clobber it. */
  const threadsListGen = useRef(0);
  const threadsRef = useRef<ThreadInfo[]>([]);
  /** Prior status by thread id; used to detect working → settled for spend refresh. */
  const prevStatusRef = useRef<Map<string, ThreadInfo["status"]>>(new Map());

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

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.app.status();
      setAppStatus(status);
    } catch {
      // Status is best-effort for the spend meter; ignore transient failures.
    }
  }, [api]);

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
      const prev = prevStatusRef.current.get(next.thread.id);
      prevStatusRef.current.set(next.thread.id, next.thread.status);
      applyThreads(
        threadsRef.current.map((t) =>
          t.id === next.thread.id ? next.thread : t,
        ),
      );
      if (selectedRef.current === next.thread.id) {
        setDetail(next);
      }
      // Refresh spend when a thread leaves "working" (run finished or stopped).
      if (prev === "working" && next.thread.status !== "working") {
        void refreshStatus();
      }
    });

    const loadGen = threadsListGen.current;

    (async () => {
      try {
        // status/settings are best-effort: missing IPC handlers (merge before
        // backend) must not blank the whole boot (no catch on this IIFE).
        const [p, list, prov, wfs, status, sett] = await Promise.all([
          api.projects.list(),
          api.threads.list(),
          api.providers.list(),
          api.workflows.list(),
          api.app.status().catch(() => null),
          api.settings.get().catch(() => null),
        ]);
        if (cancelled) return;
        setProjects(p);
        setProviders(prov);
        setWorkflows(wfs);
        if (status != null) setAppStatus(status);
        if (sett != null) setSettings(sett);
        for (const t of list) {
          prevStatusRef.current.set(t.id, t.status);
        }
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

    // Shared 60s interval for the spend meter (same pattern as sidebar age tick).
    const statusHandle = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);

    return () => {
      cancelled = true;
      unsubChanged?.();
      unsubUpdated?.();
      window.clearInterval(statusHandle);
    };
  }, [api, applyThreads, refreshStatus]);

  // Load ThreadDetail when selection changes. threads.get stamps lastVisitedAt
  // (select = visit); merge the returned row into the list so the sidebar
  // unread dot clears without waiting for a separate threads:changed push.
  useEffect(() => {
    if (!selectedThreadId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await api.threads.get(selectedThreadId);
        if (cancelled) return;
        setDetail(d);
        applyThreads(
          threadsRef.current.map((t) =>
            t.id === d.thread.id ? d.thread : t,
          ),
        );
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, selectedThreadId, applyThreads]);

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

  const addProject = useCallback(async (path?: string) => {
    try {
      const trimmed = typeof path === "string" ? path.trim() : "";
      // Native folder picker cannot run without Electron. Web callers must
      // pass a path (the path-input modal). Never fall through to addViaDialog.
      if (isWebMode() && !trimmed) return null;
      const p = trimmed
        ? await api.projects.add(trimmed)
        : await api.projects.addViaDialog();
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

  const forkThread = useCallback(
    async (
      threadId: string,
      opts?: { provider?: string; model?: string | null },
    ) => {
      try {
        const input: {
          threadId: string;
          provider?: string;
          model?: string | null;
        } = { threadId };
        if (opts && Object.prototype.hasOwnProperty.call(opts, "provider")) {
          input.provider = opts.provider;
        }
        if (opts && Object.prototype.hasOwnProperty.call(opts, "model")) {
          input.model = opts.model;
        }
        const t = await api.threads.fork(input);
        // Same selection path as createThread: prepend row, select new id.
        const next = threadsRef.current.some((x) => x.id === t.id)
          ? threadsRef.current.map((x) => (x.id === t.id ? t : x))
          : [t, ...threadsRef.current];
        applyThreads(next);
        setSelectedThreadId(t.id);
        setError(null);
        return t;
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
        return null;
      }
    },
    [api, applyThreads],
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

  const setReasoningEffort = useCallback(
    async (effort: ReasoningEffort | null) => {
      if (!selectedThreadId) return;
      const threadId = selectedThreadId;
      try {
        const thread = await api.threads.setReasoningEffort({
          threadId,
          effort,
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
    async (archived: boolean, threadIdArg?: string) => {
      const threadId = threadIdArg ?? selectedThreadId;
      if (!threadId) return;
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
      } catch (err) {
        setError({ scope: "run", message: errorMessage(err) });
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

  const commitChanges = useCallback(
    async (message: string) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      return api.git.commit({ threadId, message });
    },
    [api, selectedThreadId],
  );

  const revertFile = useCallback(
    async (path: string, status: string) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      return api.git.revertFile({ threadId, path, status });
    },
    [api, selectedThreadId],
  );

  const suggestCommitMessage = useCallback(async () => {
    if (!selectedThreadId) {
      throw new Error("No thread selected");
    }
    const threadId = selectedThreadId;
    return api.git.suggestCommitMessage({ threadId });
  }, [api, selectedThreadId]);

  const listFiles = useCallback(
    async (query: string) => {
      if (!selectedThreadId) return [];
      const threadId = selectedThreadId;
      const result = await api.files.list({ threadId, query });
      return result.files;
    },
    [api, selectedThreadId],
  );

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
    async (input: { title: string; body?: string; draft?: boolean }) => {
      if (!selectedThreadId) {
        throw new Error("No thread selected");
      }
      const threadId = selectedThreadId;
      const pr = await api.git.createPr({
        threadId,
        title: input.title,
        body: input.body,
        draft: input.draft,
      });
      if (selectedRef.current !== threadId) return pr;
      // createPr records prNumber/prUrl on the thread; refresh so the badge updates.
      const d = await api.threads.get(threadId);
      if (selectedRef.current === threadId) {
        applyThreadUpdate(d.thread);
        setDetail(d);
      }
      return pr;
    },
    [api, selectedThreadId, applyThreadUpdate],
  );

  const prStatus = useCallback(async () => {
    if (!selectedThreadId) return null;
    return api.git.prStatus({ threadId: selectedThreadId });
  }, [api, selectedThreadId]);

  const listCheckpoints = useCallback(
    async (threadId: string) => {
      return api.git.listCheckpoints({ threadId });
    },
    [api],
  );

  const restoreCheckpoint = useCallback(
    async (threadId: string, sha: string) => {
      await api.git.restoreCheckpoint({ threadId, sha });
    },
    [api],
  );

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await api.settings.set(patch);
      setSettings(next);
      // Budget changes may affect how the meter is rendered.
      await refreshStatus();
      return next;
    },
    [api, refreshStatus],
  );

  const searchMemory = useCallback(
    async (input: { query: string; project?: string }) => {
      return api.memory.search(input);
    },
    [api],
  );

  const recentMemory = useCallback(
    async (input?: { limit?: number; project?: string }) => {
      const wantLimit =
        input?.limit != null && input.limit > 0 ? Math.floor(input.limit) : 20;
      const project =
        input?.project != null && input.project !== ""
          ? input.project
          : undefined;
      // Electron proxy may still ignore project on recent. Over-fetch so a
      // client-side filter can still surface project rows buried past limit 20.
      // The server canonicalizes the project key (display slugs like
      // "owner/repo" and cwd paths both map to the repo-root basename), so it
      // is authoritative: a client-side equality filter here would compare the
      // canonical key against the raw display slug and drop every row.
      const list = await api.memory.recent({
        limit: wantLimit,
        ...(project ? { project } : {}),
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
    }) => {
      return api.memory.store(input);
    },
    [api],
  );

  const searchThreads = useCallback(
    async (input: { query: string }) => {
      return api.threads.search(input);
    },
    [api],
  );

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
    forkThread,
    startRun,
    startWorkflowRun,
    saveWorkflow,
    removeWorkflow,
    refreshWorkflows,
    stopRun,
    setPermissionMode,
    setProvider,
    setReasoningEffort,
    setArchived,
    setSettled,
    setPinned,
    setSnoozed,
    deleteThread,
    removeProject,
    setupWorktree,
    mergeWorktree,
    removeWorktree,
    fetchDiff,
    commitChanges,
    revertFile,
    suggestCommitMessage,
    listFiles,
    pushBranch,
    createPr,
    prStatus,
    listCheckpoints,
    restoreCheckpoint,
    appStatus,
    settings,
    saveSettings,
    refreshStatus,
    projectById,
    searchMemory,
    recentMemory,
    getMemory,
    updateMemory,
    removeMemory,
    storeMemory,
    searchThreads,
  };
}
