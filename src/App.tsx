import { useEffect, useState } from "react";
import { useCoder } from "./useCoder";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { AgentsPanel } from "./components/AgentsPanel";
import { SettingsModal } from "./components/SettingsModal";
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
    setArchived,
    deleteThread,
    setupWorktree,
    mergeWorktree,
    removeWorktree,
    fetchDiff,
    pushBranch,
    appStatus,
    settings,
    saveSettings,
    projectById,
  } = useCoder();

  const [changesOpen, setChangesOpen] = useState(false);
  const [changesNonce, setChangesNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        projectError={error?.scope === "project" ? error.message : null}
        onDismissProjectError={clearError}
        onOpenSettings={() => setSettingsOpen(true)}
        spendTodayUsd={appStatus?.spendTodayUsd ?? null}
        dailyBudgetUsd={settings?.dailyBudgetUsd ?? null}
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
        onSetArchived={(archived) => setArchived(archived)}
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
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        status={appStatus}
        onSaveSettings={(patch) => saveSettings(patch)}
      />
    </div>
  );
}
