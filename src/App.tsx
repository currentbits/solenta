import { useCoder } from "./useCoder";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { AgentsPanel } from "./components/AgentsPanel";
import styles from "./App.module.css";

export default function App() {
  const {
    projects,
    threads,
    selectedThreadId,
    selectThread,
    detail,
    selectedProjectId,
    error,
    clearError,
    addProject,
    createThread,
    startRun,
    stopRun,
    setPermissionMode,
    setupWorktree,
    fetchDiff,
    projectById,
  } = useCoder();

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
        activeThreadId={selectedThreadId}
        onSelectThread={selectThread}
        onCreateThread={() => {
          void createThread("New Thread");
        }}
        onAddProject={() => {
          void addProject();
        }}
        projectError={error?.scope === "project" ? error.message : null}
        onDismissProjectError={clearError}
      />
      <ThreadView
        detail={detail}
        project={project}
        hasProjects={projects.length > 0}
        onAddProject={() => {
          void addProject();
        }}
        onStartRun={(prompt) => startRun(prompt)}
        onStopRun={() => stopRun()}
        onSetPermissionMode={(mode) => setPermissionMode(mode)}
        onSetupWorktree={() => setupWorktree()}
        onFetchDiff={() => fetchDiff()}
        runError={error?.scope === "run" ? error.message : null}
        onDismissRunError={clearError}
      />
      <AgentsPanel
        workflow={detail?.workflow ?? null}
        thread={detail?.thread ?? null}
        usage={detail?.usage ?? null}
      />
    </div>
  );
}
