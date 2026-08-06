import { useMemo, useState } from "react";
import type { ChatMessage, ProjectInfo, ThreadDetail } from "../shared/ipc";
import { splitParagraphs } from "../format";
import { Composer } from "./Composer";
import styles from "./ThreadView.module.css";

interface ThreadViewProps {
  detail: ThreadDetail | null;
  project: ProjectInfo | null;
  hasProjects: boolean;
  onAddProject: () => void;
  onStartRun: (prompt: string) => void | Promise<void>;
  onStopRun: () => void | Promise<void>;
  runError?: string | null;
  onDismissRunError?: () => void;
}

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <article className={`${styles.message} ${styles.messageUser}`}>
        <div className={styles.userBubble}>{message.text}</div>
      </article>
    );
  }

  if (message.role === "event") {
    return (
      <section className={styles.card}>
        <div className={styles.eventTitle}>{message.text}</div>
      </section>
    );
  }

  const paragraphs = splitParagraphs(message.text);
  return (
    <article className={styles.message}>
      {paragraphs.map((p, i) => (
        <p key={`${message.id}-${i}`}>{p}</p>
      ))}
    </article>
  );
}

function workLogDuration(items: ThreadDetail["workLog"]): string | null {
  if (items.length === 0) return null;
  const times = items.map((i) => i.timestamp);
  const span = Math.max(...times) - Math.min(...times);
  const secs = Math.max(0, Math.floor(span / 1000));
  if (secs < 60) return `Worked for ${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `Worked for ${m}m ${s}s` : `Worked for ${m}m`;
}

export function ThreadView({
  detail,
  project,
  hasProjects,
  onAddProject,
  onStartRun,
  onStopRun,
  runError = null,
  onDismissRunError,
}: ThreadViewProps) {
  const [workLogOpen, setWorkLogOpen] = useState(true);

  const runningAgents = useMemo(() => {
    if (!detail?.workflow) return 0;
    return detail.workflow.phases.reduce(
      (n, phase) =>
        n + phase.agents.filter((a) => a.status === "running").length,
      0,
    );
  }, [detail]);

  const isWorking = detail?.thread.status === "working";

  if (!hasProjects) {
    return (
      <main className={styles.main}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Add a project to get started</p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={onAddProject}
          >
            Add project
          </button>
        </div>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className={styles.main}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Select a thread</p>
          <p className={styles.emptyHint}>
            Choose a thread from the sidebar, or create a new one.
          </p>
        </div>
      </main>
    );
  }

  const { thread, messages, workLog } = detail;
  const duration = workLogDuration(workLog);
  const showWorkLog = workLog.length > 0;
  const emptyMessages = messages.length === 0;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.breadcrumb}>
          <span className={styles.project}>
            {project?.slug ?? "project"}
          </span>
          <span className={styles.sep}>/</span>
          <span className={styles.threadTitle}>{thread.title}</span>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.btn}>
            Setup Worktree
          </button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`}>
            Push
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {showWorkLog && (
          <section className={styles.card}>
            <button
              type="button"
              className={styles.cardHeader}
              onClick={() => setWorkLogOpen((v) => !v)}
              aria-expanded={workLogOpen}
            >
              <span className={styles.chevron} data-open={workLogOpen}>
                ▸
              </span>
              <span className={styles.cardTitle}>Work Log</span>
            </button>
            {workLogOpen && (
              <>
                <ul className={styles.steps}>
                  {workLog.map((step) => (
                    <li key={step.id} className={styles.step}>
                      <span
                        className={styles.checkbox}
                        data-done={step.done}
                        aria-hidden
                      >
                        {step.done ? "✓" : ""}
                      </span>
                      <span className={styles.stepLabel}>{step.label}</span>
                    </li>
                  ))}
                </ul>
                {duration && (
                  <footer className={styles.workLogFooter}>{duration}</footer>
                )}
              </>
            )}
          </section>
        )}

        {emptyMessages && (
          <div className={styles.emptyInline}>
            <p className={styles.emptyTitle}>
              Start by describing what to build
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBlock key={msg.id} message={msg} />
        ))}

        {isWorking && (
          <div className={styles.statusStrip}>
            <div className={styles.statusLeft}>
              <span className={styles.statusDot} aria-hidden />
              <span>
                {runningAgents} agent{runningAgents === 1 ? "" : "s"} working
                in the background
              </span>
            </div>
            <button
              type="button"
              className={styles.stopBtn}
              onClick={() => void onStopRun()}
            >
              Stop
            </button>
          </div>
        )}
      </div>

      <Composer
        branch={thread.branch}
        disabled={isWorking}
        onBuild={onStartRun}
        error={runError}
        onDismissError={onDismissRunError}
      />
    </main>
  );
}
