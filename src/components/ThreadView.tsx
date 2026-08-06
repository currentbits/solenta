import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ProjectInfo,
  ThreadDetail,
  WorkLogItem,
} from "../shared/ipc";
import { splitParagraphs } from "../format";
import {
  buildTimeline,
  workLogDurationLabel,
  type WorkLogGroup,
} from "../timeline";
import { Composer } from "./Composer";
import styles from "./ThreadView.module.css";

const STICK_BOTTOM_PX = 80;

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

function WorkLogCard({
  group,
  defaultOpen,
}: {
  group: WorkLogGroup;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const duration = workLogDurationLabel(group.items);

  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.cardHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.chevron} data-open={open}>
          ▸
        </span>
        <span className={styles.cardTitle}>Work Log</span>
      </button>
      {open && (
        <>
          <ul className={styles.steps}>
            {group.items.map((step: WorkLogItem) => (
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
  );
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevThreadId = useRef<string | null>(null);

  const runningAgents = useMemo(() => {
    if (!detail?.workflow) return 0;
    return detail.workflow.phases.reduce(
      (n, phase) =>
        n + phase.agents.filter((a) => a.status === "running").length,
      0,
    );
  }, [detail]);

  const timeline = useMemo(() => {
    if (!detail) return [];
    return buildTimeline(detail.messages, detail.workLog);
  }, [detail]);

  const latestWorkLogRunId = useMemo(() => {
    let latest: WorkLogGroup | null = null;
    for (const entry of timeline) {
      if (entry.kind === "worklog") {
        if (!latest || entry.timestamp >= latest.timestamp) latest = entry;
      }
    }
    return latest?.runId ?? null;
  }, [timeline]);

  const isWorking = detail?.thread.status === "working";
  const emptyMessages = detail != null && detail.messages.length === 0;
  const hasTimeline = timeline.length > 0;

  // Reset stick-to-bottom when switching threads.
  useEffect(() => {
    const id = detail?.thread.id ?? null;
    if (id !== prevThreadId.current) {
      prevThreadId.current = id;
      stickToBottom.current = true;
    }
  }, [detail?.thread.id]);

  // Auto-scroll on new content only if the user is already near the bottom.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [timeline, isWorking, detail?.messages, detail?.workLog]);

  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance <= STICK_BOTTOM_PX;
  };

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

  const { thread } = detail;

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

      <div
        className={styles.body}
        ref={bodyRef}
        onScroll={onBodyScroll}
      >
        {emptyMessages && !hasTimeline && (
          <div className={styles.emptyInline}>
            <p className={styles.emptyTitle}>
              Start by describing what to build
            </p>
          </div>
        )}

        {timeline.map((entry) => {
          if (entry.kind === "message") {
            return (
              <MessageBlock key={entry.message.id} message={entry.message} />
            );
          }
          return (
            <WorkLogCard
              key={`worklog-${entry.runId}`}
              group={entry}
              defaultOpen={entry.runId === latestWorkLogRunId}
            />
          );
        })}

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
