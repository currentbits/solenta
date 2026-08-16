import { useCallback, useEffect, useState } from "react";
import { useCoder } from "./useCoder";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { PrListView } from "./components/PrListView";
import { KanbanView } from "./components/KanbanView";
import { PlanboardView } from "./components/PlanboardView";
import { AutomationsView } from "./components/AutomationsView";
import { ActivityView } from "./components/ActivityView";
import { AgentsPanel } from "./components/AgentsPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ArchiveToast } from "./components/ArchiveToast";
import { AddProjectPathModal } from "./components/AddProjectPathModal";
import { EditProjectModal } from "./components/EditProjectModal";
import { WebTokenGate } from "./components/WebTokenGate";
import { isWebMode } from "./shared/wire";
import type { ProjectUpdateInput } from "./shared/ipc";
import styles from "./App.module.css";

export type AppView =
  | "thread"
  | "kanban"
  | "planboard"
  | "prs"
  | "automations"
  | "activity";

export default function App() {
  const {
    api,
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
    createProject,
    updateProject,
    createThread,
    forkThread,
    startRun,
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
        setArchiveToastIds([id]);
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
      for (const id of ids) {
        await setArchived(true, id);
      }
      setArchiveToastIds(ids);
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

  const openChanges = () => {
    setChangesOpen(true);
    setChangesNonce((n) => n + 1);
  };

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

  const handleCreateThreadFromIssue = useCallback(
    async (input: { projectId: string; projectPath: string; ref: string }) => {
      const fetched = await fetchIssue(input.projectPath, input.ref);
      if (!fetched.ok) return fetched;
      const issue = fetched.issue;
      let thread;
      try {
        thread = await createThread(issue.title, input.projectId);
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
          <ErrorBoundary pane="Sidebar">
            <Sidebar
        appName="Solenta"
        channel={appStatus?.build.channel ?? null}
        searchPlaceholder="Search threads…"
        projectsHeader="All projects"
        projects={projects}
        threads={threads}
        providers={providers}
        activeThreadId={selectedThreadId}
        onSelectThread={handleSelectThread}
        activeView={view}
        onOpenKanban={() => setView("kanban")}
        onOpenPlanboard={() => setView("planboard")}
        onOpenPrs={() => setView("prs")}
        onOpenAutomations={() => setView("automations")}
        onOpenActivity={() => setView("activity")}
        onCreateThread={(projectId, opts) => {
          void createThread("New Thread", projectId, opts).then((t) => {
            if (t) setRevealThreadId(t.id);
          });
        }}
        revealThreadId={revealThreadId}
        onRevealHandled={() => setRevealThreadId(null)}
        onCreateThreadFromIssue={handleCreateThreadFromIssue}
        onAddProject={handleAddProject}
        onRemoveProject={handleRemoveProject}
        onEditProject={setEditProjectId}
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
        onClearSettled={(ids) => {
          void handleClearSettled(ids);
        }}
        onFork={(threadId, opts) => {
          void forkThread(threadId, opts);
        }}
            />
          </ErrorBoundary>
        </div>
        <div className={styles.threadSlot} data-pane="thread">
          <ErrorBoundary pane="Thread view">
          {view === "activity" ? (
            <ActivityView
              projects={projects}
              listActivity={listActivity}
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
              onCreateThread={() => {
                void createThread("New Thread");
              }}
              autoSettleAfterDays={
                settings == null ? undefined : settings.autoSettleAfterDays
              }
            />
          ) : (
            <ThreadView
        detail={visibleDetail}
        project={project}
        providers={providers}
        workflows={workflows}
        hasProjects={projects.length > 0}
        onAddProject={handleAddProject}
        onStartRun={(prompt, threadId, attachments) =>
          startRun(prompt, threadId, attachments)
        }
        onStartWorkflow={(prompt, templateId) =>
          startWorkflowRun(prompt, templateId)
        }
        onSaveWorkflow={(template) => saveWorkflow(template)}
        onRemoveWorkflow={(id) => removeWorkflow(id)}
        onStopRun={() => stopRun()}
        onSetPermissionMode={(mode) => setPermissionMode(mode)}
        onRespondPermission={(requestId, decision, answers) =>
          respondPermission(requestId, decision, answers)
        }
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
        onLoadImage={loadToolImage}
        onPickAttachments={isWebMode() ? undefined : pickAttachments}
        onSaveAttachmentImage={saveAttachmentImage}
        onLoadAttachmentImage={loadAttachmentImage}
        onDropAttachmentFiles={isWebMode() ? undefined : dropAttachmentFiles}
        onPush={() => pushBranch()}
        gitSyncInfo={gitSyncInfo}
        gitFetch={gitFetch}
        listDevScripts={listDevScripts}
        startDevServer={startDevServer}
        stopDevServer={stopDevServer}
        devServerStatus={devServerStatus}
        runError={error?.scope === "run" ? error.message : null}
        onDismissRunError={clearError}
        onFork={async (opts) => {
          if (!selectedThreadId) return null;
          return forkThread(selectedThreadId, opts);
        }}
        threads={threads}
        onSelectThread={handleSelectThread}
        onModelPickerOpen={() => {
          void refreshProviders();
        }}
            />
          )}
          </ErrorBoundary>
        </div>
        <div className={styles.agentsSlot} data-pane="agents">
          <ErrorBoundary pane="Agents panel">
            <AgentsPanel
        workflow={visibleDetail?.workflow ?? null}
        thread={visibleDetail?.thread ?? null}
        usage={visibleDetail?.usage ?? null}
        providers={providers}
        project={project}
        threads={threads}
        listThreadSummaries={listThreadSummaries}
        onSelectThread={handleSelectThread}
        onSetupWorktree={() => setupWorktree()}
        onMergeWorktree={() => mergeWorktree()}
        onRemoveWorktree={(force) => removeWorktree(force)}
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
          />
          </ErrorBoundary>
        </div>
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
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
            onClose={() => setEditProjectId(null)}
            onSubmit={submitEditProject}
          />
        )}
      </div>
    </div>
  );
}
