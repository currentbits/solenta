import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
} from "react";
import { useCoder } from "./useCoder";
import { isDevBuild, needsWebTokenGate } from "./coderApi";
import { demoProviderLimits } from "./providerUsageDemo";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import type { UsageReportControls } from "./components/UsageView";
import {
  AgentsPanel,
  defaultInspectorTab,
  inspectorContextKey,
  type PanelTab,
} from "./components/AgentsPanel";
import { ClaimedLanesHeartbeat } from "./components/LaneHeartbeat";
import type { SettingsPane } from "./components/SettingsModal";
import { ArchiveToast } from "./components/ArchiveToast";
import { WorkflowsModal } from "./components/WorkflowsModal";
import {
  PALETTE_ACTIONS,
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
import type {
  AgentProfile,
  ConflictForecast,
  DistilledWorkflow,
  ProjectUpdateInput,
} from "./shared/ipc";
import styles from "./App.module.css";
import { syncTheme } from "./theme";
import {
  isReturnableView,
  type ThreadOpenOrigin,
  type ViewReturnState,
} from "./viewReturn";
import {
  initialSidebarWidth,
  SIDEBAR_WIDTH_MIN,
  sidebarFitCap,
} from "./sidebarWidth";
import { useNarrow, useViewportWidth } from "./app/viewport";
import { useAgentsPanelCollapse } from "./app/useAgentsPanelCollapse";
import {
  EMPTY_FORECAST,
  useConflictForecast,
} from "./app/useConflictForecast";
import { useViewNavigation } from "./app/useViewNavigation";
import { useThreadRemoval } from "./app/useThreadRemoval";
import { useSuggestionHandlers } from "./app/useSuggestionHandlers";
import { useThreadRoster } from "./app/useThreadRoster";
import { useCrewHandlers } from "./app/useCrewHandlers";
import { useOnboarding } from "./app/useOnboarding";
import { useIssueStarters } from "./app/useIssueStarters";
import { useAppShortcuts } from "./app/useAppShortcuts";
import { useSidebarResize } from "./app/useSidebarResize";
import { lazyNamed } from "./lazyNamed";

// Views and dialogs that are closed at boot load on first use, so their code
// stays out of the cold-start parse (#1475 finding 7).
const PrListView = lazyNamed(() =>
  import("./components/PrListView").then((m) => m.PrListView),
);
const KanbanView = lazyNamed(() =>
  import("./components/KanbanView").then((m) => m.KanbanView),
);
const PlanboardView = lazyNamed(() =>
  import("./components/PlanboardView").then((m) => m.PlanboardView),
);
const AutomationsView = lazyNamed(() =>
  import("./components/AutomationsView").then((m) => m.AutomationsView),
);
const ActivityView = lazyNamed(() =>
  import("./components/ActivityView").then((m) => m.ActivityView),
);
const InsightsView = lazyNamed(() =>
  import("./components/InsightsView").then((m) => m.InsightsView),
);
const UsageView = lazyNamed(() =>
  import("./components/UsageView").then((m) => m.UsageView),
);
const FleetView = lazyNamed(() =>
  import("./components/FleetView").then((m) => m.FleetView),
);
const DigestView = lazyNamed(() =>
  import("./components/DigestView").then((m) => m.DigestView),
);
const SettingsModal = lazyNamed(() =>
  import("./components/SettingsModal").then((m) => m.SettingsModal),
);
const OnboardingModal = lazyNamed(() =>
  import("./components/onboarding/OnboardingModal").then((m) => m.OnboardingModal),
);
const AddProjectPathModal = lazyNamed(() =>
  import("./components/AddProjectPathModal").then((m) => m.AddProjectPathModal),
);
const EditProjectModal = lazyNamed(() =>
  import("./components/EditProjectModal").then((m) => m.EditProjectModal),
);
const CommandPalette = lazyNamed(() =>
  import("./components/CommandPalette").then((m) => m.CommandPalette),
);

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

/**
 * Collapsed sidebar rail (window controls + Show sidebar). The macOS desktop
 * window draws its traffic lights at x 16..72 (hiddenInset), so the rail is
 * wide enough to hold them instead of letting them cover the page header.
 */
const SIDEBAR_RAIL_WIDTH =
  !isWebMode() &&
  typeof navigator !== "undefined" &&
  /Mac/i.test(navigator.platform || navigator.userAgent || "")
    ? 84
    : 44;

export type DrawerId = "sidebar" | "agents";

type AppProps = {
  /**
   * Test seam. Production reads compile-time __BUILD_SHA__; node tests
   * leave that identifier undeclared (and ESM cannot see a globalThis
   * assignment), so App-level mismatch tests pass a stamped value here.
   */
  rendererSha?: string | null;
};

/**
 * Latches true the first time `open` is true, so a lazy dialog loads on first
 * use and then stays mounted (dialogs keep in-flight callbacks across close).
 */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

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
    ensureScratchProject,
    updateProject,
    createThread,
    listBaseBranches,
    forkThread,
    startRun,
    rewindAndResubmit,
    queued,
    cancelQueued,
    retryQueued,
    steerQueued,
    savePlan,
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
    setPendingWorktree,
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
    prStatus,
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
    listEditors,
    openWorktreeIn,
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
  // Bumped on every Settings close so the Skills tab (mounted behind the
  // modal the whole time) reloads instead of showing what it had before an
  // install/import/add happened in Settings → Skills & MCP.
  const [skillsRefreshKey, setSkillsRefreshKey] = useState(0);
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
  /** Wide layouts: the thread sidebar folds to a rail (#1411, ⌘B). */
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return window.localStorage.getItem("app:sidebarHidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarHidden((hidden) => {
      const next = !hidden;
      try {
        window.localStorage.setItem("app:sidebarHidden", next ? "1" : "0");
      } catch {
        // storage blocked: still toggle for this session
      }
      return next;
    });
  }, []);
  /** Manual inspector tabs for this renderer session. Collapse unmounts the panel. */
  const [inspectorChoices, setInspectorChoices] = useState<
    Record<string, PanelTab>
  >({});
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
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;
  const inspectorProjectIdRef = useRef<string | null>(null);
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
  const rememberInspectorTab = useCallback(
    (
      tab: PanelTab,
      context?: {
        view?: string;
        threadId?: string | null;
        projectId?: string | null;
      },
    ) => {
      const viewName = context?.view ?? viewRef.current;
      const threadId =
        context && "threadId" in context
          ? (context.threadId ?? null)
          : viewName === "thread"
            ? selectedThreadIdRef.current
            : null;
      const projectId =
        context && "projectId" in context
          ? (context.projectId ?? null)
          : inspectorProjectIdRef.current;
      const key = inspectorContextKey({ view: viewName, threadId, projectId });
      setInspectorChoices((prev) =>
        prev[key] === tab ? prev : { ...prev, [key]: tab },
      );
    },
    [],
  );
  const revealAgentsTeam = useCallback(
    (threadId?: string) => {
      if (narrow) setDrawer("agents");
      else setAgentsCollapsed(false);
      // The header calls this as an onClick, so the first argument can be the event.
      const id =
        typeof threadId === "string" ? threadId : selectedThreadIdRef.current;
      rememberInspectorTab("agents", {
        view: "thread",
        threadId: id,
        projectId: inspectorProjectIdRef.current,
      });
    },
    [narrow, rememberInspectorTab],
  );
  const openCrewIntegration = useCallback(
    (leadId: string) => {
      handleSelectThread(leadId);
      revealAgentsTeam(leadId);
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

  const {
    openThreads,
    openKanban,
    openPlanboard,
    openPrs,
    openAutomations,
    openActivity,
    openUsage,
    openFleet,
    openInsights,
    loadFailureModes,
    loadFleetEvidence,
    openDigest,
    handleReturnToView,
  } = useViewNavigation({
    api,
    viewRef,
    returnToRef,
    projectsRef,
    selectedThreadProjectIdRef,
    setView,
    setDrawer,
    setReturnTo,
    setViewRestore,
    setRepeatDraft,
    setKanbanProjectId,
    setPlanboardProjectId,
    setActivityProjectId,
  });
  const openSettings = useCallback((pane?: SettingsPane) => {
    setSettingsPane(pane ?? "general");
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSkillsRefreshKey((n) => n + 1);
  }, []);
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

  const startWithoutProject = useCallback(
    async (threadId: string) => {
      const scratch = await ensureScratchProject();
      if (scratch) await setThreadProject(threadId, scratch.id);
    },
    [ensureScratchProject, setThreadProject],
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

  // "Implement in a new thread" (#1501): the ordinary fork path, out of
  // plan mode, with the plan as its first prompt.
  const handleImplementPlan = useCallback(
    async (plan: string) => {
      if (!selectedThreadId) return;
      const t = await forkThread(selectedThreadId, { leavePlan: true });
      if (!t) return;
      await startRun(`Implement this plan:\n\n${plan}`, t.id);
    },
    [selectedThreadId, forkThread, startRun],
  );

  const handleSavePlan = useCallback(
    (plan: string) => savePlan(plan),
    [savePlan],
  );

  const handleSteerQueued = useCallback(
    (index: number) => void steerQueued(index),
    [steerQueued],
  );

  const handleEditQueued = useCallback(
    (prompt: string, items?: string[]) => {
      return editQueued(prompt, undefined, items);
    },
    [editQueued],
  );

  const {
    handleSetArchived,
    handleClearSettled,
    dismissArchiveToast,
    undoArchive,
    handleDeleteThread,
    dismissDeleteToast,
    undoDelete,
    handleRemoveProject,
    dismissRemoveFail,
  } = useThreadRemoval({
    selectedThreadId,
    projects,
    projectById,
    setArchived,
    deleteThread,
    restoreThread,
    removeProject,
    archiveToastIds,
    setArchiveToastIds,
    deleteToastId,
    setDeleteToastId,
    setRemoveFailMessage,
  });

  // Close the center Changes panel when switching threads (old behavior).
  useEffect(() => {
    setChangesOpen(false);
  }, [selectedThreadId]);

  useConflictForecast({
    threads,
    selectedProjectId,
    conflictForecast,
    setForecast,
  });

  useEffect(() => {
    if (drawer === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const {
    persistLastIfRemembering,
    collapseAgents,
    collapseAgentsForPanes,
    toggleAgents,
  } = useAgentsPanelCollapse({
    settings,
    narrow,
    agentsCollapsed,
    setAgentsCollapsed,
    setDrawer,
    collapseSourceRef,
    rememberLastRef,
    appliedPanelDefaultRef,
    agentsExpandRef,
  });

  useAppShortcuts({
    toggleSidebar,
    narrow,
    toggleAgents,
    paletteModeRef,
    setPaletteMode,
    setPaletteOpen,
  });

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

  const inspectorSummary =
    view === "thread" && selectedThreadId
      ? (threads.find((t) => t.id === selectedThreadId) ?? null)
      : null;
  // Same project object AgentsPanel receives. Board and activity scope can differ.
  const inspectorProjectId = project?.id ?? null;
  inspectorProjectIdRef.current = inspectorProjectId;
  const inspectorKey = inspectorContextKey({
    view,
    threadId: view === "thread" ? selectedThreadId : null,
    projectId: inspectorProjectId,
  });
  const inspectorTab =
    inspectorChoices[inspectorKey] ??
    defaultInspectorTab({
      view,
      summary: inspectorSummary,
      threads,
      workflow: view === "thread" && visibleDetail ? visibleDetail.workflow : null,
    });

  const {
    handleStartSuggestion,
    handleFileSuggestion,
    handleDismissSuggestion,
  } = useSuggestionHandlers({
    selectedThreadId,
    project,
    forkThread,
    startRun,
    createIssue,
    resolveSuggestion,
    setChipError,
  });

  const {
    handoffSource,
    workerCount,
    previousWorktree,
    panelRosterKey,
    comparePeers,
  } = useThreadRoster({
    threads,
    visibleDetail,
    providers,
  });

  const {
    handleImportCliSession,
    handleCreateThreadFromIssue,
    handleCheckoutPr,
  } = useIssueStarters({
    settings,
    providers,
    importCliSession,
    fetchIssue,
    createThread,
    startRun,
    setIssuePlanStatus,
    setProvider,
    setReasoningEffort,
    setPermissionMode,
    checkoutPr,
    setView,
    setRevealThreadId,
  });

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

  const {
    finishOnboarding,
    handleCreateFirstThread,
    showOnboarding,
    onboardingOpen,
  } = useOnboarding({
    settings,
    saveSettings,
    createThread,
    selectThread,
    setProvider,
    createdFirstThreadRef,
    onboardingDismissed,
    setOnboardingDismissed,
    onboardingForceOpen,
    setOnboardingForceOpen,
    setSettingsOpen,
    setView,
    setRevealThreadId,
  });

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

  const {
    onSidebarResizePointerDown,
    onSidebarResizeKeyDown,
    onSidebarResizeReset,
  } = useSidebarResize({
    narrow,
    sidebarDragRef,
    sidebarPaneRef,
    preferredSidebarRef,
    sidebarFitRef,
    setPreferredSidebarWidth,
  });

  const {
    integrateSelectedWorker,
    verifySelectedLead,
    landSelectedLead,
  } = useCrewHandlers({
    selectedThreadId,
    visibleDetail,
    integrateWorker,
    runVerify,
    crewIntegration,
    createPr,
    mergeWorktree,
  });
  const paletteLoaded = useOpenedOnce(paletteOpen);
  const settingsLoaded = useOpenedOnce(settingsOpen);
  const onboardingLoaded = useOpenedOnce(onboardingOpen);

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
        data-sidebar-hidden={!narrow && sidebarHidden ? "true" : undefined}
        style={
          narrow
            ? undefined
            : ({
                "--sidebar-width": sidebarHidden
                  ? `${SIDEBAR_RAIL_WIDTH}px`
                  : `${sidebarWidth}px`,
              } as CSSProperties)
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
          {!narrow && sidebarHidden ? (
            <div className={styles.sidebarRail} data-sidebar-rail="">
              <div className={styles.sidebarRailDrag} />
              <button
                type="button"
                className={styles.sidebarRailBtn}
                data-sidebar-show=""
                aria-label="Show sidebar"
                title="Show sidebar (⌘B)"
                onClick={toggleSidebar}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                  <path d="M6 2.5v11" />
                </svg>
              </button>
            </div>
          ) : null}
          <div
            className={styles.sidebarBody}
            hidden={!narrow && sidebarHidden}
          >
          <ErrorBoundary pane="Sidebar">
            <Sidebar
        appName="Solenta"
        onCollapseSidebar={narrow ? undefined : toggleSidebar}
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
        memoryEntries={appStatus?.memory.entries ?? null}
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
        </div>
        {!narrow && !sidebarHidden && (
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
          <Suspense fallback={null}>
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
              providers={providers}
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
        onSetPendingWorktree={setPendingWorktree}
        previousWorktree={previousWorktree}
        heroProjects={projects}
        onMoveDraftToProject={handleSetThreadProject}
        onStartWithoutProject={(id) => void startWithoutProject(id)}
        agentsPanelOpen={narrow ? drawer === "agents" : !agentsCollapsed}
        onToggleAgentsPanel={toggleAgents}
        onRefreshWorkerSnapshot={refreshWorkerSnapshot}
        conflictContext={conflictContext}
        onOpenWorktree={openInEditor}
        listEditors={listEditors}
        onOpenWorktreeIn={openWorktreeIn}
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
        onSteerQueued={handleSteerQueued}
        onImplementPlan={handleImplementPlan}
        onSavePlan={handleSavePlan}
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
        onPrStatus={prStatus}
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
          </Suspense>
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
            <AgentsPanel
        onCollapse={narrow ? undefined : collapseAgents}
        workflow={visibleDetail?.workflow ?? null}
        thread={visibleDetail?.thread ?? null}
        onRetryAgent={retryWorkflowAgent}
        usage={visibleDetail?.usage ?? null}
        providers={providers}
        project={project}
        rosterKey={panelRosterKey}
        listThreadSummaries={listThreadSummaries}
        listCrewTasks={listCrewTasks}
        crewIntegration={crewIntegration}
        onIntegrateWorker={selectedThreadId ? integrateSelectedWorker : undefined}
        onRefreshWorker={refreshWorkerSnapshot}
        onVerifyLead={selectedThreadId ? verifySelectedLead : undefined}
        onLandLead={selectedThreadId ? landSelectedLead : undefined}
        tab={inspectorTab}
        onTabChange={rememberInspectorTab}
        onSelectThread={handleSelectThread}
        onViewChanges={openChanges}
        fetchDiff={fetchDiff}
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
        listSkills={listSkills}
        removeSkill={removeSkill}
        syncSkills={syncSkills}
        onOpenSettings={openSettings}
        skillsRefreshKey={skillsRefreshKey}
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
        <Suspense fallback={null}>
        {paletteLoaded && (
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
        )}
        </Suspense>
        <Suspense fallback={null}>
        {settingsLoaded && (
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
          onOpenConnection={(input) => api.app.openRemoteConnection(input)}
          onForgetConnection={(input) => api.app.forgetRemoteConnection(input)}
          projects={projects}
          currentProjectId={project?.id ?? null}
          onSetSpotlight={setSpotlight}
          projectTools={{
            loadCodeMap,
            lintAgentConfig,
            previewAgentConfig,
            writeAgentConfig,
          }}
          skills={{
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
            listSkillCatalog,
            pickSkillImport,
            previewSkillImport,
            installSkillImport,
            discardSkillImport,
            detectHarnessSources,
            previewHarnessImport,
            installHarnessImport,
            discardHarnessImport,
          }}
        />
        )}
        </Suspense>
        <Suspense fallback={null}>
        {onboardingLoaded && (
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
        )}
        </Suspense>
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
        <Suspense fallback={null}>
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
        </Suspense>
      </div>
    </div>
  );
}
