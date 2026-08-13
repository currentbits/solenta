import { useCallback, useEffect, useState } from "react";
import { useCoder } from "./useCoder";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { PrListView } from "./components/PrListView";
import { KanbanView } from "./components/KanbanView";
import { AgentsPanel } from "./components/AgentsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ArchiveToast } from "./components/ArchiveToast";
import { AddProjectPathModal } from "./components/AddProjectPathModal";
import { WebTokenGate } from "./components/WebTokenGate";
import { isWebMode } from "./shared/wire";
import styles from "./App.module.css";

export type AppView = "thread" | "kanban" | "prs";

export default function App() {
  const {
    projects,
    threads,
    providers,
    workflows,
    selectedThreadId,
    selectThread,
    detail,
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
    prChecks,
    prMerge,
    listPrs,
    listCheckpoints,
    restoreCheckpoint,
    runStats,
    listLocalServers,
    revealInFinder,
    openInEditor,
    gitSyncInfo,
    gitFetch,
    appStatus,
    settings,
    saveSettings,
    projectById,
    searchMemory,
    recentMemory,
    getMemory,
    updateMemory,
    removeMemory,
    storeMemory,
    searchThreads,
  } = useCoder();

  const [changesOpen, setChangesOpen] = useState(false);
  const [changesNonce, setChangesNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Synara-style undo toast after an immediate archive. */
  const [archiveToastId, setArchiveToastId] = useState<string | null>(null);
  /**
   * Error toast after projects.remove rejects. Title is t3-shaped:
   * Failed to remove "slug". Cleared on dismiss / timeout.
   */
  const [removeFailSlug, setRemoveFailSlug] = useState<string | null>(null);
  const [addPathOpen, setAddPathOpen] = useState(false);
  const [view, setView] = useState<AppView>("thread");

  const handleSelectThread = useCallback(
    (id: string) => {
      setView("thread");
      selectThread(id);
    },
    [selectThread],
  );

  const handleSetArchived = useCallback(
    async (archived: boolean) => {
      if (archived) {
        // Capture id before setArchived moves selection off the open thread.
        const id = selectedThreadId;
        if (!id) return;
        setRemoveFailSlug(null);
        await setArchived(true, id);
        setArchiveToastId(id);
      } else {
        setArchiveToastId(null);
        await setArchived(false);
      }
    },
    [selectedThreadId, setArchived],
  );

  const dismissArchiveToast = useCallback(() => {
    setArchiveToastId(null);
  }, []);

  const undoArchive = useCallback(async () => {
    if (!archiveToastId) return;
    const id = archiveToastId;
    setArchiveToastId(null);
    await setArchived(false, id);
  }, [archiveToastId, setArchived]);

  const handleRemoveProject = useCallback(
    async (projectId: string) => {
      const slug =
        projectById.get(projectId)?.slug ??
        projects.find((p) => p.id === projectId)?.slug ??
        projectId;
      setArchiveToastId(null);
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

  const openChanges = () => {
    setChangesOpen(true);
    setChangesNonce((n) => n + 1);
  };

  const project =
    (detail && projectById.get(detail.thread.projectId)) ||
    (selectedProjectId ? projectById.get(selectedProjectId) : undefined) ||
    null;

  const handleAddProject = useCallback(() => {
    if (isWebMode()) {
      setAddPathOpen(true);
      return;
    }
    void addProject();
  }, [addProject]);

  const submitAddPath = useCallback(
    async (path: string) => {
      const added = await addProject(path);
      if (added) setAddPathOpen(false);
      return added;
    },
    [addProject],
  );

  return (
    <div className={styles.shell}>
      {isWebMode() && <WebTokenGate />}
      <div className={styles.app} data-layout="app">
        <input
          type="checkbox"
          id="drawer-sidebar"
          className={styles.drawerToggle}
          data-drawer="sidebar"
        />
        <input
          type="checkbox"
          id="drawer-agents"
          className={styles.drawerToggle}
          data-drawer="agents"
        />
        <div className={styles.narrowBar} data-narrow-chrome="">
          <label
            htmlFor="drawer-sidebar"
            className={styles.narrowBtn}
            data-drawer-open="sidebar"
          >
            Threads
          </label>
          <label
            htmlFor="drawer-agents"
            className={styles.narrowBtn}
            data-drawer-open="agents"
          >
            Agents
          </label>
        </div>
        <label
          htmlFor="drawer-sidebar"
          className={`${styles.scrim} ${styles.scrimSidebar}`}
          data-scrim="sidebar"
          aria-hidden
        />
        <label
          htmlFor="drawer-agents"
          className={`${styles.scrim} ${styles.scrimAgents}`}
          data-scrim="agents"
          aria-hidden
        />
        <div className={styles.sidebarSlot} data-pane="sidebar">
          <Sidebar
        appName="Coder"
        searchPlaceholder="Search threads…"
        projectsHeader="All projects"
        projects={projects}
        threads={threads}
        providers={providers}
        activeThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        activeView={view}
        onOpenKanban={() => setView("kanban")}
        onOpenPrs={() => setView("prs")}
        onCreateThread={(projectId) => {
          void createThread("New Thread", projectId);
        }}
        onAddProject={handleAddProject}
        onRemoveProject={handleRemoveProject}
        projectError={error?.scope === "project" ? error.message : null}
        onDismissProjectError={clearError}
        onOpenSettings={() => setSettingsOpen(true)}
        spendTodayUsd={appStatus?.spendTodayUsd ?? null}
        dailyBudgetUsd={settings?.dailyBudgetUsd ?? null}
        autoSettleAfterDays={
          settings == null ? undefined : settings.autoSettleAfterDays
        }
        searchThreads={searchThreads}
        onSetSettled={(threadId, override) => {
          void setSettled(threadId, override);
        }}
        onSetPinned={(threadId, pinned) => {
          void setPinned(threadId, pinned);
        }}
        onSetSnoozed={(threadId, until) => {
          void setSnoozed(threadId, until);
        }}
        onSetArchived={(threadId, archived) => {
          void setArchived(archived, threadId);
        }}
        onFork={(threadId, opts) => {
          void forkThread(threadId, opts);
        }}
          />
        </div>
        <div className={styles.threadSlot} data-pane="thread">
          {view === "prs" ? (
            <PrListView
              projects={projects}
              threads={threads}
              listPrs={listPrs}
              onSelectThread={handleSelectThread}
            />
          ) : view === "kanban" ? (
            <KanbanView
              threads={threads}
              projects={projects}
              providers={providers}
              onSelectThread={handleSelectThread}
              onCreateThread={() => {
                void createThread("New Thread");
              }}
              autoSettleAfterDays={
                settings == null ? undefined : settings.autoSettleAfterDays
              }
            />
          ) : (
            <ThreadView
        detail={detail}
        project={project}
        providers={providers}
        workflows={workflows}
        hasProjects={projects.length > 0}
        onAddProject={handleAddProject}
        onStartRun={(prompt) => startRun(prompt)}
        onStartWorkflow={(prompt, templateId) =>
          startWorkflowRun(prompt, templateId)
        }
        onSaveWorkflow={(template) => saveWorkflow(template)}
        onRemoveWorkflow={(id) => removeWorkflow(id)}
        onStopRun={() => stopRun()}
        onSetPermissionMode={(mode) => setPermissionMode(mode)}
        onSetProvider={(input) => setProvider(input)}
        onSetReasoningEffort={(effort) => setReasoningEffort(effort)}
        onSetArchived={(archived) => {
          void handleSetArchived(archived);
        }}
        onDeleteThread={() => deleteThread()}
        changesOpen={changesOpen}
        changesNonce={changesNonce}
        onCloseChanges={() => setChangesOpen(false)}
        onViewChanges={openChanges}
        runStats={runStats}
        restoreCheckpoint={restoreCheckpoint}
        onFetchDiff={() => fetchDiff()}
        onCommitChanges={(message) => commitChanges(message)}
        onRevertFile={(path, status) => revertFile(path, status)}
        onSuggestCommitMessage={() => suggestCommitMessage()}
        onListFiles={(query) => listFiles(query)}
        onPush={() => pushBranch()}
        runError={error?.scope === "run" ? error.message : null}
        onDismissRunError={clearError}
        onFork={(opts) => {
          if (!selectedThreadId) return;
          void forkThread(selectedThreadId, opts);
        }}
        threads={threads}
        onSelectThread={handleSelectThread}
            />
          )}
        </div>
        <div className={styles.agentsSlot} data-pane="agents">
          <AgentsPanel
        workflow={detail?.workflow ?? null}
        thread={detail?.thread ?? null}
        usage={detail?.usage ?? null}
        providers={providers}
        project={project}
        onSetupWorktree={() => setupWorktree()}
        onMergeWorktree={() => mergeWorktree()}
        onRemoveWorktree={(force) => removeWorktree(force)}
        onViewChanges={openChanges}
        onPush={() => pushBranch()}
        createPr={(input) => createPr(input)}
        prStatus={() => prStatus()}
        prChecks={() => prChecks()}
        prMerge={() => prMerge()}
        listCheckpoints={listCheckpoints}
        restoreCheckpoint={restoreCheckpoint}
        listLocalServers={listLocalServers}
        revealInFinder={revealInFinder}
        openInEditor={openInEditor}
        gitSyncInfo={gitSyncInfo}
        gitFetch={gitFetch}
        searchMemory={searchMemory}
        recentMemory={recentMemory}
        getMemory={getMemory}
        updateMemory={updateMemory}
        removeMemory={removeMemory}
        storeMemory={storeMemory}
          />
        </div>
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          status={appStatus}
          onSaveSettings={(patch) => saveSettings(patch)}
        />
        {archiveToastId && (
          <ArchiveToast
            key={`archive-${archiveToastId}`}
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
          />
        )}
      </div>
    </div>
  );
}
