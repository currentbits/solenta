import { useCallback, useEffect, useRef, useState } from "react";
import { isDirectCrewChild } from "../crewIntegration";
import { errorMessage } from "../coder/errorMessage";
import type {
  CoderApi,
  PendingApprovalInfo,
  ProjectInfo,
  ThreadInfo,
} from "../shared/ipc";
import { PermissionPrompt } from "./thread/cards";
import styles from "./WorkerApprovals.module.css";

export interface WorkerApprovalsProps {
  parent: ThreadInfo;
  threads: readonly ThreadInfo[];
  projects: readonly ProjectInfo[];
  loadApprovals: CoderApi["threads"]["pendingApprovals"];
  respond: CoderApi["threads"]["respondPermission"];
  subscribe?: CoderApi["on"];
  onOpenWorker: (id: string) => void;
}

const computer = (t: ThreadInfo) => t.host?.key ?? "";
const identity = (t: ThreadInfo) => JSON.stringify([computer(t), t.projectId, t.id]);

/** A foreign computer's project ids differ; only an explicit remote-worker link crosses that boundary. */
export function approvalWorkers(
  parent: ThreadInfo,
  threads: readonly ThreadInfo[],
): ThreadInfo[] {
  const seen = new Set<string>();
  return threads.filter((t) => {
    if (t.archived || identity(t) === identity(parent)) return false;
    const direct = computer(t) === computer(parent) && isDirectCrewChild(t, parent);
    const remote = parent.remoteWorkers?.some(
      (w) => w.threadId === t.id && w.hostKey === t.host?.key,
    );
    if (!direct && !remote) return false;
    const key = identity(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function WorkerRequests({
  worker,
  projects,
  loadApprovals,
  respond,
  subscribe,
  onOpenWorker,
}: Omit<WorkerApprovalsProps, "parent" | "threads"> & { worker: ThreadInfo }) {
  const [items, setItems] = useState<PendingApprovalInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const live = useRef(true);
  const current = useRef(worker);
  current.current = worker;
  const currentItems = useRef(items);
  currentItems.current = items;
  const sending = useRef(new Set<string>());
  // A slow read started before an answer must not put its resolved card back.
  const resolved = useRef(new Set<string>());
  const online = !worker.host || worker.host.status === "online";
  const target = identity(worker);

  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    if (!online) return;
    try {
      const rows = await loadApprovals({
        threadId: worker.id,
        ...(worker.host ? { onHost: worker.host.key } : {}),
      });
      if (!live.current || seq !== sequence.current) return;
      const unique = new Map<string, PendingApprovalInfo>();
      for (const row of rows) {
        if (row.threadId === worker.id && row.projectId === worker.projectId) {
          unique.set(row.requestId, row);
        }
      }
      for (const id of resolved.current) {
        if (!unique.has(id)) resolved.current.delete(id);
      }
      setItems([...unique.values()].filter((row) => !resolved.current.has(row.requestId)));
      setError(null);
    } catch (err) {
      if (live.current && seq === sequence.current) setError(errorMessage(err));
    }
  }, [worker.id, worker.projectId, worker.host?.key, online, loadApprovals]);

  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
      sequence.current++;
    };
  }, [refresh, worker]);

  useEffect(() => {
    if (!subscribe || !online) return;
    // A second ask can leave the roster and the head permission unchanged.
    // Listen to that child's detail push instead of relying on row identity.
    const offUpdated = subscribe("thread:updated", (patch) => {
      if (identity(patch.thread) === target) void refresh();
    });
    // Web reconnects send a full list even if all rows reconcile unchanged.
    const offChanged = subscribe("threads:changed", (push) => {
      if (Array.isArray(push)) void refresh();
    });
    return () => { offUpdated(); offChanged(); };
  }, [subscribe, online, target, refresh]);

  if (!online) {
    return (
      <div className={styles.notice} data-worker-unavailable="">
        {worker.title} · {worker.host?.label}: computer offline. Reconnect to review approvals.
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.notice} role="alert">
        Could not load approvals for {worker.title}: {error}{" "}
        <button type="button" onClick={() => void refresh()}>Retry</button>
      </div>
    );
  }
  if (!items.length) return null;
  const project = projects.find(
    (p) => p.id === worker.projectId && (p.host?.key ?? "") === computer(worker),
  );
  return <section className={styles.worker} aria-label={`Approvals from ${worker.title}`}>
    <div className={styles.heading}>
      <strong>{worker.title}</strong>
      <span>{project?.name ?? "Project"} · {worker.host?.label ?? "This computer"}{worker.branch ? ` · ${worker.branch}` : ""}</span>
      <button type="button" onClick={() => onOpenWorker(worker.id)}>Open worker</button>
    </div>
    {items.map((pending) => <div key={pending.requestId} data-worker-request={pending.requestId}>
      {pending.questions?.length || pending.inputRequest || pending.plan ? (
        <p>{pending.summary}. <button type="button" onClick={() => onOpenWorker(worker.id)}>Open worker to answer</button></p>
      ) : <PermissionPrompt
        pending={pending}
        shortcuts={false}
        composerRedirect={false}
        onRespond={async (requestId, decision, answers, updatedCommand, inputValues, feedback, alwaysRule) => {
          const now = current.current;
          if (
            !live.current || identity(now) !== target ||
            (now.host && now.host.status !== "online") ||
            !currentItems.current.some((p) => p.requestId === requestId) ||
            resolved.current.has(requestId)
          ) {
            throw new Error("This worker request is no longer available.");
          }
          if (sending.current.has(requestId)) return;
          sending.current.add(requestId);
          ++sequence.current;
          try {
            await respond({
              threadId: worker.id,
              ...(worker.host ? { onHost: worker.host.key } : {}),
              requestId, decision, answers, updatedCommand,
              inputValues, feedback, alwaysRule,
            });
            resolved.current.add(requestId);
            if (live.current) {
              setItems((prev) => prev.filter((p) => p.requestId !== requestId));
              void refresh();
            }
          } finally {
            sending.current.delete(requestId);
          }
        }}
      />}
    </div>)}
  </section>;
}

/** Pending worker tools share the native approval surface without stealing the parent's prompt or keys. */
export function WorkerApprovals({ parent, threads, ...props }: WorkerApprovalsProps) {
  const workers = approvalWorkers(parent, threads);
  if (!workers.length) return null;
  return (
    <section className={styles.root} aria-label="Worker approvals" data-worker-approvals="">
      {workers.map((worker) => (
        <WorkerRequests
          key={`${identity(worker)}:${worker.runStartedAt}`}
          worker={worker}
          {...props}
        />
      ))}
    </section>
  );
}
