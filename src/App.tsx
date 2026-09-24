import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useCoder } from "./useCoder";
import { isDevBuild, needsWebTokenGate } from "./coderApi";
import { demoProviderLimits } from "./providerUsageDemo";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { PrListView } from "./components/PrListView";
import { KanbanView } from "./components/KanbanView";
import { PlanboardView, type ThreadStartMode } from "./components/PlanboardView";
import { AutomationsView } from "./components/AutomationsView";
import { ActivityView } from "./components/ActivityView";
import { InsightsView } from "./components/InsightsView";
import { UsageView, type UsageReportControls } from "./components/UsageView";
import { FleetView } from "./components/FleetView";
import { DigestView } from "./components/DigestView";
import { AgentsPanel } from "./components/AgentsPanel";
import { ClaimedLanesHeartbeat, LaneHeartbeat } from "./components/LaneHeartbeat";
import {
  SettingsModal,
  type SettingsPane,
} from "./components/SettingsModal";
import { OnboardingModal } from "./components/onboarding/OnboardingModal";
import { ArchiveToast } from "./components/ArchiveToast";
import { AddProjectPathModal } from "./components/AddProjectPathModal";
import { EditProjectModal } from "./components/EditProjectModal";
import { WorkflowsModal } from "./components/WorkflowsModal";
import { CommandPalette } from "./components/CommandPalette";
import {
  PALETTE_ACTIONS,
  matchPaletteShortcut,
  type PaletteMode,
} from "./commandPalette";
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
import {
  isReturnableView,
  validProjectId,
  type ThreadOpenOrigin,
  type ViewReturnState,
} from "./viewReturn";
import { isDirectCrewChild, sameCrewProject } from "./crewIntegration";
import {
  bindSidebarDrag,
  browserSidebarStorage,
  initialSidebarWidth,
  nextSidebarPreference,
  saveSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_STEP_COARSE,
  sidebarFitCap,
} from "./sidebarWidth";

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

