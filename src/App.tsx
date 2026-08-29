import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useCoder } from "./useCoder";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { PrListView } from "./components/PrListView";
import { KanbanView } from "./components/KanbanView";
import { PlanboardView, type ThreadStartMode } from "./components/PlanboardView";
import { AutomationsView } from "./components/AutomationsView";
import { ActivityView } from "./components/ActivityView";
import { InsightsView } from "./components/InsightsView";
import { UsageView } from "./components/UsageView";
import { FleetView } from "./components/FleetView";
import { DigestView } from "./components/DigestView";
import { AgentsPanel } from "./components/AgentsPanel";
import {
  SettingsModal,
  type SettingsPane,
} from "./components/SettingsModal";
import { OnboardingModal } from "./components/onboarding/OnboardingModal";
import { ArchiveToast } from "./components/ArchiveToast";
import { AddProjectPathModal } from "./components/AddProjectPathModal";
import { EditProjectModal } from "./components/EditProjectModal";
import { WorkflowsModal } from "./components/WorkflowsModal";
import { WebTokenGate } from "./components/WebTokenGate";
import { isWebMode } from "./shared/wire";
import { isBuildMismatch } from "./buildMismatch";
import { BuildMismatchScreen } from "./components/BuildMismatchScreen";
import {
  repeatDraftFromDetail,
  type RepeatDraft,
} from "./repeatThread";
import { sameTaskPeers, toComparePeer } from "./divergence";
import {
  providerPermissionModes,
  snapToHonouredPermissionMode,
} from "./format";
import type {
  AgentProfile,
  ConflictForecast,
  DistilledWorkflow,
  ProjectUpdateInput,
  WorkSuggestion,
} from "./shared/ipc";
import styles from "./App.module.css";
import { syncTheme } from "./theme";

const EMPTY_FORECAST: ConflictForecast = { pairs: [], computedAt: 0 };
const EMPTY_AGENT_PROFILES: AgentProfile[] = [];

export type AppView =
  | "thread"
  | "kanban"
  | "planboard"
  | "prs"
  | "automations"
  | "activity"
  | "usage"
  | "fleet"
  | "insights"
  | "digest";

type DrawerId = "sidebar" | "agents";

// CSS px, so Electron zoom (settings.uiScale) is included. minWidth 1100 DIP
// at 1.6× is ~688 CSS px, already under this threshold, so the three panes
// collapse into drawers instead of crushing the thread (#652).
const NARROW_QUERY = "(max-width: 900px)";

function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getNarrow(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY).matches
    : false;
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, getNarrow, () => false);
}

const AGENTS_LAST_KEY = "coder.agents.collapsed";

function loadLastAgentsCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(AGENTS_LAST_KEY);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function saveLastAgentsCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(AGENTS_LAST_KEY, value ? "1" : "0");
  } catch {
    // Quota/private mode: last state just stops persisting.
  }
}

function agentsPanelStartsCollapsed(
  defaultState: "closed" | "open" | null | undefined,
  rememberLast?: boolean | null,
): boolean {
  if (rememberLast) {
    const last = loadLastAgentsCollapsed();
    if (last !== null) return last;
  }
  return defaultState !== "open";
}

function dialogOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector('[role="dialog"]') != null
  );
}

type AppProps = {
  /**
   * Test seam. Production reads compile-time __BUILD_SHA__; node tests
   * leave that identifier undeclared (and ESM cannot see a globalThis
   * assignment), so App-level mismatch tests pass a stamped value here.
   */
  rendererSha?: string | null;
};

