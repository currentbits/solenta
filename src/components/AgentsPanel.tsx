import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentStatus,
  DiffResult,
  PhaseView,
  ProjectInfo,
  SessionUsage,
  ThreadInfo,
  WorkflowView,
} from "../shared/ipc";
import {
  formatCostUsd,
  formatTokenSum,
  permissionModeLabel,
  shortSessionId,
} from "../format";
import styles from "./AgentsPanel.module.css";

type PanelTab = "agents" | "git";

interface AgentsPanelProps {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
  project: ProjectInfo | null;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: () => Promise<unknown>;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  onFetchDiff: () => Promise<DiffResult>;
}

type PhaseChipStatus = "done" | "active" | "pending" | "failed";
type DotStatus = "active" | "done" | "pending" | "error";
type GitAction = "setup" | "merge" | "remove" | null;

function phaseStatus(phase: PhaseView): PhaseChipStatus {
  if (phase.agents.length === 0) return "pending";
  if (phase.agents.some((a) => a.status === "running")) return "active";
  const allSettled = phase.agents.every((a) => a.status === "settled");
  if (allSettled) return "done";
  const allFinished = phase.agents.every(
    (a) => a.status === "settled" || a.status === "failed",
  );
  if (allFinished && phase.agents.some((a) => a.status === "failed")) {
    return "failed";
  }
  return "pending";
}

function phaseClass(status: PhaseChipStatus): string {
  if (status === "done") return styles.phaseDone;
  if (status === "active") return styles.phaseActive;
  if (status === "failed") return styles.phaseFailed;
  return styles.phasePending;
}

function toDot(status: AgentStatus): DotStatus {
  if (status === "running") return "active";
  if (status === "settled") return "done";
  if (status === "failed") return "error";
  return "pending";
}

function dotClass(status: DotStatus): string {
  if (status === "done") return styles.dotDone;
  if (status === "active") return styles.dotActive;
  if (status === "error") return styles.dotError;
  return styles.dotPending;
}

function groupKey(phaseName: string, index: number): string {
  return `${index}:${phaseName}`;
}

function SessionCard({
  thread,
  usage,
}: {
  thread: ThreadInfo;
  usage: SessionUsage | null;
}) {
  const sess = shortSessionId(thread.sessionId);
  return (
    <section className={styles.sessionCard}>
      <div className={styles.sessionHead}>
        <div>
          <div className={styles.sessionLabel}>Session</div>
          <div className={styles.sessionProvider}>{thread.provider}</div>
        </div>
        {sess && (
          <span className={styles.sessionId} title={thread.sessionId ?? undefined}>
            {sess}
          </span>
        )}
      </div>

      <dl className={styles.sessionMeta}>
        <div className={styles.sessionRow}>
          <dt>Model</dt>
          <dd>{usage?.model ?? "n/a"}</dd>
        </div>
        <div className={styles.sessionRow}>
          <dt>Permission</dt>
          <dd>{permissionModeLabel(thread.permissionMode)}</dd>
        </div>
      </dl>

      <div className={styles.usageBlock}>
        <div className={styles.usageTitle}>Usage</div>
        {usage ? (
          <dl className={styles.usageList}>
            <div className={styles.sessionRow}>
              <dt>Input tokens</dt>
              <dd>{usage.inputTokens.toLocaleString()}</dd>
            </div>
            <div className={styles.sessionRow}>
              <dt>Output tokens</dt>
              <dd>{usage.outputTokens.toLocaleString()}</dd>
            </div>
            <div className={styles.sessionRow}>
              <dt>Turns</dt>
              <dd>{usage.turns}</dd>
            </div>
            <div className={styles.sessionRow}>
              <dt>Cost</dt>
              <dd className={styles.cost}>{formatCostUsd(usage.costUsd)}</dd>
            </div>
          </dl>
        ) : (
          <p className={styles.usageEmpty}>No usage yet</p>
        )}
      </div>
    </section>
  );
}

function DiffLine({ line }: { line: string }) {
  let kind = "ctx";
  if (line.startsWith("+++") || line.startsWith("---")) kind = "meta";
  else if (line.startsWith("@@")) kind = "hunk";
  else if (line.startsWith("+")) kind = "add";
  else if (line.startsWith("-")) kind = "del";
  return (
    <div className={styles.diffLine} data-kind={kind}>
      {line || " "}
    </div>
  );
}

