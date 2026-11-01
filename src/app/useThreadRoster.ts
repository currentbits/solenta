import { useMemo } from "react";
import type { UseCoderResult } from "../useCoder";
import { sameTaskPeers, toComparePeer } from "../divergence";
import { isDirectCrewChild, sameCrewProject } from "../crewIntegration";
import { taskGroupRollup, taskRepoTargets } from "../taskGroup";
import type { TaskGroupRollup } from "../taskGroup";

/** One thread on another computer, as a link (#1831). */
export interface FarLink {
  id: string;
  title: string;
  host: string | null;
  status: string | null;
  /** Its computer is connected, so the thread opens here live. */
  reachable: boolean;
}
export interface FarLinks {
  workers: FarLink[];
  lead: FarLink | null;
  to: FarLink | null;
  from: FarLink | null;
}

/**
 * Values the memo'd panes derive from the churning thread list. Each one only
 * moves when the part the pane cares about moves (issue #91).
 */
export function useThreadRoster({
  threads,
  visibleDetail,
  providers,
  projects,
}: {
  threads: UseCoderResult["threads"];
  visibleDetail: UseCoderResult["detail"];
  providers: UseCoderResult["providers"];
  projects: UseCoderResult["projects"];
}) {
  /** Provenance of a handed-off thread; a stable object while the row is. */
  const handoffFrom = visibleDetail?.thread.handoffFrom ?? null;
  const handoffSource = useMemo(() => {
    if (!handoffFrom) return null;
    const parent = threads.find((t) => t.id === handoffFrom) ?? null;
    if (!parent || !sameCrewProject(parent, visibleDetail?.thread)) return null;
    return parent;
  }, [threads, handoffFrom, visibleDetail?.thread]);
  /** Direct same-project orchWorker children. Manual forks and cross-project rows do not count. */
  const workerCount = useMemo(() => {
    const parent = visibleDetail?.thread;
    if (!parent) return 0;
    let n = 0;
    for (const t of threads) {
      if (isDirectCrewChild(t, parent)) n++;
    }
    return n;
  }, [threads, visibleDetail?.thread]);

  /** Draft strip "Previous worktree": the project's most recently active
   *  other worktree thread (#1411). */
  const previousWorktree = useMemo(() => {
    const cur = visibleDetail?.thread;
    if (!cur) return null;
    let best: (typeof threads)[number] | null = null;
    for (const t of threads) {
      if (t.id === cur.id || t.projectId !== cur.projectId) continue;
      if (t.archived || !t.worktreePath || !t.branch) continue;
      if (!best || t.updatedAt > best.updatedAt) best = t;
    }
    return best?.branch ? { branch: best.branch, title: best.title } : null;
  }, [threads, visibleDetail?.thread]);

  /** What the Agents team view refetches on: ids + statuses, not identity. */
  const rosterKey = useMemo(
    () => threads.map((t) => `${t.id}:${t.status}`).join(","),
    [threads],
  );

  /** Agents panel refetch key: only the selected thread's project, so a
   *  working thread elsewhere does not keep the team poll alive (#1398). */
  const panelRosterKey = useMemo(() => {
    const pid = visibleDetail?.thread.projectId;
    if (!pid) return "";
    return threads
      .filter((t) => t.projectId === pid)
      .map((t) => `${t.id}:${t.status}`)
      .join(",");
  }, [threads, visibleDetail?.thread.projectId]);

  /** Global run queue order (issue #166), as a stable string key. */
  const runQueueKey = useMemo(
    () =>
      threads
        .filter((t) => t.runQueue)
        .sort((a, b) => a.runQueue!.at - b.runQueue!.at)
        .map((t) => t.id)
        .join(","),
    [threads],
  );
  const runQueueIds = useMemo(
    () => (runQueueKey ? runQueueKey.split(",") : []),
    [runQueueKey],
  );

  /** Thread ids in replies link to these (#1531): the open thread's project
   *  only, id → title, rebuilt when an id or title moves, not on stream ticks. */
  const titlesKey = useMemo(() => {
    const pid = visibleDetail?.thread.projectId;
    if (!pid) return "[]";
    return JSON.stringify(
      threads
        .filter((t) => t.projectId === pid)
        .map((t) => [t.id.toLowerCase(), t.title]),
    );
  }, [threads, visibleDetail?.thread.projectId]);
  const threadTitles = useMemo(
    () => Object.fromEntries(JSON.parse(titlesKey)) as Record<string, string>,
    [titlesKey],
  );

  /**
   * Same-task siblings for the divergence card. Keyed on roster + the open
   * thread so a 700ms stream tick on an unrelated row does not rebuild this.
   */
  const comparePeers = useMemo(() => {
    if (!visibleDetail) return [];
    const peers = sameTaskPeers(visibleDetail.thread, threads);
    return peers.map((t) => toComparePeer(t, peers, providers));
  }, [
    visibleDetail?.thread.id,
    visibleDetail?.thread.handoffFrom,
    visibleDetail?.thread.projectId,
    rosterKey,
    providers,
  ]);

  /** Multi-repo task (#263) banner + "Add repo" targets, as a value key so
   *  stream ticks on unrelated rows keep the identity. */
  const taskKey = useMemo(() => {
    const cur = visibleDetail?.thread
      ? (threads.find((t) => t.id === visibleDetail.thread.id) ?? visibleDetail.thread)
      : null;
    return JSON.stringify({
      rollup: taskGroupRollup(cur, threads, projects),
      targets: taskRepoTargets(cur, threads, projects),
    });
  }, [threads, projects, visibleDetail?.thread]);
  const { taskGroup, taskTargets } = useMemo(() => {
    const v = JSON.parse(taskKey) as {
      rollup: TaskGroupRollup | null;
      targets: { id: string; name: string }[];
    };
    return { taskGroup: v.rollup, taskTargets: v.targets };
  }, [taskKey]);

  /**
   * Work on other computers this thread links to (#1831), T3-style: each a
   * live thread you can open here when its computer is connected. Value-keyed
   * so stream ticks elsewhere keep the identity.
   */
  const farKey = useMemo(() => {
    const cur = visibleDetail?.thread;
    if (!cur) return "null";
    const row = (id: string | undefined | null) => (id ? threads.find((t) => t.id === id) ?? null : null);
    const link = (id: string, title: string | null, host: string | null) => {
      const r = row(id);
      return { id, title: r?.title || title || "Untitled", host: r?.host?.label ?? host, status: r?.status ?? null, reachable: Boolean(r) };
    };
    const workers = (cur.remoteWorkers ?? []).map((w) => link(w.threadId, w.title, w.hostLabel));
    const lead = cur.crewRelay ? link(cur.crewRelay.leadId, cur.crewRelay.leadTitle, null) : null;
    const to = cur.teleportedTo?.threadId && !cur.teleportedTo.pending
      ? link(cur.teleportedTo.threadId, cur.title, cur.teleportedTo.label ?? null)
      : null;
    const from = cur.teleportedFrom ? link(cur.teleportedFrom.threadId, cur.title, null) : null;
    if (!workers.length && !lead && !to && !from) return "null";
    return JSON.stringify({ workers, lead, to, from });
  }, [threads, visibleDetail?.thread]);
  const farLinks = useMemo(() => JSON.parse(farKey) as FarLinks | null, [farKey]);

  return {
    farLinks,
    taskGroup,
    taskTargets,
    handoffSource,
    workerCount,
    previousWorktree,
    panelRosterKey,
    runQueueIds,
    comparePeers,
    threadTitles,
  };
}
