import { useCallback, useEffect, useState } from "react";
import { useCoder } from "./useCoder";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { AgentsPanel } from "./components/AgentsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ArchiveToast } from "./components/ArchiveToast";
import styles from "./App.module.css";

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
    pushBranch,
    createPr,
    prStatus,
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

  return (
    <div className={styles.app}>
      <Sidebar
        appName="Coder"
        searchPlaceholder="Search threads…"
        projectsHeader="All projects"
        projects={projects}
        threads={threads}
        providers={providers}
        activeThreadId={selectedThreadId}
        onSelectThread={selectThread}
        onCreateThread={(projectId) => {
          void createThread("New Thread", projectId);
        }}
        onAddProject={() => {
          void addProject();
        }}
        onRemoveProject={handleRemoveProject}
        projectError={error?.scope === "project" ? error.message : null}
        onDismissProjectError={clearError}
        onOpenSettings={() => setSettingsOpen(true)}
        spendTodayUsd={appStatus?.spendTodayUsd ?? null}
        dailyBudgetUsd={settings?.dailyBudgetUsd ?? null}
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
      />
      <ThreadView
        detail={detail}
        project={project}
        providers={providers}
        workflows={workflows}
        hasProjects={projects.length > 0}
        onAddProject={() => {
          void addProject();
        }}
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
        onFetchDiff={() => fetchDiff()}
        onPush={() => pushBranch()}
        runError={error?.scope === "run" ? error.message : null}
        onDismissRunError={clearError}
      />
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
        searchMemory={searchMemory}
        recentMemory={recentMemory}
        getMemory={getMemory}
        updateMemory={updateMemory}
        removeMemory={removeMemory}
        storeMemory={storeMemory}
      />
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
    </div>
  );
}
