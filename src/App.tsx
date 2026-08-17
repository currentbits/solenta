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
import { DigestView } from "./components/DigestView";
import { AgentsPanel } from "./components/AgentsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ArchiveToast } from "./components/ArchiveToast";
import { AddProjectPathModal } from "./components/AddProjectPathModal";
import { EditProjectModal } from "./components/EditProjectModal";
import { WebTokenGate } from "./components/WebTokenGate";
import { isWebMode } from "./shared/wire";
import { isBuildMismatch } from "./buildMismatch";
import type { ProjectUpdateInput } from "./shared/ipc";
import styles from "./App.module.css";

export type AppView =
  | "thread"
  | "kanban"
  | "planboard"
  | "prs"
  | "automations"
  | "activity"
  | "usage"
  | "insights"
  | "digest";

type DrawerId = "sidebar" | "agents";

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

export default function App() {
  const {
    api,
    projects,
    spaces,
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
    addSpace,
    renameSpace,
    removeSpace,
    assignProjectToSpace,
    createThread,
    forkThread,
    startRun,
    queued,
    cancelQueued,
    fetchIssue,
    startWorkflowRun,
    saveWorkflow,
    removeWorkflow,
    stopRun,
    setPermissionMode,
    respondPermission,
    setProvider,
    setReasoningEffort,
    setArchived,
    setSettled,
    setPinned,
    setSnoozed,
    setMuted,
    renameThread,
    setNotes,
    startSpec,
    reviewSpec,
    specArtifact,
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
    loadToolImage,
    pickAttachments,
    saveAttachmentImage,
    loadAttachmentImage,
    dropAttachmentFiles,
    pushBranch,
    listPrs,
    listIssues,
    setIssuePlanStatus,
    listActivity,
    listUsageByDay,
    listDigest,
    markDigestSeen,
    listThreadSummaries,
    listCheckpoints,
    restoreCheckpoint,
    runStats,
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
    setVerifyCommand,
    runVerify,
    appStatus,
    updateStatus,
    checkUpdate,
    downloadUpdate,
    applyUpdate,
    settings,
    saveSettings,
    refreshProviders,
    projectById,
    searchMemory,
    recentMemory,
    getMemory,
    updateMemory,
    removeMemory,
    storeMemory,
    listSkills,
    addSkill,
    removeSkill,
    syncSkills,
    searchThreads,
    automations,
    addAutomation,
    updateAutomation,
    removeAutomation,
    runAutomationNow,
  } = useCoder();

  const [changesOpen, setChangesOpen] = useState(false);
  const [changesNonce, setChangesNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Synara-style undo toast after an immediate archive (single or bulk clear). */
  const [archiveToastIds, setArchiveToastIds] = useState<string[] | null>(null);
  /**
   * Error toast after projects.remove rejects. Title is t3-shaped:
   * Failed to remove "slug". Cleared on dismiss / timeout.
   */
  const [removeFailSlug, setRemoveFailSlug] = useState<string | null>(null);
  const [addPathOpen, setAddPathOpen] = useState(false);
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("thread");
  /** Freshly created thread the Sidebar should reveal (expand/scroll/flash). */
  const [revealThreadId, setRevealThreadId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const narrow = useNarrow();
  const sidebarPaneRef = useRef<HTMLDivElement>(null);
  const agentsPaneRef = useRef<HTMLDivElement>(null);
  const threadsBtnRef = useRef<HTMLButtonElement>(null);
  const agentsBtnRef = useRef<HTMLButtonElement>(null);
  const lastDrawerRef = useRef<DrawerId | null>(null);

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
  const openKanban = useCallback(() => setView("kanban"), []);
  const openPlanboard = useCallback(() => setView("planboard"), []);
  const openPrs = useCallback(() => setView("prs"), []);
  const openAutomations = useCallback(() => setView("automations"), []);
  const openActivity = useCallback(() => setView("activity"), []);
  const openUsage = useCallback(() => setView("usage"), []);
  const openInsights = useCallback(() => setView("insights"), []);
  const loadFailureModes = useCallback(
    () => api.insights.failureModes(),
    [api],
  );
  const openDigest = useCallback(() => setView("digest"), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeChanges = useCallback(() => setChangesOpen(false), []);
  const openChanges = useCallback(() => {
    setChangesOpen(true);
    setChangesNonce((n) => n + 1);
  }, []);
  const clearReveal = useCallback(() => setRevealThreadId(null), []);

  const handleCreateThread = useCallback(
    (projectId?: string, opts?: { worktree?: boolean; orchestrate?: boolean }) => {
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

  const handleSetNotes = useCallback(
    (threadId: string, notes: string) => {
      void setNotes(threadId, notes);
    },
    [setNotes],
  );

  const handleStartSpec = useCallback(
    (threadId: string) => {
      void startSpec(threadId);
    },
    [startSpec],
  );

  const handleReviewSpec = useCallback(
    (threadId: string, decision: "approve" | "revise", feedback?: string) => {
      void reviewSpec(threadId, decision, feedback);
    },
    [reviewSpec],
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

  const handleModelPickerOpen = useCallback(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // Wrapped, not passed through: this one is bound straight to a button's
  // onClick, so cancelQueued's optional threadId would swallow the DOM event
  // and cancel nothing.
  const handleCancelQueued = useCallback(() => {
    cancelQueued();
  }, [cancelQueued]);

  const handleSetArchived = useCallback(
    async (archived: boolean) => {
      if (archived) {
        // Capture id before setArchived moves selection off the open thread.
        const id = selectedThreadId;
        if (!id) return;
        setRemoveFailSlug(null);
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
      setRemoveFailSlug(null);
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
        setRemoveFailSlug(null);
      } catch {
        setRemoveFailSlug(slug);
        throw new Error(`Failed to remove "${slug}"`);
      }
    },
    [projectById, projects, removeProject],
  );

  const dismissRemoveFail = useCallback(() => {
    setRemoveFailSlug(null);
  }, []);

  // Close the center Changes panel when switching threads (old behavior).
  useEffect(() => {
    setChangesOpen(false);
  }, [selectedThreadId]);

  useEffect(() => {
    if (drawer === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

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

  const handleCreateThreadFromIssue = useCallback(
    async (input: {
      projectId: string;
      projectPath: string;
      ref: string;
      mode?: ThreadStartMode;
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
        thread = await createThread(issue.title, input.projectId, opts);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (!thread) {
        return { ok: false as const, reason: "Could not create thread" };
      }
      const body = issue.body || "";
      const prompt = `GitHub issue #${issue.number}: ${issue.title}\n${issue.url}\n\n${body}`;
      try {
        await startRun(prompt, thread.id);
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
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
    [fetchIssue, createThread, startRun, setIssuePlanStatus],
  );

  const handleAddProject = useCallback(() => {
    setAddPathOpen(true);
  }, []);

  const submitAddPath = useCallback(
    async (
      path: string,
      remotes?: { remoteHost?: string; remotePath?: string },
    ) => {
      const added = await addProject(path, remotes);
      if (added) setAddPathOpen(false);
      return added;
    },
    [addProject],
  );

  const submitCreateProject = useCallback(
    async (name: string, parentDir: string) => {
      const created = await createProject({ name, parentDir });
      if (created) setAddPathOpen(false);
      return created;
    },
    [createProject],
  );

  const pickProjectDirectory = useCallback(
    () => api.projects.pickDirectory(),
    [api],
  );

  const editProject =
    projects.find((p) => p.id === editProjectId) ?? null;

  // Vite replaces __BUILD_SHA__; node tests leave it undeclared.
  const rendererSha =
    typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : null;
  const buildMismatch = isBuildMismatch(appStatus?.build.sha, rendererSha);

  const submitEditProject = useCallback(
    async (input: ProjectUpdateInput) => {
      const updated = await updateProject(input);
      if (updated) setEditProjectId(null);
      return updated;
    },
    [updateProject],
  );

  return (
    <div className={styles.shell}>
      {isWebMode() && <WebTokenGate />}
      {buildMismatch && (
        <div
          className={styles.mismatchBar}
          role="alert"
          data-build-mismatch=""
        >
          <span>This window is out of date. Restart to load the new build.</span>
          <button
            type="button"
            className={styles.mismatchRestart}
            onClick={() => void applyUpdate()}
          >
            Restart
          </button>
        </div>
      )}
      <div
        className={styles.app}
        data-layout="app"
        data-drawer={drawer ?? ""}
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
        channel={appStatus?.build.channel ?? null}
        updateState={updateStatus?.state ?? null}
        searchPlaceholder="Search threads…"
        projectsHeader="All projects"
        projects={projects}
        spaces={spaces}
        threads={threads}
        providers={providers}
        activeThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        activeView={view}
        onOpenKanban={openKanban}
        onOpenPlanboard={openPlanboard}
        onOpenPrs={openPrs}
        onOpenAutomations={openAutomations}
        onOpenActivity={openActivity}
        onOpenUsage={openUsage}
        onOpenInsights={openInsights}
        onOpenDigest={openDigest}
        onCreateThread={handleCreateThread}
        defaultWorktree={settings?.defaultWorktree ?? false}
        revealThreadId={revealThreadId}
        onRevealHandled={clearReveal}
        onCreateThreadFromIssue={handleCreateThreadFromIssue}
        onAddProject={handleAddProject}
        onRemoveProject={handleRemoveProject}
        onEditProject={setEditProjectId}
        onAddSpace={addSpace}
        onRenameSpace={renameSpace}
        onRemoveSpace={removeSpace}
        onAssignProjectToSpace={assignProjectToSpace}
        projectError={error?.scope === "project" ? error.message : null}
        onDismissProjectError={clearError}
        onOpenSettings={openSettings}
        spendTodayUsd={appStatus?.spendTodayUsd ?? null}
        dailyBudgetUsd={settings?.dailyBudgetUsd ?? null}
        autoSettleAfterDays={
          settings == null ? undefined : settings.autoSettleAfterDays
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
              listActivity={listActivity}
              onSelectThread={handleSelectThread}
            />
          ) : view === "usage" ? (
            <UsageView loadUsage={listUsageByDay} />
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
            />
          ) : view === "automations" ? (
            <AutomationsView
              automations={automations}
              projects={projects}
              providers={providers}
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
              listIssues={listIssues}
              threads={threads}
              onSelectThread={handleSelectThread}
              onStartTask={async (input) => {
                const res = await handleCreateThreadFromIssue(input);
                // Land on the thread we just started, unless there is a
                // warning to read here first.
                if (res.ok && !("warning" in res)) setView("thread");
                return res;
              }}
            />
          ) : view === "kanban" ? (
            <KanbanView
              threads={threads}
              projects={projects}
              providers={providers}
              onSelectThread={handleSelectThread}
              onCreateThread={handleCreateThreadPlain}
              autoSettleAfterDays={
                settings == null ? undefined : settings.autoSettleAfterDays
              }
            />
          ) : (
            <ThreadView
        detail={visibleDetail}
        detailError={selectedThreadId ? detailError : null}
        onRetryDetail={retryDetail}
        project={project}
        providers={providers}
        agentProfiles={settings?.agentProfiles ?? []}
        workflows={workflows}
        hasProjects={projects.length > 0}
        onAddProject={handleAddProject}
        onStartRun={startRun}
        onStartWorkflow={startWorkflowRun}
        onSaveWorkflow={saveWorkflow}
        onRemoveWorkflow={removeWorkflow}
        onStopRun={stopRun}
        queuedPrompt={
          selectedThreadId ? (queued[selectedThreadId]?.prompt ?? null) : null
        }
        onCancelQueued={handleCancelQueued}
        onSetPermissionMode={setPermissionMode}
        onRespondPermission={respondPermission}
        onSetProvider={setProvider}
        onSetReasoningEffort={setReasoningEffort}
        onSetArchived={handleSetArchived}
        onRenameThread={handleRenameOpenThread}
        onSetNotes={handleSetNotes}
        onStartSpec={handleStartSpec}
        onReviewSpec={handleReviewSpec}
        onSpecArtifact={specArtifact}
        onDeleteThread={deleteThread}
        changesOpen={changesOpen}
        changesNonce={changesNonce}
        onCloseChanges={closeChanges}
        onViewChanges={openChanges}
        runStats={runStats}
        restoreCheckpoint={restoreCheckpoint}
        onFetchDiff={fetchDiff}
        onCommitChanges={commitChanges}
        onRevertFile={revertFile}
        onSuggestCommitMessage={suggestCommitMessage}
        onListFiles={listFiles}
        onLoadImage={loadToolImage}
        onPickAttachments={pickAttachments}
        onSaveAttachmentImage={saveAttachmentImage}
        onLoadAttachmentImage={loadAttachmentImage}
        onDropAttachmentFiles={dropAttachmentFiles}
        onPush={pushBranch}
        gitSyncInfo={gitSyncInfo}
        gitFetch={gitFetch}
        listDevScripts={listDevScripts}
        startDevServer={startDevServer}
        stopDevServer={stopDevServer}
        devServerStatus={devServerStatus}
        runError={error?.scope === "run" ? error.message : null}
        onDismissRunError={clearError}
        onFork={handleForkOpen}
        handoffSource={handoffSource}
        onSelectThread={handleSelectThread}
        onModelPickerOpen={handleModelPickerOpen}
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
          <ErrorBoundary pane="Agents panel">
            <AgentsPanel
        workflow={visibleDetail?.workflow ?? null}
        thread={visibleDetail?.thread ?? null}
        usage={visibleDetail?.usage ?? null}
        providers={providers}
        project={project}
        rosterKey={rosterKey}
        listThreadSummaries={listThreadSummaries}
        onSelectThread={handleSelectThread}
        onSetupWorktree={setupWorktree}
        onMergeWorktree={mergeWorktree}
        onRemoveWorktree={removeWorktree}
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
        settings={settings}
        saveSettings={saveSettings}
        listSkills={listSkills}
        addSkill={addSkill}
        removeSkill={removeSkill}
        syncSkills={syncSkills}
          />
          </ErrorBoundary>
        </div>
        <SettingsModal
          open={settingsOpen}
          onClose={closeSettings}
          settings={settings}
          providers={providers}
          status={appStatus}
          update={updateStatus}
          onCheckUpdate={checkUpdate}
          onDownloadUpdate={downloadUpdate}
          onApplyUpdate={applyUpdate}
          onSaveSettings={(patch) => saveSettings(patch)}
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
        {removeFailSlug && (
          <ArchiveToast
            key={`remove-fail-${removeFailSlug}`}
            variant="error"
            title={`Failed to remove "${removeFailSlug}"`}
            onDismiss={dismissRemoveFail}
          />
        )}
        {addPathOpen && (
          <AddProjectPathModal
            onClose={() => setAddPathOpen(false)}
            onSubmit={submitAddPath}
            onCreate={submitCreateProject}
            onPickDirectory={
              isWebMode() ? undefined : pickProjectDirectory
            }
          />
        )}
        {editProject && (
          <EditProjectModal
            project={editProject}
            spaces={spaces}
            onClose={() => setEditProjectId(null)}
            onSubmit={submitEditProject}
          />
        )}
      </div>
    </div>
  );
}