function WorktreeCard({
  thread,
  busy,
  gitAction,
  dirtyMessage,
  cardError,
  onSetup,
  onMerge,
  onDelete,
  onForceDelete,
  onCancelDirty,
  onDismissError,
}: {
  thread: ThreadInfo | null;
  busy: boolean;
  gitAction: GitAction;
  dirtyMessage: string | null;
  cardError: string | null;
  onSetup: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onForceDelete: () => void;
  onCancelDirty: () => void;
  onDismissError: () => void;
}) {
  const hasWorktree = Boolean(thread?.worktreePath);
  const branch = thread?.branch ?? null;
  const path = thread?.worktreePath ?? null;
  const setupPending = gitAction === "setup";

  return (
    <section className={styles.gitCard}>
      <div className={styles.gitCardLabel}>Worktree</div>

      {!thread ? (
        <p className={styles.gitHint}>Select a thread to manage its worktree.</p>
      ) : !hasWorktree ? (
        <>
          <p className={styles.gitHint}>
            Create a git worktree so runs execute on an isolated branch.
          </p>
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnPrimary}`}
              onClick={onSetup}
              disabled={busy}
            >
              {setupPending ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Setting up…
                </>
              ) : (
                "Set up worktree"
              )}
            </button>
          </div>
        </>
      ) : (
        <>
          {branch && (
            <div className={styles.worktreeBranch} title={branch}>
              {branch}
            </div>
          )}
          {path && (
            <div className={styles.worktreePath} title={path}>
              {path}
            </div>
          )}
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnPrimary}`}
              onClick={onMerge}
              disabled={busy}
            >
              {gitAction === "merge" ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Merging…
                </>
              ) : (
                "Merge to main"
              )}
            </button>
            <button
              type="button"
              className={styles.gitBtn}
              onClick={onDelete}
              disabled={busy}
            >
              {gitAction === "remove" && !dirtyMessage ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </button>
          </div>
        </>
      )}

      {dirtyMessage && (
        <div className={styles.dirtyBlock} role="alert">
          <pre className={styles.dirtyMessage}>{dirtyMessage}</pre>
          <div className={styles.gitActions}>
            <button
              type="button"
              className={`${styles.gitBtn} ${styles.gitBtnDanger}`}
              onClick={onForceDelete}
              disabled={busy}
            >
              {gitAction === "remove" ? (
                <>
                  <span className={styles.btnSpinner} aria-hidden />
                  Deleting…
                </>
              ) : (
                "Delete anyway"
              )}
            </button>
            <button
              type="button"
              className={styles.gitBtn}
              onClick={onCancelDirty}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {cardError && (
        <div className={styles.cardError} role="alert">
          <span className={styles.cardErrorText}>{cardError}</span>
          <button
            type="button"
            className={styles.cardErrorDismiss}
            onClick={onDismissError}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}

function ChangesCard({
  threadId,
  active,
  onFetchDiff,
}: {
  threadId: string | null;
  active: boolean;
  onFetchDiff: () => Promise<DiffResult>;
}) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const load = async () => {
    const forThread = threadId;
    setLoading(true);
    setError(null);
    try {
      const result = await onFetchDiff();
      // Drop late results if the user switched threads mid-flight.
      if (threadIdRef.current !== forThread) return;
      setDiff(result);
      setLoadedFor(forThread);
    } catch (err) {
      if (threadIdRef.current !== forThread) return;
      setError(
        err instanceof Error && err.message ? err.message : "Failed to load diff",
      );
    } finally {
      if (threadIdRef.current === forThread) setLoading(false);
    }
  };

  useEffect(() => {
    setDiff(null);
    setError(null);
    setLoadedFor(null);
  }, [threadId]);

  useEffect(() => {
    if (!active || !threadId) return;
    if (loadedFor === threadId) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lazy load when Git tab opens / thread changes
  }, [active, threadId, loadedFor]);

  const empty =
    !loading &&
    !error &&
    diff != null &&
    diff.files.length === 0 &&
    !diff.patch.trim();

  return (
    <section className={styles.gitCard}>
      <div className={styles.changesHead}>
        <div className={styles.gitCardLabel}>Changes</div>
        <button
          type="button"
          className={styles.gitBtn}
          onClick={() => void load()}
          disabled={loading || !threadId}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className={styles.inlineError} role="alert">
          {error}
        </div>
      )}

      {loading && !diff && (
        <p className={styles.changesEmpty}>Loading diff…</p>
      )}

      {empty && <p className={styles.changesEmpty}>No changes</p>}

      {diff && !empty && (
        <>
          {diff.files.length > 0 && (
            <ul className={styles.fileList}>
              {diff.files.map((f) => (
                <li key={f.path} className={styles.fileRow}>
                  <span className={styles.fileStatus}>{f.status}</span>
                  <span className={styles.filePath}>{f.path}</span>
                  <span className={styles.fileStats}>
                    <span className={styles.adds}>+{f.additions}</span>
                    <span className={styles.dels}>−{f.deletions}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {diff.patch.trim() !== "" && (
            <div className={styles.patchScroll}>
              {diff.patch.split("\n").map((line, i) => (
                <DiffLine key={i} line={line} />
              ))}
            </div>
          )}
          {diff.truncated && (
            <p className={styles.truncatedNote}>Diff truncated</p>
          )}
        </>
      )}
    </section>
  );
}

function GitTab({
  thread,
  project,
  onSetupWorktree,
  onMergeWorktree,
  onRemoveWorktree,
  onFetchDiff,
  active,
}: {
  thread: ThreadInfo | null;
  project: ProjectInfo | null;
  onSetupWorktree: () => Promise<unknown>;
  onMergeWorktree: () => Promise<unknown>;
  onRemoveWorktree: (force?: boolean) => Promise<unknown>;
  onFetchDiff: () => Promise<DiffResult>;
  active: boolean;
}) {
  const [gitAction, setGitAction] = useState<GitAction>(null);
  const [dirtyMessage, setDirtyMessage] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  const isWorking = thread?.status === "working";
  const busy = isWorking || gitAction != null;

  useEffect(() => {
    setDirtyMessage(null);
    setCardError(null);
    setGitAction(null);
  }, [thread?.id]);

  const runAction = async (
    action: Exclude<GitAction, null>,
    fn: () => Promise<unknown>,
  ) => {
    setGitAction(action);
    setCardError(null);
    try {
      await fn();
      setDirtyMessage(null);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Git action failed";
      const dirtyMarker = "WORKTREE_DIRTY:";
      const dirtyAt = msg.indexOf(dirtyMarker);
      if (dirtyAt !== -1) {
        // Electron wraps invoke rejections ("Error invoking remote method …");
        // strip everything through the marker so only the listed entries show.
        setDirtyMessage(msg.slice(dirtyAt + dirtyMarker.length).trim());
        setCardError(null);
      } else {
        setCardError(msg);
      }
    } finally {
      setGitAction(null);
    }
  };

  const statusLine = (() => {
    if (!thread) return "No thread selected";
    const provider = thread.provider;
    if (thread.worktreePath && thread.branch) {
      return `${provider} · ${thread.branch}`;
    }
    if (thread.branch) {
      return `${provider} · ${thread.branch}`;
    }
    if (project) {
      return `${provider} · ${project.slug}`;
    }
    return provider;
  })();

  return (
    <>
      <div className={styles.scroll}>
        <WorktreeCard
          thread={thread}
          busy={busy}
          gitAction={gitAction}
          dirtyMessage={dirtyMessage}
          cardError={cardError}
          onSetup={() => void runAction("setup", () => onSetupWorktree())}
          onMerge={() => void runAction("merge", () => onMergeWorktree())}
          onDelete={() =>
            void runAction("remove", () => onRemoveWorktree(false))
          }
          onForceDelete={() =>
            void runAction("remove", () => onRemoveWorktree(true))
          }
          onCancelDirty={() => setDirtyMessage(null)}
          onDismissError={() => setCardError(null)}
        />
        <ChangesCard
          threadId={thread?.id ?? null}
          active={active}
          onFetchDiff={onFetchDiff}
        />
      </div>
      <footer className={styles.gitStatus} title={statusLine}>
        {statusLine}
      </footer>
    </>
  );
}

function AgentsContent({
  workflow,
  thread,
  usage,
}: {
  workflow: WorkflowView | null;
  thread: ThreadInfo | null;
  usage: SessionUsage | null;
}) {
  /**
   * Manual expand/collapse overrides. Absent key = not toggled by user,
   * so active phases auto-expand and others stay collapsed.
   */
  const [manual, setManual] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setManual({});
  }, [workflow?.id]);

  const groups = useMemo(() => {
    if (!workflow) return [];
    return workflow.phases
      .map((phase, index) => ({ phase, index }))
      .filter(({ phase }) => phase.agents.length > 0)
      .map(({ phase, index }) => {
        const status = phaseStatus(phase);
        const activeCount = phase.agents.filter(
          (a) => a.status === "running",
        ).length;
        const doneCount = phase.agents.filter(
          (a) => a.status === "settled",
        ).length;
        const id = groupKey(phase.name, index);
        return {
          id,
          name: phase.name.toUpperCase(),
          status,
          activeCount,
          doneCount,
          agents: phase.agents,
        };
      });
  }, [workflow]);

  const isOpen = (id: string, status: PhaseChipStatus): boolean => {
    if (Object.prototype.hasOwnProperty.call(manual, id)) {
      return manual[id]!;
    }
    return status === "active";
  };

  const toggle = (id: string, currentlyOpen: boolean) => {
    setManual((prev) => ({ ...prev, [id]: !currentlyOpen }));
  };

  if (!workflow) {
    return (
      <div className={styles.scroll}>
        {thread ? (
          <SessionCard thread={thread} usage={usage} />
        ) : (
          <p className={styles.placeholder}>No active session</p>
        )}
      </div>
    );
  }

  const working = workflow.phases.reduce(
    (n, p) => n + p.agents.filter((a) => a.status === "running").length,
    0,
  );

  return (
    <>
      <div className={styles.scroll}>
        <section className={styles.workflow}>
          <div className={styles.workflowHead}>
            <div>
              <div className={styles.workflowLabel}>Workflow</div>
              <div className={styles.workflowName}>{workflow.name}</div>
            </div>
            <div className={styles.settled}>
              {workflow.settled}/{workflow.total} settled
            </div>
          </div>

          <div
            className={styles.pipeline}
            role="list"
            aria-label="Workflow phases"
          >
            {workflow.phases.map((phase, index) => {
              const status = phaseStatus(phase);
              return (
                <div
                  key={groupKey(phase.name, index)}
                  className={styles.phaseWrap}
                  role="listitem"
                >
                  {index > 0 && (
                    <span className={styles.connector} aria-hidden />
                  )}
                  <span
                    className={`${styles.phaseChip} ${phaseClass(status)}`}
                  >
                    {status === "active" && (
                      <span className={styles.dots} aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                    {status === "done" && (
                      <span className={styles.phaseCheck} aria-hidden>
                        ✓
                      </span>
                    )}
                    {status === "failed" && (
                      <span className={styles.phaseFailMark} aria-hidden>
                        !
                      </span>
                    )}
                    {phase.name}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <div className={styles.groups}>
          {groups.map((group) => {
            const open = isOpen(group.id, group.status);
            return (
              <section key={group.id} className={styles.group}>
                <button
                  type="button"
                  className={styles.groupHeader}
                  onClick={() => toggle(group.id, open)}
                  aria-expanded={open}
                >
                  <span className={styles.chevron} data-open={open}>
                    ▸
                  </span>
                  <span className={styles.groupName}>{group.name}</span>
                  <span className={styles.groupMeta}>
                    · {group.activeCount} active · {group.doneCount} done
                  </span>
                </button>
                {open && (
                  <ul className={styles.agentList}>
                    {group.agents.map((agent) => {
                      const dot = toDot(agent.status);
                      return (
                        <li key={agent.id} className={styles.agentRow}>
                          <span
                            className={`${styles.dot} ${dotClass(dot)}`}
                            aria-label={agent.status}
                          />
                          <span className={styles.agentLabel}>
                            {agent.id}
                            <span className={styles.agentModel}>
                              {" "}
                              / {agent.model}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>

      <footer className={styles.footer}>
        <span>
          {working} working · {workflow.settled} settled
        </span>
        <span className={styles.tokens}>
          {formatTokenSum(workflow.tokensTotal)}
        </span>
      </footer>
    </>
  );
}

export function AgentsPanel({
  workflow,
  thread,
  usage,
  project,
  onSetupWorktree,
  onMergeWorktree,
  onRemoveWorktree,
  onFetchDiff,
}: AgentsPanelProps) {
  const [tab, setTab] = useState<PanelTab>("agents");

  return (
    <aside className={styles.panel}>
      <header className={styles.tabs}>
        <button
          type="button"
          className={styles.tab}
          data-active={tab === "agents"}
          onClick={() => setTab("agents")}
        >
          Agents
        </button>
        <button
          type="button"
          className={styles.tab}
          data-active={tab === "git"}
          onClick={() => setTab("git")}
        >
          Git
        </button>
      </header>

      {tab === "agents" ? (
        <AgentsContent workflow={workflow} thread={thread} usage={usage} />
      ) : (
        <GitTab
          thread={thread}
          project={project}
          onSetupWorktree={onSetupWorktree}
          onMergeWorktree={onMergeWorktree}
          onRemoveWorktree={onRemoveWorktree}
          onFetchDiff={onFetchDiff}
          active={tab === "git"}
        />
      )}
    </aside>
  );
}