function subscribeViewport(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function getViewportWidth(): number {
  return window.innerWidth;
}

function useViewportWidth(): number {
  return useSyncExternalStore(subscribeViewport, getViewportWidth, () => 0);
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
    loading,
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
    retryWorkflowAgent,
    saveWorkflow,
    removeWorkflow,
    refreshWorkflows,
    workflowListError,
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
    setTags,
    setThreadProject,
    setMuted,
    setEjected,
    setCrossThreadInbound,
    setQuotaWaitAutoResume,
    resumeQuotaWait,
    renameThread,
    setNotes,
    setMessagePins,
    setBaseBranch,
    refreshWorkerSnapshot,
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
    trashedThreads,
    restoreThread,
    purgeThread,
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
    searchFileContents,
    pickDirectory,
    listSnapWindows,
    captureSnapWindow,
    resolvePaths,
    openWorkspacePath,
    loadToolImage,
    pickAttachments,
    pickFolderAttachments,
    saveAttachmentImage,
    loadAttachmentImage,
    dropAttachmentFiles,
    pushBranch,
    createPr,
    prChecks,
    prMerge,
    listPrs,
    checkoutPr,
    prTemplate,
    prDetail,
    prEdit,
    prComment,
    prClose,
    prReady,
    prMergeAt,
    listIssues,
    setIssuePlanStatus,
    createIssue,
    listActivity,
    listUsageByDay,
    listProviderLimits,
    listDigest,
    markDigestSeen,
    listThreadSummaries,
    listCrewTasks,
    crewIntegration,
    integrateWorker,
    listCheckpoints,
    restoreCheckpoint,
    runStats,
    fetchTurnDiff,
    conflictForecast,
    listLocalServers,
    revealInFinder,
    openInEditor,
    gitSyncInfo,
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
    detectHarnessSources,
    previewHarnessImport,
    installHarnessImport,
    discardHarnessImport,
    listCliCommands,
    listCliSessions,
    importCliSession,
    searchThreads,
    peekThread,
    automations,
    addAutomation,
    updateAutomation,
    removeAutomation,
    runAutomationNow,
    listAutomationRuns,
  } = useCoder();

  useEffect(() => {
    if (!settings?.theme) return;
    return syncTheme(settings.theme);
  }, [settings?.theme]);

  const [changesOpen, setChangesOpen] = useState(false);
  const [changesNonce, setChangesNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("command");
  const paletteModeRef = useRef<PaletteMode>("command");
  paletteModeRef.current = paletteMode;
  /** Mid-session latch so finishing the tour does not wait on settings.set. */
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  /** Relaunch from Settings even after onboardingSeen is true. */
  const [onboardingForceOpen, setOnboardingForceOpen] = useState(false);
  /** Synara-style undo toast after an immediate archive (single or bulk clear). */
  const [archiveToastIds, setArchiveToastIds] = useState<string[] | null>(null);
  /** Undo toast after moving a thread to Recently deleted (#940). */
  const [deleteToastId, setDeleteToastId] = useState<string | null>(null);
  /**
   * Error toast after projects.remove rejects. Title is t3-shaped:
   * Failed to remove "slug", plus the reason — swallowing it left the user
   * with no idea what to fix. Cleared on dismiss / timeout.
   */
  const [removeFailMessage, setRemoveFailMessage] = useState<string | null>(
    null,
  );
  const [addPathOpen, setAddPathOpen] = useState(false);
  const createdFirstThreadRef = useRef<{
    id: string;
    projectId: string;
  } | null>(null);
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>(() => {
    if (typeof window === "undefined") return "thread";
    const requested = new URLSearchParams(window.location.search).get("view");
    return requested === "usage" ? "usage" : "thread";
  });
  const quotaDemo =
    isDevBuild() &&
    typeof window !== "undefined" &&
    !(window as unknown as { coder?: unknown }).coder;
  const [planboardProjectId, setPlanboardProjectId] = useState<string | null>(null);
  const [kanbanProjectId, setKanbanProjectId] = useState<string | null>(null);
  const [activityProjectId, setActivityProjectId] = useState<string | null>(null);
  const [usageControls, setUsageControls] = useState<UsageReportControls>({
    range: 7,
    metric: "cost",
    group: "model",
  });
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
  const viewportWidth = useViewportWidth();
  const [preferredSidebarWidth, setPreferredSidebarWidth] = useState(
    initialSidebarWidth,
  );
  const [agentsCollapsed, setAgentsCollapsed] = useState(true);
  const [agentsTabFocus, setAgentsTabFocus] = useState(0);
  const sidebarPaneRef = useRef<HTMLDivElement>(null);
  const sidebarDragRef = useRef<{ finish(commit: boolean): void } | null>(
    null,
  );
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
  // Agents panel open is the case that can squeeze the transcript. The
  // collapsed rail still leaves room for the widest sidebar above 900px.
  const sidebarFit = sidebarFitCap(viewportWidth, !agentsCollapsed && !narrow);
  const sidebarWidth = Math.min(preferredSidebarWidth, sidebarFit);
  const preferredSidebarRef = useRef(preferredSidebarWidth);
  preferredSidebarRef.current = preferredSidebarWidth;
  const sidebarFitRef = useRef(sidebarFit);
  sidebarFitRef.current = sidebarFit;

  const viewRef = useRef(view);
  viewRef.current = view;
  const planboardProjectIdRef = useRef(planboardProjectId);
  planboardProjectIdRef.current = planboardProjectId;
  const kanbanProjectIdRef = useRef(kanbanProjectId);
  kanbanProjectIdRef.current = kanbanProjectId;
  const activityProjectIdRef = useRef(activityProjectId);
  activityProjectIdRef.current = activityProjectId;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  /**
   * One session-only return destination (#942). Replaces the Activity/Kanban
   * in-view latch from #944: opening a thread from a report/board captures
   * view + project + row, and Back (or the same nav item) restores it.
   */
  const [returnTo, setReturnTo] = useState<ViewReturnState | null>(null);
  const returnToRef = useRef(returnTo);
  returnToRef.current = returnTo;
  const [viewRestore, setViewRestore] = useState<ViewReturnState | null>(null);
  const clearViewRestore = useCallback(() => setViewRestore(null), []);

  const handleSelectThread = useCallback(
    (id: string, origin?: ThreadOpenOrigin) => {
      const current = viewRef.current;
      if (isReturnableView(current)) {
        const projectId =
          origin?.projectId !== undefined
            ? origin.projectId
            : current === "planboard"
              ? planboardProjectIdRef.current
              : current === "kanban"
                ? kanbanProjectIdRef.current
                : current === "activity"
                  ? activityProjectIdRef.current
                  : null;
        setReturnTo({
          view: current,
          projectId,
          sort: origin?.sort,
          query: origin?.query,
          projectFilter: origin?.projectFilter,
          rowKey: origin?.rowKey ?? id,
          rowIndex: origin?.rowIndex ?? 0,
          scrollTop: origin?.scrollTop ?? 0,
          scrollKey: origin?.scrollKey,
        });
      } else if (current !== "thread") {
        setReturnTo(null);
      }
      setView("thread");
      setDrawer(null);
      selectThread(id);
    },
    [selectThread],
  );
  const liveThreadIds = useMemo(
    () => (loading ? undefined : threads.map((t) => t.id)),
    [loading, threads],
  );
  const revealAgentsTeam = useCallback(() => {
    if (narrow) setDrawer("agents");
    else setAgentsCollapsed(false);
    setAgentsTabFocus((n) => n + 1);
  }, [narrow]);
  const openCrewIntegration = useCallback(
    (leadId: string) => {
      handleSelectThread(leadId);
      revealAgentsTeam();
    },
    [handleSelectThread, revealAgentsTeam],
  );

  // The three panes are memo'd (issue #91): a 700ms stream tick must only
  // re-render the pane whose data moved. That only holds while EVERY prop
  // stays identical, so the handlers below are stable and the list-derived
  // ones (handoffSource, rosterKey) collapse the churning array to a value
  // that moves when the thing the pane cares about moves.
  // Unscoped (#597) means "the project I am in": land the board on the
  // selected thread's project instead of the first project (#207). A scalar
  // dep keeps the handler identity stable across thread-list churn.
  const selectedThreadProjectId =
    threads.find((t) => t.id === selectedThreadId)?.projectId ?? null;
  const selectedThreadProjectIdRef = useRef(selectedThreadProjectId);
  selectedThreadProjectIdRef.current = selectedThreadProjectId;

  const consumeReturn = useCallback((viewName: ViewReturnState["view"]) => {
    const dest = returnToRef.current;
    const returning =
      viewRef.current === "thread" && dest?.view === viewName;
    if (!returning) {
      setViewRestore(null);
      setReturnTo(null);
      return null;
    }
    setViewRestore(dest);
    setReturnTo(null);
    return dest;
  }, []);

  const openThreads = useCallback(() => {
    setView("thread");
    setDrawer(null);
  }, []);
  const openKanban = useCallback((pid?: string | null) => {
    const dest = consumeReturn("kanban");
    if (dest) {
      setKanbanProjectId(
        validProjectId(dest.projectId, projectsRef.current),
      );
    } else {
      setKanbanProjectId(pid ?? null);
    }
    setView("kanban");
    setDrawer(null);
  }, [consumeReturn]);
  const openPlanboard = useCallback(
    (pid?: string | null) => {
      const dest = consumeReturn("planboard");
      if (dest) {
        setPlanboardProjectId(
          validProjectId(dest.projectId, projectsRef.current) ??
            selectedThreadProjectIdRef.current,
        );
      } else {
        setPlanboardProjectId(pid ?? selectedThreadProjectIdRef.current);
      }
      setView("planboard");
      setDrawer(null);
    },
    [consumeReturn],
  );
  const openPrs = useCallback(() => {
    consumeReturn("prs");
    setView("prs");
    setDrawer(null);
  }, [consumeReturn]);
  const openAutomations = useCallback(() => {
    setRepeatDraft(null);
    setReturnTo(null);
    setViewRestore(null);
    setView("automations");
    setDrawer(null);
  }, []);
  const openActivity = useCallback((pid?: string | null) => {
    const dest = consumeReturn("activity");
    if (dest) {
      setActivityProjectId(
        validProjectId(dest.projectId, projectsRef.current),
      );
    } else {
      setActivityProjectId(pid ?? null);
    }
    setView("activity");
    setDrawer(null);
  }, [consumeReturn]);
  const openUsage = useCallback(() => {
    setReturnTo(null);
    setViewRestore(null);
    setView("usage");
    setDrawer(null);
  }, []);
  const openFleet = useCallback(() => {
    setReturnTo(null);
    setViewRestore(null);
    setView("fleet");
    setDrawer(null);
  }, []);
  const openInsights = useCallback(() => {
    consumeReturn("insights");
    setView("insights");
    setDrawer(null);
  }, [consumeReturn]);
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
    consumeReturn("digest");
    setView("digest");
    setDrawer(null);
  }, [consumeReturn]);
  const handleReturnToView = useCallback(() => {
    const dest = returnToRef.current;
    if (!dest) return;
    if (dest.view === "planboard") openPlanboard();
    else if (dest.view === "kanban") openKanban();
    else if (dest.view === "activity") openActivity();
    else if (dest.view === "digest") openDigest();
    else if (dest.view === "prs") openPrs();
    else if (dest.view === "insights") openInsights();
  }, [
    openPlanboard,
    openKanban,
    openActivity,
    openDigest,
    openPrs,
    openInsights,
  ]);
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

  const handleSetTags = useCallback(
    (threadId: string, tags: string[]) => {
      void setTags(threadId, tags);
    },
    [setTags],
  );

  const handleSetThreadProject = useCallback(
    (threadId: string, projectId: string) => {
      void setThreadProject(threadId, projectId);
    },
    [setThreadProject],
  );

  const handleSetMuted = useCallback(
    (threadId: string, muted: boolean) => {
      void setMuted(threadId, muted);
    },
    [setMuted],
  );

  const handleSetEjected = useCallback(
    (threadId: string, ejected: boolean) => {
      void setEjected(threadId, ejected);
    },
    [setEjected],
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
    (threadId: string, notes: string) => setNotes(threadId, notes),
    [setNotes],
  );

  const handleSetMessagePins = useCallback(
    (
      threadId: string,
      pins: import("./shared/ipc").ThreadMessagePin[],
    ) => setMessagePins(threadId, pins),
    [setMessagePins],
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
    // Non-destructive cancel (#364): restore the discarded text onto an
    // empty composer only after the host clear lands. A rejected clear
    // keeps the overlay; filling the draft then would duplicate on send.
    const id = selectedThreadId;
    const text = id ? queued[id]?.prompt : null;
    void cancelQueued().then((cleared) => {
      if (cleared && id && text) setQueuedDraftRestore({ threadId: id, text });
    });
  }, [cancelQueued, selectedThreadId, queued]);

  const handleRetryQueued = useCallback(() => {
    retryQueued();
  }, [retryQueued]);

  const handleEditQueued = useCallback(
    (prompt: string, items?: string[]) => {
      return editQueued(prompt, undefined, items);
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
        if (await setArchived(true, id)) {
          setDeleteToastId(null);
          setArchiveToastIds([id]);
        }
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
      if (archived.length > 0) {
        setDeleteToastId(null);
        setArchiveToastIds(archived);
      }
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

  const handleDeleteThread = useCallback(async () => {
    const id = selectedThreadId;
    if (!id) return;
    setArchiveToastIds(null);
    if (await deleteThread()) setDeleteToastId(id);
  }, [selectedThreadId, deleteThread]);

  const dismissDeleteToast = useCallback(() => {
    setDeleteToastId(null);
  }, []);

  const undoDelete = useCallback(async () => {
    if (!deleteToastId) return;
    const id = deleteToastId;
    setDeleteToastId(null);
    await restoreThread(id);
  }, [deleteToastId, restoreThread]);

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

  const toggleAgents = useCallback(() => {
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
  }, [narrow, persistLastIfRemembering]);

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
      toggleAgents();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAgents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = matchPaletteShortcut(e);
      if (!next) return;
      const paletteEl = document.querySelector("[data-command-palette]");
      if (dialogOpen() && !paletteEl) return;
      e.preventDefault();
      e.stopPropagation();
      if (paletteEl && paletteModeRef.current === next) {
        setPaletteOpen(false);
        return;
      }
      setPaletteMode(next);
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

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
  const handoffSource = useMemo(() => {
    if (!handoffFrom) return null;
    const parent = threads.find((t) => t.id === handoffFrom) ?? null;
    if (!parent || !sameCrewProject(parent, visibleDetail?.thread)) return null;
    return parent;
  }, [threads, handoffFrom, visibleDetail?.thread]);
  /** Direct same-project orchWorker children. Manual forks and cross-project rows do not count. */
  const workerCount = useMemo(() => {
    const parent = visibleDetail?.thread;
    if (!parent) return 0;
    let n = 0;
    for (const t of threads) {
      if (isDirectCrewChild(t, parent)) n++;
    }
    return n;
  }, [threads, visibleDetail?.thread]);

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

  const handleImportCliSession = useCallback(
    async (input: {
      sessionId: string;
      projectId: string;
      provider?: "codex" | "grok" | "claude" | "cursor" | "opencode" | "kimi" | "muse";
    }) => {
      const t = await importCliSession(input);
      setRevealThreadId(t.id);
      return t;
    },
    [importCliSession],
  );

  const handleCreateThreadFromIssue = useCallback(
    async (input: {
      projectId: string;
      projectPath: string;
      ref: string;
      mode?: ThreadStartMode;
      agentProfileId?: string;
    }) => {
      let fetched;
      try {
        fetched = await fetchIssue(input.projectPath, input.ref);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
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
      let moved;
      try {
        moved = await setIssuePlanStatus(
          input.projectPath,
          issue.number,
          "doing",
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: true as const,
          warning: `plan:doing not set (${reason})`,
        };
      }
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
      let result;
      try {
        result = await checkoutPr(input);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
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

  const handlePaletteProject = useCallback(
    (projectId: string) => {
      const latest = threads
        .filter((t) => t.projectId === projectId && !t.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) handleSelectThread(latest.id);
    },
    [threads, handleSelectThread],
  );

  const handlePaletteFile = useCallback(
    (rel: string, opts?: { reveal?: boolean }) => {
      const cleaned = rel.endsWith("/") ? rel.slice(0, -1) : rel;
      void resolvePaths([cleaned]).then((rows) => {
        const abs = rows[0]?.abs;
        if (!abs) return;
        void openWorkspacePath(abs, {
          reveal: Boolean(opts?.reveal || rel.endsWith("/")),
        });
      });
    },
    [resolvePaths, openWorkspacePath],
  );

  const runPaletteAction = useCallback(
    (id: string) => {
      if (id === "new-thread") handleCreateThreadPlain();
      else if (id === "settings") openSettings();
      else if (id === "kanban") openKanban();
      else if (id === "planboard") openPlanboard();
      else if (id === "activity") openActivity();
      else if (id === "prs") openPrs();
      else if (id === "usage") openUsage();
      else if (id === "fleet") openFleet();
      else if (id === "insights") openInsights();
      else if (id === "digest") openDigest();
      else if (id === "add-project") handleAddProject();
      else if (id === "toggle-agents") toggleAgents();
    },
    [
      handleCreateThreadPlain,
      openSettings,
      openKanban,
      openPlanboard,
      openActivity,
      openPrs,
      openUsage,
      openFleet,
      openInsights,
      openDigest,
      handleAddProject,
      toggleAgents,
    ],
  );

  const finishOnboarding = useCallback(async () => {
    await saveSettings({ onboardingSeen: true });
    createdFirstThreadRef.current = null;
    setOnboardingDismissed(true);
    setOnboardingForceOpen(false);
  }, [saveSettings]);

  const handleCreateFirstThread = useCallback(
    async (input: { projectId: string; provider: string }) => {
      const existing = createdFirstThreadRef.current;
      let threadId =
        existing && existing.projectId === input.projectId
          ? existing.id
          : null;
      if (!threadId) {
        const thread = await createThread("New Thread", input.projectId, {
          inheritProvider: false,
        });
        if (!thread) {
          throw new Error("Could not create thread");
        }
        threadId = thread.id;
      }
      createdFirstThreadRef.current = {
        id: threadId,
        projectId: input.projectId,
      };
      try {
        await setProvider({ threadId, provider: input.provider });
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Could not set the thread agent";
        throw err instanceof Error ? err : new Error(message);
      }
      selectThread(threadId);
      setView("thread");
      setRevealThreadId(threadId);
    },
    [createThread, selectThread, setProvider],
  );

  const showOnboarding = useCallback(() => {
    setSettingsOpen(false);
    setOnboardingForceOpen(true);
    createdFirstThreadRef.current = null;
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

  const commitSidebarWidth = useCallback((width: number) => {
    setPreferredSidebarWidth(width);
    saveSidebarWidth(width, browserSidebarStorage());
  }, []);

  const endSidebarDrag = useCallback((commit: boolean) => {
    const session = sidebarDragRef.current;
    sidebarDragRef.current = null;
    session?.finish(commit);
  }, []);

  useLayoutEffect(() => {
    if (narrow) endSidebarDrag(false);
  }, [narrow, endSidebarDrag]);

  useLayoutEffect(() => {
    return () => {
      const session = sidebarDragRef.current;
      sidebarDragRef.current = null;
      session?.finish(false);
    };
  }, []);

  const onSidebarResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || narrow || sidebarDragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // jsdom, or a pointer the browser will not capture.
    }
    try {
      handle.focus({ preventScroll: true });
    } catch {
      handle.focus();
    }
    const startPreferred = preferredSidebarRef.current;
    const sidebarLeft =
      sidebarPaneRef.current?.getBoundingClientRect().left ?? 0;
    const clearDrag = () => {
      sidebarDragRef.current = null;
    };
    sidebarDragRef.current = bindSidebarDrag({
      pointerId,
      handle,
      originX: event.clientX,
      sidebarLeft,
      startPreferred,
      fitCap: () => sidebarFitRef.current,
      onPreview: setPreferredSidebarWidth,
      onCommit: (width) => {
        clearDrag();
        commitSidebarWidth(width);
      },
      onCancel: () => {
        clearDrag();
        setPreferredSidebarWidth(startPreferred);
      },
    });
  };

  const onSidebarResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (sidebarDragRef.current) return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
      return;
    }
    let delta = 0;
    if (event.key === "ArrowLeft") {
      delta = -(event.shiftKey ? SIDEBAR_WIDTH_STEP_COARSE : SIDEBAR_WIDTH_STEP);
    } else if (event.key === "ArrowRight") {
      delta = event.shiftKey ? SIDEBAR_WIDTH_STEP_COARSE : SIDEBAR_WIDTH_STEP;
    } else {
      return;
    }
    event.preventDefault();
    const next = nextSidebarPreference(
      preferredSidebarRef.current,
      delta,
      sidebarFitRef.current,
      "delta",
    );
    if (next !== preferredSidebarRef.current) commitSidebarWidth(next);
  };

  const onSidebarResizeReset = () => {
    if (sidebarDragRef.current) return;
    commitSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  };

  if (buildMismatch) {
    return (
      <BuildMismatchScreen onRestart={() => void applyUpdate()} />
    );
  }

  return (
    <div className={styles.shell}>
      {needsWebTokenGate() && <WebTokenGate />}
      <div
        className={styles.app}
        data-layout="app"
        data-drawer={drawer ?? ""}
        data-agents-collapsed={hideAgentsRail ? "true" : undefined}
        style={
          narrow
            ? undefined
            : ({ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties)
        }
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
        activeView={view}
        onOpenThreads={openThreads}
        onOpenKanban={openKanban}
        onOpenPlanboard={openPlanboard}
        onOpenReview={openPrs}
        onOpenActivity={openActivity}
        onOpenAutomations={openAutomations}
        onOpenUsage={openUsage}
        onOpenFleet={openFleet}
        onOpenInsights={openInsights}
        onOpenDigest={openDigest}
        onCreateThread={handleCreateThread}
        listBaseBranches={listBaseBranches}
        defaultWorktree={settings?.defaultWorktree ?? false}
        revealThreadId={revealThreadId}
        onRevealHandled={clearReveal}
        onCreateThreadFromIssue={handleCreateThreadFromIssue}
        listCliSessions={listCliSessions}
        importCliSession={handleImportCliSession}
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
        onSetTags={handleSetTags}
        onSetThreadProject={handleSetThreadProject}
        onSetMuted={handleSetMuted}
        onSetEjected={handleSetEjected}
        onRenameThread={handleRenameThread}
        onSetArchived={handleRowArchived}
        onClearSettled={handleClearSettled}
        trashedThreads={trashedThreads}
        onRestoreThread={(id) => void restoreThread(id)}
        onPurgeThread={(id) => void purgeThread(id)}
        onFork={handleRowFork}
        conflictForecast={forecast}
            />
          </ErrorBoundary>
        </div>
        {!narrow && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Arrow keys resize. Shift is a coarse step. Enter or double-click resets."
            aria-controls="pane-sidebar"
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={sidebarFit}
            aria-valuenow={sidebarWidth}
            aria-valuetext={`${sidebarWidth} pixels`}
            tabIndex={0}
            className={styles.sidebarResize}
            data-sidebar-resize=""
            onPointerDown={onSidebarResizePointerDown}
            onKeyDown={onSidebarResizeKeyDown}
            onDoubleClick={onSidebarResizeReset}
          />
        )}
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
              onProjectScopeChange={setActivityProjectId}
              existingThreadIds={liveThreadIds}
              restore={viewRestore?.view === "activity" ? viewRestore : null}
              onRestoreApplied={clearViewRestore}
            />
          ) : view === "usage" ? (
            <UsageView
              loadUsage={listUsageByDay}
              loadProviderLimits={
                quotaDemo
                  ? async () => demoProviderLimits()
                  : listProviderLimits
              }
              quotaDemo={quotaDemo}
              onSelectThread={handleSelectThread}
              existingThreadIds={
                loading ? undefined : threads.map((t) => t.id)
              }
              reportControls={usageControls}
              onReportControlsChange={setUsageControls}
            />
          ) : view === "fleet" ? (
            <FleetView loadEvidence={loadFleetEvidence} />
          ) : view === "insights" ? (
            <InsightsView
              loadFailureModes={loadFailureModes}
              onSelectThread={handleSelectThread}
              existingThreadIds={liveThreadIds}
              restore={viewRestore?.view === "insights" ? viewRestore : null}
              onRestoreApplied={clearViewRestore}
            />
          ) : view === "digest" ? (
            <DigestView
              projects={projects}
              loadDigest={listDigest}
              markSeen={markDigestSeen}
              onSelectThread={handleSelectThread}
              existingThreadIds={liveThreadIds}
              restore={viewRestore?.view === "digest" ? viewRestore : null}
              onRestoreApplied={clearViewRestore}
            />
          ) : view === "prs" ? (
            <PrListView
              projects={projects}
              threads={threads}
              listPrs={listPrs}
              onSelectThread={handleSelectThread}
              onCheckoutPr={handleCheckoutPr}
              prDetail={prDetail}
              prEdit={prEdit}
              prComment={prComment}
              prClose={prClose}
              prReady={prReady}
              prMergeAt={prMergeAt}
              restore={viewRestore?.view === "prs" ? viewRestore : null}
              onRestoreApplied={clearViewRestore}
            />
          ) : view === "automations" ? (
            <AutomationsView
              automations={automations}
              projects={projects}
              providers={providers}
              draft={repeatDraft}
              loadRuns={listAutomationRuns}
              onSelectThread={handleSelectThread}
              liveThreads={loading ? undefined : threads}
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
              restore={viewRestore?.view === "planboard" ? viewRestore : null}
              onRestoreApplied={clearViewRestore}
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
              onProjectScopeChange={setKanbanProjectId}
              restore={viewRestore?.view === "kanban" ? viewRestore : null}
              onRestoreApplied={clearViewRestore}
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
        loadProviderLimits={
          quotaDemo ? async () => demoProviderLimits() : listProviderLimits
        }
        quotaDemo={quotaDemo}
        returnToView={returnTo?.view ?? null}
        onReturnToView={returnTo ? handleReturnToView : undefined}
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
        onOpenCrewLead={handleSelectThread}
        onRemoveWorktree={removeWorktree}
        listBaseBranches={listBaseBranches}
        onSetBaseBranch={setBaseBranch}
        onRefreshWorkerSnapshot={refreshWorkerSnapshot}
        conflictContext={conflictContext}
        onOpenWorktree={openInEditor}
        onOpenCrewIntegration={openCrewIntegration}
        workerCount={workerCount}
        onOpenWorkers={workerCount > 0 ? revealAgentsTeam : undefined}
        onRewindAndResubmit={rewindAndResubmit}
        onStartWorkflow={startWorkflowRun}
        onRetryWorkflowAgent={retryWorkflowAgent}
        onSaveWorkflow={saveWorkflow}
        onRemoveWorkflow={removeWorkflow}
        workflowListError={workflowListError}
        onRetryWorkflows={refreshWorkflows}
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
        queuedItems={
          selectedThreadId ? queued[selectedThreadId]?.items : undefined
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
        onSetMessagePins={handleSetMessagePins}
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
        onDeleteThread={handleDeleteThread}
        changesOpen={changesOpen}
        changesNonce={changesNonce}
        onCloseChanges={closeChanges}
        onViewChanges={openChanges}
        terminalApi={terminal}
        onPanesNeedRoom={collapseAgentsForPanes}
        runStats={runStats}
        onFetchTurnDiff={fetchTurnDiff}
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
        onPickFolderAttachments={pickFolderAttachments}
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
        onPrTemplate={prTemplate}
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
        <ClaimedLanesHeartbeat
          projects={projects}
          listLanes={listLanes}
          heartbeatLane={heartbeatLane}
        />
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
            <LaneHeartbeat
              threadId={selectedThreadId}
              claimed={Boolean(visibleDetail?.thread.lane)}
              heartbeatLane={heartbeatLane}
            />
            <AgentsPanel
        onCollapse={narrow ? undefined : collapseAgents}
        workflow={visibleDetail?.workflow ?? null}
        thread={visibleDetail?.thread ?? null}
        onRetryAgent={retryWorkflowAgent}
        usage={visibleDetail?.usage ?? null}
        providers={providers}
        project={project}
        rosterKey={rosterKey}
        listThreadSummaries={listThreadSummaries}
        listCrewTasks={listCrewTasks}
        crewIntegration={crewIntegration}
        onIntegrateWorker={
          selectedThreadId
            ? async (workerThreadId: string) => {
                await integrateWorker(selectedThreadId, workerThreadId);
              }
            : undefined
        }
        onRefreshWorker={refreshWorkerSnapshot}
        onVerifyLead={
          selectedThreadId
            ? async () => {
                await runVerify(selectedThreadId);
              }
            : undefined
        }
        onLandLead={
          selectedThreadId
            ? async () => {
                const view = await crewIntegration(selectedThreadId);
                if (view.finalAction === "pr") {
                  await createPr({
                    title: visibleDetail?.thread.title || "Lead integration",
                  });
                  return;
                }
                await mergeWorktree();
              }
            : undefined
        }
        focusAgentsTabNonce={agentsTabFocus}
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
        claimLane={claimLane}
        listLanes={listLanes}
        previewLane={previewLane}
        restorePreview={restorePreview}
        recycleWedgedLanes={recycleWedgedLanes}
        setSpotlight={setSpotlight}
        spotlightLane={spotlightLane}
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
        detectHarnessSources={detectHarnessSources}
        previewHarnessImport={previewHarnessImport}
        installHarnessImport={installHarnessImport}
        discardHarnessImport={discardHarnessImport}
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
          listError={workflowListError}
          onRetryList={refreshWorkflows}
        />
        <CommandPalette
          open={paletteOpen}
          mode={paletteMode}
          onClose={() => setPaletteOpen(false)}
          onModeChange={setPaletteMode}
          threads={threads}
          projects={projects}
          searchThreads={searchThreads}
          listFiles={listFiles}
          searchFileContents={searchFileContents}
          canSearchWorkspace={Boolean(selectedThreadId)}
          onSelectThread={handleSelectThread}
          onSelectProject={handlePaletteProject}
          onRunAction={runPaletteAction}
          onOpenFile={handlePaletteFile}
          actions={PALETTE_ACTIONS}
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
          suspended={addPathOpen}
          onFinish={finishOnboarding}
          providers={providers}
          refreshProviders={refreshProviders}
          projects={projects}
          onAddProject={handleAddProject}
          settings={settings}
          onSaveSettings={saveSettings}
          onCreateFirstThread={handleCreateFirstThread}
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
        {deleteToastId && (
          <ArchiveToast
            key={`delete-${deleteToastId}`}
            message="Deleted"
            onUndo={() => void undoDelete()}
            onDismiss={dismissDeleteToast}
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