export default function App({ rendererSha: rendererShaOverride }: AppProps = {}) {
  const {
    api,
    projects,
    threads,
    providers,
    workflows,
    selectedThreadId,
    selectThread,
    detail,
    detailError,
    retryDetail,
    selectedProjectId,
    error,
    clearError,
    addProject,
    createProject,
    updateProject,
    createThread,
    listBaseBranches,
    forkThread,
    startRun,
    rewindAndResubmit,
    queued,
    cancelQueued,
    retryQueued,
    editQueued,
    fetchIssue,
    startWorkflowRun,
    saveWorkflow,
    removeWorkflow,
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
    setMuted,
    setCrossThreadInbound,
    setQuotaWaitAutoResume,
    resumeQuotaWait,
    renameThread,
    setNotes,
    setBaseBranch,
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
    deleteThread,
    removeProject,
    setupWorktree,
    mergeWorktree,
    conflictContext,
    removeWorktree,
    fetchDiff,
    fetchReviewContext,
    setReviewAccepted,
    commitChanges,
    setStagedPaths,
    revertFile,
    suggestCommitMessage,
    listFiles,
    pickDirectory,
    listSnapWindows,
    captureSnapWindow,
    resolvePaths,
    openWorkspacePath,
    loadToolImage,
    pickAttachments,
    saveAttachmentImage,
    loadAttachmentImage,
    dropAttachmentFiles,
    pushBranch,
    createPr,
    prChecks,
    prMerge,
    listPrs,
    checkoutPr,
    listIssues,
    setIssuePlanStatus,
    createIssue,
    listActivity,
    listUsageByDay,
    listDigest,
    markDigestSeen,
    listThreadSummaries,
    listCrewTasks,
    listCheckpoints,
    restoreCheckpoint,
    runStats,
    conflictForecast,
    listLocalServers,
    revealInFinder,
    openInEditor,
    gitSyncInfo,
    gitFetch,
    gitRepoInfo,
    gitPull,
    listDevScripts,
    startDevServer,
    stopDevServer,
    devServerStatus,
    terminal,
    preview,
    simulator,
    simulatorStatus,
    setVerifyCommand,
    runVerify,
    runCommand,
    appStatus,
    updateStatus,
    checkUpdate,
    downloadUpdate,
    applyUpdate,
    settings,
    saveSettings,
    stayAwake,
    setStayAwakeMode,
    testWebhook,
    refreshProviders,
    projectById,
    searchMemory,
    recentMemory,
    getMemory,
    updateMemory,
    removeMemory,
    storeMemory,
    maintenanceMemory,
    resolveMemory,
    loadCodeMap,
    lintAgentConfig,
    previewAgentConfig,
    writeAgentConfig,
    listMcpServers,
    saveMcpServer,
    removeMcpServer,
    setMcpEnabled,
    listMcpCatalog,
    pickMcpImport,
    previewMcpImport,
    installMcpImport,
    discardMcpImport,
    listSkills,
    addSkill,
    removeSkill,
    syncSkills,
    listSkillCatalog,
    pickSkillImport,
    previewSkillImport,
    installSkillImport,
    discardSkillImport,
    listCliCommands,
    searchThreads,
    peekThread,
    automations,
    addAutomation,
    updateAutomation,
    removeAutomation,
    runAutomationNow,
  } = useCoder();

  useEffect(() => {
    if (!settings?.theme) return;
    return syncTheme(settings.theme);
  }, [settings?.theme]);

  const [changesOpen, setChangesOpen] = useState(false);
  const [changesNonce, setChangesNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane | null>(null);
  /** Mid-session latch so finishing the tour does not wait on settings.set. */
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  /** Relaunch from Settings even after onboardingSeen is true. */
  const [onboardingForceOpen, setOnboardingForceOpen] = useState(false);
  /** Synara-style undo toast after an immediate archive (single or bulk clear). */
  const [archiveToastIds, setArchiveToastIds] = useState<string[] | null>(null);
  /**
   * Error toast after projects.remove rejects. Title is t3-shaped:
   * Failed to remove "slug", plus the reason — swallowing it left the user
   * with no idea what to fix. Cleared on dismiss / timeout.
   */
  const [removeFailMessage, setRemoveFailMessage] = useState<string | null>(
    null,
  );
  const [addPathOpen, setAddPathOpen] = useState(false);
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("thread");
  const [planboardProjectId, setPlanboardProjectId] = useState<string | null>(null);
  const [kanbanProjectId, setKanbanProjectId] = useState<string | null>(null);
  const [activityProjectId, setActivityProjectId] = useState<string | null>(null);
  const [repeatDraft, setRepeatDraft] = useState<RepeatDraft | null>(null);
  const [workflowDraft, setWorkflowDraft] = useState<DistilledWorkflow | null>(
    null,
  );
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [distillError, setDistillError] = useState<string | null>(null);
  const [chipError, setChipError] = useState<string | null>(null);
  /** Discarded queued follow-up, handed back to the composer draft (#364). */
  const [queuedDraftRestore, setQueuedDraftRestore] = useState<{
    threadId: string;
    text: string;
  } | null>(null);
  /** Freshly created thread the Sidebar should reveal (expand/scroll/flash). */
  const [revealThreadId, setRevealThreadId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const [forecast, setForecast] = useState<ConflictForecast>(EMPTY_FORECAST);
  const narrow = useNarrow();
  const [agentsCollapsed, setAgentsCollapsed] = useState(true);
  const sidebarPaneRef = useRef<HTMLDivElement>(null);
  const agentsPaneRef = useRef<HTMLDivElement>(null);
  const threadsBtnRef = useRef<HTMLButtonElement>(null);
  const agentsBtnRef = useRef<HTMLButtonElement>(null);
  const agentsExpandRef = useRef<HTMLButtonElement>(null);
  const lastDrawerRef = useRef<DrawerId | null>(null);
  const collapseSourceRef = useRef<"user" | null>(null);
  const rememberLastRef = useRef(false);
  const appliedPanelDefaultRef = useRef<"closed" | "open" | null>(null);
  rememberLastRef.current = settings?.agentsPanelRememberLast === true;
  const hideAgentsRail = agentsCollapsed && !narrow;

  const handleSelectThread = useCallback(
    (id: string) => {
      setView("thread");
      setDrawer(null);
      selectThread(id);
    },
    [selectThread],
  );

  // The three panes are memo'd (issue #91): a 700ms stream tick must only
  // re-render the pane whose data moved. That only holds while EVERY prop
  // stays identical, so the handlers below are stable and the list-derived
  // ones (handoffSource, rosterKey) collapse the churning array to a value
  // that moves when the thing the pane cares about moves.
  const openKanban = useCallback((pid?: string | null) => {
    setKanbanProjectId(pid ?? null);
    setView("kanban");
  }, []);
  // Unscoped (#597) means "the project I am in": land the board on the
  // selected thread's project instead of the first project (#207). A scalar
  // dep keeps the handler identity stable across thread-list churn.
  const selectedThreadProjectId =
    threads.find((t) => t.id === selectedThreadId)?.projectId ?? null;
  const openPlanboard = useCallback(
    (pid?: string | null) => {
      setPlanboardProjectId(pid ?? selectedThreadProjectId);
      setView("planboard");
    },
    [selectedThreadProjectId],
  );
  const openPrs = useCallback(() => {
    setView("prs");
    setDrawer(null);
  }, []);
  const openAutomations = useCallback(() => {
    setRepeatDraft(null);
    setView("automations");
    setDrawer(null);
  }, []);
  const openActivity = useCallback((pid?: string | null) => {
    setActivityProjectId(pid ?? null);
    setView("activity");
  }, []);
  const openUsage = useCallback(() => {
    setView("usage");
    setDrawer(null);
  }, []);
  const openFleet = useCallback(() => {
    setView("fleet");
    setDrawer(null);
  }, []);
  const openInsights = useCallback(() => {
    setView("insights");
    setDrawer(null);
  }, []);
  const loadFailureModes = useCallback(
    () => api.insights.failureModes(),
    [api],
  );
  // ponytail: collect the widest range once; summarizeFleet slices client-side
  const loadFleetEvidence = useCallback(
    () => api.fleet.evidence({ days: 90 }),
    [api],
  );
  const openDigest = useCallback(() => {
    setView("digest");
    setDrawer(null);
  }, []);
  const openSettings = useCallback((pane?: SettingsPane) => {
    setSettingsPane(pane ?? "general");
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeChanges = useCallback(() => setChangesOpen(false), []);
  const openChanges = useCallback(() => {
    setChangesOpen(true);
    setChangesNonce((n) => n + 1);
  }, []);
  const clearReveal = useCallback(() => setRevealThreadId(null), []);

  const handleCreateThread = useCallback(
    (projectId?: string, opts?: { worktree?: boolean; orchestrate?: boolean; teach?: boolean; ask?: boolean; issueNumber?: number | null; baseBranch?: string | null }) => {
      void createThread("New Thread", projectId, opts).then((t) => {
        if (t) setRevealThreadId(t.id);
      });
    },
    [createThread],
  );

  const handleCreateThreadPlain = useCallback(() => {
    void createThread("New Thread");
  }, [createThread]);

  const handleSetSettled = useCallback(
    (threadId: string, override: "settled" | "active" | null) => {
      void setSettled(threadId, override);
    },
    [setSettled],
  );

  const handleSetPinned = useCallback(
    (threadId: string, pinned: boolean) => {
      void setPinned(threadId, pinned);
    },
    [setPinned],
  );

  const handleSetSnoozed = useCallback(
    (threadId: string, until: number | null) => {
      void setSnoozed(threadId, until);
    },
    [setSnoozed],
  );

  const handleSetMuted = useCallback(
    (threadId: string, muted: boolean) => {
      void setMuted(threadId, muted);
    },
    [setMuted],
  );

  const handleRenameThread = useCallback(
    (threadId: string, title: string) => {
      void renameThread(threadId, title);
    },
    [renameThread],
  );

  const handleRenameOpenThread = useCallback(
    (title: string) => {
      if (!selectedThreadId) return;
      void renameThread(selectedThreadId, title);
    },
    [renameThread, selectedThreadId],
  );

  // An inline arrow here would bust ThreadView's memo on every 700ms stream
  // tick (issue #91); keep it identity-stable per selected thread.
  const handleSettleOpenThread = useCallback(
    () => {
      if (selectedThreadId) void setSettled(selectedThreadId, "settled");
    },
    [selectedThreadId, setSettled],
  );

  const handleRepeatSchedule = useCallback(() => {
    const source =
      detail && detail.thread.id === selectedThreadId ? detail : null;
    const draft = repeatDraftFromDetail(source);
    if (!draft) return;
    setRepeatDraft(draft);
    setView("automations");
  }, [detail, selectedThreadId]);

  const handleDistillWorkflow = useCallback(() => {
    if (!selectedThreadId) return;
    void (async () => {
      try {
        const distilled = await api.runs.distill({
          threadId: selectedThreadId,
        });
        setDistillError(null);
        setWorkflowDraft(distilled);
        setWorkflowsOpen(true);
      } catch (err) {
        setDistillError(
          err instanceof Error && err.message ? err.message : String(err),
        );
      }
    })();
  }, [api, selectedThreadId]);

  const closeWorkflows = useCallback(() => {
    setWorkflowsOpen(false);
    setWorkflowDraft(null);
  }, []);

  const dismissDistillError = useCallback(() => {
    setDistillError(null);
  }, []);

  const handleSetNotes = useCallback(
    (threadId: string, notes: string) => {
      void setNotes(threadId, notes);
    },
    [setNotes],
  );

  const handleSetFeltEstimate = useCallback(
    (threadId: string, savedMs: number | null) => {
      void setFeltEstimate(threadId, savedMs);
    },
    [setFeltEstimate],
  );

  const handleStartSpec = useCallback(
    (threadId: string) => {
      void startSpec(threadId);
    },
    [startSpec],
  );

  const handleStopSpec = useCallback(
    (threadId: string) => {
      void stopSpec(threadId);
    },
    [stopSpec],
  );

  const handleReviewSpec = useCallback(
    (threadId: string, decision: "approve" | "revise", feedback?: string) => {
      void reviewSpec(threadId, decision, feedback);
    },
    [reviewSpec],
  );

  const handleDispatchSpec = useCallback(
    (threadId: string) => {
      void dispatchSpec(threadId);
    },
    [dispatchSpec],
  );

  const handleConvergeSpec = useCallback(
    (threadId: string) => {
      void convergeSpec(threadId);
    },
    [convergeSpec],
  );

  const handleStartTeach = useCallback(
    (threadId: string) => {
      void startTeach(threadId);
    },
    [startTeach],
  );

  const handleStopTeach = useCallback(
    (threadId: string) => {
      void stopTeach(threadId);
    },
    [stopTeach],
  );

  const handleRequestTeachReview = useCallback(
    (threadId: string) => {
      void requestTeachReview(threadId);
    },
    [requestTeachReview],
  );

  const handleStartAsk = useCallback(
    (threadId: string) => {
      void startAsk(threadId);
    },
    [startAsk],
  );

  const handleStopAsk = useCallback(
    (threadId: string, opts?: { worktree?: boolean }) => {
      void stopAsk(threadId, opts);
    },
    [stopAsk],
  );

  const handleDismissBtw = useCallback(
    (threadId: string, id: string) => {
      void dismissBtw(threadId, id);
    },
    [dismissBtw],
  );

  const handlePromoteBtw = useCallback(
    (threadId: string, id: string) => {
      void promoteBtw(threadId, id);
    },
    [promoteBtw],
  );

  const handleRowArchived = useCallback(
    (threadId: string, archived: boolean) => {
      void setArchived(archived, threadId);
    },
    [setArchived],
  );

  const handleRowFork = useCallback(
    (threadId: string, opts?: { provider?: string }) => {
      void forkThread(threadId, opts);
    },
    [forkThread],
  );

  const handleForkOpen = useCallback(
    async (opts?: { provider?: string; model?: string | null }) => {
      if (!selectedThreadId) return null;
      return forkThread(selectedThreadId, opts);
    },
    [selectedThreadId, forkThread],
  );

  const dismissChipError = useCallback(() => {
    setChipError(null);
  }, []);

  const handleModelPickerOpen = useCallback(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // Wrapped, not passed through: this one is bound straight to a button's
  // onClick, so cancelQueued's optional threadId would swallow the DOM event
  // and cancel nothing.
  const handleCancelQueued = useCallback(() => {
    // Non-destructive cancel (#364): hand the discarded text back to the
    // composer, which applies it only onto an empty draft.
    const id = selectedThreadId;
    const text = id ? queued[id]?.prompt : null;
    cancelQueued();
    if (id && text) setQueuedDraftRestore({ threadId: id, text });
  }, [cancelQueued, selectedThreadId, queued]);

  const handleRetryQueued = useCallback(() => {
    retryQueued();
  }, [retryQueued]);

  const handleEditQueued = useCallback(
    (prompt: string) => {
      editQueued(prompt);
    },
    [editQueued],
  );

  const handleSetArchived = useCallback(
    async (archived: boolean) => {
      if (archived) {
        // Capture id before setArchived moves selection off the open thread.
        const id = selectedThreadId;
        if (!id) return;
        setRemoveFailMessage(null);
        if (await setArchived(true, id)) setArchiveToastIds([id]);
      } else {
        setArchiveToastIds(null);
        await setArchived(false);
      }
    },
    [selectedThreadId, setArchived],
  );

  /** Clear the settled tail: archive every settled thread, undoable as one unit. */
  const handleClearSettled = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setRemoveFailMessage(null);
      // Offer undo only for what actually archived: a mid-loop failure (its
      // message lands in the run-error banner) used to leave a partial
      // archive whose undo toast still claimed every id (issue #85).
      const archived: string[] = [];
      for (const id of ids) {
        if (await setArchived(true, id)) archived.push(id);
      }
      if (archived.length > 0) setArchiveToastIds(archived);
    },
    [setArchived],
  );

  const dismissArchiveToast = useCallback(() => {
    setArchiveToastIds(null);
  }, []);

  const undoArchive = useCallback(async () => {
    if (!archiveToastIds) return;
    const ids = archiveToastIds;
    setArchiveToastIds(null);
    for (const id of ids) {
      await setArchived(false, id);
    }
  }, [archiveToastIds, setArchived]);

  const handleRemoveProject = useCallback(
    async (projectId: string) => {
      const slug =
        projectById.get(projectId)?.slug ??
        projects.find((p) => p.id === projectId)?.slug ??
        projectId;
      setArchiveToastIds(null);
      try {
        await removeProject(projectId);
        setRemoveFailMessage(null);
      } catch (err) {
        const reason = err instanceof Error ? err.message.trim() : "";
        const title = reason
          ? `Failed to remove "${slug}": ${reason}`
          : `Failed to remove "${slug}"`;
        setRemoveFailMessage(title);
        throw new Error(title);
      }
    },
    [projectById, projects, removeProject],
  );

  const dismissRemoveFail = useCallback(() => {
    setRemoveFailMessage(null);
  }, []);

  // Close the center Changes panel when switching threads (old behavior).
  useEffect(() => {
    setChangesOpen(false);
  }, [selectedThreadId]);

  // Issue #249: refetch the cached forecast when the thread list moves.
  // Keyed on a cheap derived value, not the live `threads` array: the array
  // identity changes on every 700ms stream tick, which used to fire this IPC
  // call ~1.4x/sec for the duration of any run.
  const forecastKey = useMemo(
    () =>
      threads
        .map((t) => `${t.id}:${t.branch ?? ""}:${t.worktreePath ?? ""}`)
        .join("|"),
    [threads],
  );
  useEffect(() => {
    if (!selectedProjectId) {
      setForecast(EMPTY_FORECAST);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void conflictForecast(selectedProjectId).then((next) => {
        if (!cancelled) setForecast(next);
      });
    };
    refresh();
    // Git state can move without branch/worktree changing (merges, pulls), so
    // also refresh when the window regains focus — no steady-state timer.
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selectedProjectId, forecastKey, conflictForecast]);

  useEffect(() => {
    if (drawer === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const persistLastIfRemembering = useCallback((collapsed: boolean) => {
    if (rememberLastRef.current) saveLastAgentsCollapsed(collapsed);
  }, []);

  useEffect(() => {
    if (!settings) return;
    const def = settings.agentsPanelDefault === "open" ? "open" : "closed";
    if (appliedPanelDefaultRef.current === null) {
      appliedPanelDefaultRef.current = def;
      setAgentsCollapsed(
        agentsPanelStartsCollapsed(def, settings.agentsPanelRememberLast),
      );
      return;
    }
    if (appliedPanelDefaultRef.current !== def) {
      appliedPanelDefaultRef.current = def;
      const collapsed = def !== "open";
      setAgentsCollapsed(collapsed);
      persistLastIfRemembering(collapsed);
    }
  }, [settings, persistLastIfRemembering]);

  const collapseAgents = useCallback(() => {
    collapseSourceRef.current = "user";
    setAgentsCollapsed(true);
    persistLastIfRemembering(true);
  }, [persistLastIfRemembering]);

  // A second workspace pane (Git, Terminal, Browser, …) takes the rail's
  // width. Not flagged as a "user" collapse: focus stays where it was, and
  // the expand button is still one click away.
  const collapseAgentsForPanes = useCallback(() => setAgentsCollapsed(true), []);

  useEffect(() => {
    if (collapseSourceRef.current !== "user") return;
    collapseSourceRef.current = null;
    if (agentsCollapsed && !narrow) agentsExpandRef.current?.focus();
  }, [agentsCollapsed, narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      if (e.altKey || e.shiftKey) return;
      if (dialogOpen()) return;
      e.preventDefault();
      if (narrow) {
        setDrawer((d) => (d === "agents" ? null : "agents"));
        return;
      }
      collapseSourceRef.current = "user";
      setAgentsCollapsed((c) => {
        const next = !c;
        persistLastIfRemembering(next);
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, persistLastIfRemembering]);

  // ponytail: restore to the trigger, not a focus trap. Tab can leave the pane.
  useEffect(() => {
    if (drawer) {
      lastDrawerRef.current = drawer;
      const pane =
        drawer === "sidebar" ? sidebarPaneRef.current : agentsPaneRef.current;
      pane?.focus();
    } else if (lastDrawerRef.current) {
      const btn =
        lastDrawerRef.current === "sidebar"
          ? threadsBtnRef.current
          : agentsBtnRef.current;
      btn?.focus();
      lastDrawerRef.current = null;
    }
  }, [drawer]);

  // Gate the open detail on the current selection: while threads.get for a
  // freshly clicked thread is in flight (visible over --serve-web latency),
  // `detail` still holds the PREVIOUS thread. Rendering it under the new
  // sidebar selection shows a stale transcript, and a fast send would go to
  // the new thread while the user reads the old one (issue #83).
  const visibleDetail =
    detail && detail.thread.id === selectedThreadId ? detail : null;

  const project =
    (visibleDetail && projectById.get(visibleDetail.thread.projectId)) ||
    (selectedProjectId ? projectById.get(selectedProjectId) : undefined) ||
    null;

  const handleStartSuggestion = useCallback(
    async (s: WorkSuggestion) => {
      const threadId = selectedThreadId;
      if (!threadId) return;
      const t = await forkThread(threadId, { worktree: true });
      if (!t) return;
      // Resolve before startRun so a failed kickoff cannot leave the chip
      // open — a retry would fork a second idle thread.
      await resolveSuggestion(threadId, s.id, "started", {
        startedThreadId: t.id,
      });
      try {
        await startRun(s.prompt, t.id);
      } catch {
        // startRun already set the run-scope error. The fork exists, the
        // chip is started, and forkThread selected the new thread.
      }
    },
    [selectedThreadId, forkThread, startRun, resolveSuggestion],
  );

  const handleFileSuggestion = useCallback(
    async (s: WorkSuggestion) => {
      const threadId = selectedThreadId;
      const projectPath = project?.path;
      if (!threadId || !projectPath) return;
      const r = await createIssue(
        projectPath,
        s.title,
        `${s.prompt}\n\n_Filed from a Solenta suggested-work chip._`,
      );
      if (!r.ok) {
        // In-band like setIssuePlanStatus / planboard: show the reason, leave
        // the chip open. ArchiveToast is App's surface for action failures.
        setChipError(r.reason);
        return;
      }
      setChipError(null);
      await resolveSuggestion(threadId, s.id, "filed", {
        issueNumber: r.number,
      });
    },
    [selectedThreadId, project?.path, createIssue, resolveSuggestion],
  );

  const handleDismissSuggestion = useCallback(
    async (s: WorkSuggestion) => {
      if (!selectedThreadId) return;
      await resolveSuggestion(selectedThreadId, s.id, "dismissed");
    },
    [selectedThreadId, resolveSuggestion],
  );

  /** Provenance of a handed-off thread; a stable object while the row is. */
  const handoffFrom = visibleDetail?.thread.handoffFrom ?? null;
  const handoffSource = useMemo(
    () => (handoffFrom ? threads.find((t) => t.id === handoffFrom) ?? null : null),
    [threads, handoffFrom],
  );

  /** What the Agents team view refetches on: ids + statuses, not identity. */
  const rosterKey = useMemo(
    () => threads.map((t) => `${t.id}:${t.status}`).join(","),
    [threads],
  );

  /**
   * Same-task siblings for the divergence card. Keyed on roster + the open
   * thread so a 700ms stream tick on an unrelated row does not rebuild this.
   */
  const comparePeers = useMemo(() => {
    if (!visibleDetail) return [];
    const peers = sameTaskPeers(visibleDetail.thread, threads);
    return peers.map((t) => toComparePeer(t, peers, providers));
  }, [
    visibleDetail?.thread.id,
    visibleDetail?.thread.handoffFrom,
    visibleDetail?.thread.projectId,
    rosterKey,
    providers,
  ]);

  const handleCreateThreadFromIssue = useCallback(
    async (input: {
      projectId: string;
      projectPath: string;
      ref: string;
      mode?: ThreadStartMode;
      agentProfileId?: string;
    }) => {
      const fetched = await fetchIssue(input.projectPath, input.ref);
      if (!fetched.ok) return fetched;
      const issue = fetched.issue;
      let thread;
      try {
        // "default" (and the sidebar's issue button, which sends no mode)
        // follows the app setting; the rest are explicit overrides.
        const opts =
          input.mode === "orchestrator"
            ? { orchestrate: true }
            : input.mode === "worktree"
              ? { worktree: true }
              : input.mode === "plain"
                ? { worktree: false, orchestrate: false }
                : undefined;
        thread = await createThread(issue.title, input.projectId, {
          ...opts,
          // Linear identifiers are not GitHub issue numbers; post-merge
          // reopen scans `GitHub issue #N:` and ThreadInfo.issueNumber.
          ...(issue.source === "linear" ? {} : { issueNumber: issue.number }),
        });
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (!thread) {
        return { ok: false as const, reason: "Could not create thread" };
      }
      if (input.agentProfileId) {
        const profile = (settings?.agentProfiles ?? []).find(
          (p) => p.id === input.agentProfileId,
        );
        if (!profile) {
          return { ok: false as const, reason: "Unknown agent profile" };
        }
        const info = providers.find((p) => p.id === profile.provider);
        if (!info || info.available === false) {
          return {
            ok: false as const,
            reason: `${profile.name} is not installed`,
          };
        }
        try {
          // Same order as Composer.pickProfile: setProvider clears effort
          // on a harness switch, then effort, then permission.
          await setProvider({
            threadId: thread.id,
            provider: profile.provider,
            model: profile.model,
          });
          await setReasoningEffort(profile.reasoningEffort, thread.id);
          await setPermissionMode(
            snapToHonouredPermissionMode(
              providerPermissionModes(info),
              profile.permissionMode,
            ),
            thread.id,
          );
        } catch (err) {
          return {
            ok: false as const,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }
      const body = issue.body || "";
      const heading =
        issue.source === "linear"
          ? `Linear issue ${issue.identifier || issue.number}`
          : `GitHub issue #${issue.number}`;
      const prompt = `${heading}: ${issue.title}\n${issue.url}\n\n${body}`;
      try {
        await startRun(prompt, thread.id);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      // GitHub plan:* labels do not exist on Linear. Skip the column move.
      if (issue.source === "linear") {
        return { ok: true as const };
      }
      // The run is live either way, so a failed label move is a warning,
      // not a failure: say so instead of pretending the card moved.
      const moved = await setIssuePlanStatus(
        input.projectPath,
        issue.number,
        "doing",
      );
      return moved.ok
        ? { ok: true as const }
        : { ok: true as const, warning: `plan:doing not set (${moved.reason})` };
    },
    [
      fetchIssue,
      createThread,
      startRun,
      setIssuePlanStatus,
      settings?.agentProfiles,
      providers,
      setProvider,
      setReasoningEffort,
      setPermissionMode,
    ],
  );

  const handleCheckoutPr = useCallback(
    async (input: { projectId: string; prNumber: number }) => {
      const result = await checkoutPr(input);
      if (!result.ok) return result;
      setView("thread");
      setRevealThreadId(result.thread.id);
      if (result.created) {
        try {
          await startRun(result.prompt, result.thread.id);
        } catch {
          // Checkout landed; the run error is already in useCoder.error.
        }
      }
      return result;
    },
    [checkoutPr, startRun],
  );

  const handleAddProject = useCallback(() => {
    setAddPathOpen(true);
  }, []);

  const finishOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    setOnboardingForceOpen(false);
    void saveSettings({ onboardingSeen: true });
  }, [saveSettings]);

  const showOnboarding = useCallback(() => {
    setSettingsOpen(false);
    setOnboardingForceOpen(true);
  }, []);

  const onboardingOpen =
    onboardingForceOpen ||
    (settings !== null &&
      settings.onboardingSeen !== true &&
      !onboardingDismissed);

  const submitAddPath = useCallback(
    async (
      path: string,
      remotes?: { remoteHost?: string; remotePath?: string },
    ) => {
      // Modal closes itself on success, or stays open to show the
      // Windows doctor list (#435) when checks failed.
      return addProject(path, remotes);
    },
    [addProject],
  );

  const submitCreateProject = useCallback(
    async (name: string, parentDir: string) => {
      return createProject({ name, parentDir });
    },
    [createProject],
  );

  const pickProjectDirectory = useCallback(
    () => api.projects.pickDirectory(),
    [api],
  );

  const browseFilesystem = useCallback(
    (input: Parameters<typeof api.fs.browse>[0]) => api.fs.browse(input),
    [api],
  );

  const editProject =
    projects.find((p) => p.id === editProjectId) ?? null;

  // Vite replaces __BUILD_SHA__; node tests leave it undeclared.
  const rendererSha =
    rendererShaOverride !== undefined
      ? rendererShaOverride
      : typeof __BUILD_SHA__ === "string"
        ? __BUILD_SHA__
        : null;
  const buildMismatch = isBuildMismatch(appStatus?.build.sha, rendererSha);

  const submitEditProject = useCallback(
    async (input: ProjectUpdateInput) => {
      const updated = await updateProject(input);
      if (updated) setEditProjectId(null);
      return updated;
    },
    [updateProject],
  );

  if (buildMismatch) {
    return (
      <BuildMismatchScreen onRestart={() => void applyUpdate()} />
    );
  }

  return (
    <div className={styles.shell}>
      {isWebMode() && <WebTokenGate />}
      <div
        className={styles.app}
        data-layout="app"
        data-drawer={drawer ?? ""}
        data-agents-collapsed={hideAgentsRail ? "true" : undefined}
      >
        <div className={styles.narrowBar} data-narrow-chrome="">
          <button
            type="button"
            ref={threadsBtnRef}
            className={styles.narrowBtn}
            data-drawer-open="sidebar"
            aria-expanded={drawer === "sidebar"}
            aria-controls="pane-sidebar"
            onClick={() =>
              setDrawer((d) => (d === "sidebar" ? null : "sidebar"))
            }
          >
            Threads
          </button>
          <button
            type="button"
            ref={agentsBtnRef}
            className={styles.narrowBtn}
            data-drawer-open="agents"
            aria-expanded={drawer === "agents"}
            aria-controls="pane-agents"
            onClick={() =>
              setDrawer((d) => (d === "agents" ? null : "agents"))
            }
          >
            Agents
          </button>
        </div>
        <div
          className={`${styles.scrim} ${styles.scrimSidebar}`}
          data-scrim="sidebar"
          aria-hidden
          onClick={() => setDrawer(null)}
        />
        <div
          className={`${styles.scrim} ${styles.scrimAgents}`}
          data-scrim="agents"
          aria-hidden
          onClick={() => setDrawer(null)}
        />
        <div
          id="pane-sidebar"
          ref={sidebarPaneRef}
          className={styles.sidebarSlot}
          data-pane="sidebar"
          tabIndex={-1}
          inert={narrow && drawer !== "sidebar"}
        >
          <ErrorBoundary pane="Sidebar">
            <Sidebar
        appName="Solenta"
        appVersion={appStatus?.build.version ?? null}
        channel={appStatus?.build.channel ?? null}
        updateState={updateStatus?.state ?? null}
        onDownloadUpdate={downloadUpdate}
        onApplyUpdate={applyUpdate}
        searchPlaceholder="Search threads…"
        projectsHeader="All projects"
        projects={projects}
        threads={threads}
        providers={providers}
        activeThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        activeView={
          view === "kanban" || view === "planboard" || view === "activity"
            ? view
            : "thread"
        }
        onOpenKanban={openKanban}
        onOpenPlanboard={openPlanboard}
        onOpenActivity={openActivity}
        onCreateThread={handleCreateThread}
        listBaseBranches={listBaseBranches}
        defaultWorktree={settings?.defaultWorktree ?? false}
        revealThreadId={revealThreadId}
        onRevealHandled={clearReveal}
        onCreateThreadFromIssue={handleCreateThreadFromIssue}
        onAddProject={handleAddProject}
        onRemoveProject={handleRemoveProject}
        onEditProject={setEditProjectId}
        projectError={error?.scope === "project" ? error.message : null}
        onDismissProjectError={clearError}
        onOpenSettings={openSettings}
        stayAwake={stayAwake}
        onSetStayAwakeMode={(mode) => void setStayAwakeMode(mode)}
        spendTodayUsd={appStatus?.spendTodayUsd ?? null}
        dailyBudgetUsd={settings?.dailyBudgetUsd ?? null}
        autoSettleAfterDays={
          settings == null ? undefined : settings.autoSettleAfterDays
        }
        autoSettleOnMerge={
          settings == null ? undefined : settings.autoSettleOnMerge
        }
        searchThreads={searchThreads}
        onSetSettled={handleSetSettled}
        onSetPinned={handleSetPinned}
        onSetSnoozed={handleSetSnoozed}
        onSetMuted={handleSetMuted}
        onRenameThread={handleRenameThread}
        onSetArchived={handleRowArchived}
        onClearSettled={handleClearSettled}
        onFork={handleRowFork}
        conflictForecast={forecast}
            />
          </ErrorBoundary>
        </div>
        <div
          className={styles.threadSlot}
          data-pane="thread"
          inert={narrow && drawer !== null}
        >
          <ErrorBoundary pane="Thread view">
          {view === "activity" ? (
            <ActivityView
              projects={projects}
              projectScope={activityProjectId}
              listActivity={listActivity}
              onSelectThread={handleSelectThread}
            />
          ) : view === "usage" ? (
            <UsageView loadUsage={listUsageByDay} />
          ) : view === "fleet" ? (
            <FleetView loadEvidence={loadFleetEvidence} />
          ) : view === "insights" ? (
            <InsightsView
              loadFailureModes={loadFailureModes}
              onSelectThread={handleSelectThread}
            />
          ) : view === "digest" ? (
            <DigestView
              projects={projects}
              loadDigest={listDigest}
              markSeen={markDigestSeen}
              onSelectThread={handleSelectThread}
            />
          ) : view === "prs" ? (
            <PrListView
              projects={projects}
              threads={threads}
              listPrs={listPrs}
              onSelectThread={handleSelectThread}
              onCheckoutPr={handleCheckoutPr}
            />
          ) : view === "automations" ? (
            <AutomationsView
              automations={automations}
              projects={projects}
              providers={providers}
              draft={repeatDraft}
              onCreate={async (input) => {
                await addAutomation(input);
              }}
              onUpdate={async (input) => {
                await updateAutomation(input);
              }}
              onRemove={(id) => removeAutomation(id)}
              onRunNow={async (id) => {
                await runAutomationNow(id);
              }}
            />
          ) : view === "planboard" ? (
            <PlanboardView
              projects={projects}
              initialProjectId={planboardProjectId}
              listIssues={listIssues}
              listPrs={listPrs}
              threads={threads}
              onSelectThread={handleSelectThread}
              // Stay on the board after a start (#207): the card moves to In
              // progress here, and the new thread is in the sidebar anyway.
              onStartTask={handleCreateThreadFromIssue}
              agentProfiles={settings?.agentProfiles ?? EMPTY_AGENT_PROFILES}
              defaultOrchestratorProfileId={
                settings?.defaultOrchestratorProfileId ?? null
              }
              providers={providers}
            />
          ) : view === "kanban" ? (
            <KanbanView
              threads={threads}
              projects={projects}
              projectScope={kanbanProjectId}
              providers={providers}
              onSelectThread={handleSelectThread}
              onCreateThread={handleCreateThreadPlain}
              autoSettleAfterDays={
                settings == null ? undefined : settings.autoSettleAfterDays
              }
              autoSettleOnMerge={
                settings == null ? undefined : settings.autoSettleOnMerge
              }
              conflictForecast={forecast}
            />
          ) : (
            <ThreadView
        detail={visibleDetail}
        detailError={selectedThreadId ? detailError : null}
        onRetryDetail={retryDetail}
        project={project}
        providers={providers}
        agentProfiles={settings?.agentProfiles ?? EMPTY_AGENT_PROFILES}
        workflows={workflows}
        hasProjects={projects.length > 0}
        onAddProject={handleAddProject}
        onCreateThread={handleCreateThread}
        onStartRun={startRun}
        onSetupWorktree={setupWorktree}
        onMergeWorktree={mergeWorktree}
        onRemoveWorktree={removeWorktree}
        listBaseBranches={listBaseBranches}
        onSetBaseBranch={setBaseBranch}
        conflictContext={conflictContext}
        onOpenWorktree={openInEditor}
        onRewindAndResubmit={rewindAndResubmit}
        onStartWorkflow={startWorkflowRun}
        onSaveWorkflow={saveWorkflow}
        onRemoveWorkflow={removeWorkflow}
        onStopRun={stopRun}
        onResumeQuotaWait={
          selectedThreadId
            ? () => resumeQuotaWait(selectedThreadId)
            : undefined
        }
        onSetQuotaWaitAutoResume={
          selectedThreadId
            ? (enabled: boolean | null) =>
                setQuotaWaitAutoResume(selectedThreadId, enabled)
            : undefined
        }
        queuedPrompt={
          selectedThreadId ? (queued[selectedThreadId]?.prompt ?? null) : null
        }
        queuedError={
          selectedThreadId ? (queued[selectedThreadId]?.error ?? null) : null
        }
        onCancelQueued={handleCancelQueued}
        onRetryQueued={handleRetryQueued}
        onEditQueued={handleEditQueued}
        restoreDraft={queuedDraftRestore}
        onSetPermissionMode={setPermissionMode}
        onRespondPermission={respondPermission}
        onClearQuestion={clearQuestion}
        onSetProvider={setProvider}
        onSetReasoningEffort={setReasoningEffort}
        onSetWebSearch={setWebSearch}
        onSetArchived={handleSetArchived}
        onSetCrossThreadInbound={
          selectedThreadId
            ? (policy) => setCrossThreadInbound(selectedThreadId, policy)
            : undefined
        }
        onRenameThread={handleRenameOpenThread}
        onRepeatSchedule={handleRepeatSchedule}
        onDistillWorkflow={handleDistillWorkflow}
        onSetNotes={handleSetNotes}
        onSetFeltEstimate={
          // Opt-in (#401): no handler, no card. ThreadView already hides it.
          settings?.feltEstimatePrompt ? handleSetFeltEstimate : undefined
        }
        onStartSpec={handleStartSpec}
        onStopSpec={handleStopSpec}
        onReviewSpec={handleReviewSpec}
        onDispatchSpec={handleDispatchSpec}
        onConvergeSpec={handleConvergeSpec}
        onSpecArtifact={specArtifact}
        onStartTeach={handleStartTeach}
        onStopTeach={handleStopTeach}
        onRequestTeachReview={handleRequestTeachReview}
        onStartAsk={handleStartAsk}
        onStopAsk={handleStopAsk}
        onDismissBtw={handleDismissBtw}
        onPromoteBtw={handlePromoteBtw}
        defaultWorktree={settings?.defaultWorktree ?? false}
        onDeleteThread={deleteThread}
        changesOpen={changesOpen}
        changesNonce={changesNonce}
        onCloseChanges={closeChanges}
        onViewChanges={openChanges}
        terminalApi={terminal}
        onPanesNeedRoom={collapseAgentsForPanes}
        runStats={runStats}
        restoreCheckpoint={restoreCheckpoint}
        onFetchDiff={fetchDiff}
        onFetchReviewContext={fetchReviewContext}
        onSetReviewAccepted={setReviewAccepted}
        onCommitChanges={commitChanges}
        onStagedPathsChange={setStagedPaths}
        onRevertFile={revertFile}
        onSuggestCommitMessage={suggestCommitMessage}
        onListFiles={listFiles}
        onPickDirectory={pickDirectory}
        onListSnapWindows={listSnapWindows}
        onCaptureSnapWindow={captureSnapWindow}
        onListCliCommands={listCliCommands}
        onResolvePaths={resolvePaths}
        onOpenWorkspacePath={openWorkspacePath}
        onLoadImage={loadToolImage}
        onPickAttachments={pickAttachments}
        onSaveAttachmentImage={saveAttachmentImage}
        onLoadAttachmentImage={loadAttachmentImage}
        onDropAttachmentFiles={dropAttachmentFiles}
        preview={preview}
        simulator={simulator}
        simulatorStatus={simulatorStatus}
        devServerStatus={devServerStatus}
        listLocalServers={listLocalServers}
        onPush={pushBranch}
        onCreatePr={createPr}
        onPrChecks={prChecks}
        onPrMerge={prMerge}
        gitSyncInfo={gitSyncInfo}
        gitFetch={gitFetch}
        onRunCommand={runCommand}
        runError={error?.scope === "run" ? error.message : null}
        onDismissRunError={clearError}
        onFork={handleForkOpen}
        onStartSuggestion={handleStartSuggestion}
        onFileSuggestion={handleFileSuggestion}
        onDismissSuggestion={handleDismissSuggestion}
        handoffSource={handoffSource}
        comparePeers={comparePeers}
        onPeekThread={peekThread}
        onSelectThread={handleSelectThread}
        onModelPickerOpen={handleModelPickerOpen}
        onNewThread={handleCreateThreadPlain}
        onSettleThread={selectedThreadId ? handleSettleOpenThread : undefined}
            />
          )}
          </ErrorBoundary>
        </div>
        <div
          id="pane-agents"
          ref={agentsPaneRef}
          className={styles.agentsSlot}
          data-pane="agents"
          tabIndex={-1}
          inert={narrow && drawer !== "agents"}
        >
          {hideAgentsRail ? (
            <div className={styles.agentsRail}>
              <button
                ref={agentsExpandRef}
                type="button"
                className={styles.agentsToggle}
                data-agents-expand=""
                aria-expanded="false"
                aria-controls="pane-agents"
                title="Show agents panel (⌘.)"
                aria-label="Show agents panel"
                onClick={() => {
                  collapseSourceRef.current = "user";
                  setAgentsCollapsed(false);
                  persistLastIfRemembering(false);
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9.5 3.5 5 8l4.5 4.5" />
                </svg>
              </button>
            </div>
          ) : (
          <ErrorBoundary pane="Agents panel">
            <AgentsPanel
        onCollapse={narrow ? undefined : collapseAgents}
        workflow={visibleDetail?.workflow ?? null}
        thread={visibleDetail?.thread ?? null}
        usage={visibleDetail?.usage ?? null}
        providers={providers}
        project={project}
        rosterKey={rosterKey}
        listThreadSummaries={listThreadSummaries}
        listCrewTasks={listCrewTasks}
        onSelectThread={handleSelectThread}
        onViewChanges={openChanges}
        listCheckpoints={listCheckpoints}
        restoreCheckpoint={restoreCheckpoint}
        listLocalServers={listLocalServers}
        revealInFinder={revealInFinder}
        openInEditor={openInEditor}
        gitSyncInfo={gitSyncInfo}
        gitFetch={gitFetch}
        gitRepoInfo={gitRepoInfo}
        gitPull={gitPull}
        listDevScripts={listDevScripts}
        startDevServer={startDevServer}
        stopDevServer={stopDevServer}
        devServerStatus={devServerStatus}
        setVerifyCommand={setVerifyCommand}
        runVerify={runVerify}
        searchMemory={searchMemory}
        recentMemory={recentMemory}
        getMemory={getMemory}
        updateMemory={updateMemory}
        removeMemory={removeMemory}
        storeMemory={storeMemory}
        maintenanceMemory={maintenanceMemory}
        resolveMemory={resolveMemory}
        loadCodeMap={loadCodeMap}
        lintAgentConfig={lintAgentConfig}
        previewAgentConfig={previewAgentConfig}
        writeAgentConfig={writeAgentConfig}
        settings={settings}
        saveSettings={saveSettings}
        listMcpServers={listMcpServers}
        saveMcpServer={saveMcpServer}
        removeMcpServer={removeMcpServer}
        setMcpEnabled={setMcpEnabled}
        listMcpCatalog={listMcpCatalog}
        pickMcpImport={pickMcpImport}
        previewMcpImport={previewMcpImport}
        installMcpImport={installMcpImport}
        discardMcpImport={discardMcpImport}
        listSkills={listSkills}
        addSkill={addSkill}
        removeSkill={removeSkill}
        syncSkills={syncSkills}
        listSkillCatalog={listSkillCatalog}
        pickSkillImport={pickSkillImport}
        previewSkillImport={previewSkillImport}
        installSkillImport={installSkillImport}
        discardSkillImport={discardSkillImport}
        activeView={view}
        onOpenPrs={openPrs}
        onOpenAutomations={openAutomations}
        onOpenUsage={openUsage}
        onOpenFleet={openFleet}
        onOpenInsights={openInsights}
        onOpenDigest={openDigest}
        onFork={handleForkOpen}
          />
          </ErrorBoundary>
          )}
        </div>
        <WorkflowsModal
          open={workflowsOpen}
          onClose={closeWorkflows}
          workflows={workflows}
          providers={providers}
          initialDraft={workflowDraft}
          onSave={saveWorkflow}
          onRemove={removeWorkflow}
        />
        <SettingsModal
          open={settingsOpen}
          onClose={closeSettings}
          initialPane={settingsPane}
          settings={settings}
          providers={providers}
          status={appStatus}
          update={updateStatus}
          onCheckUpdate={checkUpdate}
          onDownloadUpdate={downloadUpdate}
          onApplyUpdate={applyUpdate}
          onSaveSettings={(patch) => saveSettings(patch)}
          onTestWebhook={testWebhook}
          onShowOnboarding={showOnboarding}
        />
        <OnboardingModal
          open={onboardingOpen}
          onClose={finishOnboarding}
          onFinish={finishOnboarding}
          providers={providers}
          refreshProviders={refreshProviders}
          projects={projects}
          onAddProject={handleAddProject}
          settings={settings}
          onSaveSettings={saveSettings}
        />
        {archiveToastIds && (
          <ArchiveToast
            key={`archive-${archiveToastIds.join(",")}`}
            message={
              archiveToastIds.length > 1
                ? `${archiveToastIds.length} archived`
                : undefined
            }
            onUndo={() => void undoArchive()}
            onDismiss={dismissArchiveToast}
          />
        )}
        {removeFailMessage && (
          <ArchiveToast
            key={`remove-fail-${removeFailMessage}`}
            variant="error"
            title={removeFailMessage}
            onDismiss={dismissRemoveFail}
          />
        )}
        {distillError && (
          <ArchiveToast
            key={`distill-fail-${distillError}`}
            variant="error"
            title={distillError}
            onDismiss={dismissDistillError}
          />
        )}
        {chipError && (
          <ArchiveToast
            key={`chip-fail-${chipError}`}
            variant="error"
            title={chipError}
            onDismiss={dismissChipError}
          />
        )}
        {addPathOpen && (
          <AddProjectPathModal
            onClose={() => setAddPathOpen(false)}
            onSubmit={submitAddPath}
            onCreate={submitCreateProject}
            onBrowse={browseFilesystem}
            currentProjectCwd={
              (selectedProjectId
                ? projectById.get(selectedProjectId)?.path
                : null) ?? null
            }
            onPickDirectory={
              isWebMode() ? undefined : pickProjectDirectory
            }
          />
        )}
        {editProject && (
          <EditProjectModal
            project={editProject}
            onClose={() => setEditProjectId(null)}
            onSubmit={submitEditProject}
            onPickIcon={
              isWebMode()
                ? undefined
                : () => api.projects.pickIcon({ projectId: editProject.id })
            }
            onPreviewIcon={async (iconPath) => {
              const r = await api.projects.resolveIcon({
                projectId: editProject.id,
                iconPath,
              });
              return r.iconUrl;
            }}
          />
        )}
      </div>
    </div>
  );
}
