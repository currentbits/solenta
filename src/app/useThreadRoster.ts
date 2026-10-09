import { useMemo } from "react";
import type { UseCoderResult } from "../useCoder";
import { sameTaskPeers, toComparePeer } from "../divergence";
import { isDirectCrewChild, sameCrewProject } from "../crewIntegration";

/**
 * Values the memo'd panes derive from the churning thread list. Each one only
 * moves when the part the pane cares about moves (issue #91).
 */
export function useThreadRoster({
  threads,
  visibleDetail,
  providers,
}: {
  threads: UseCoderResult["threads"];
  visibleDetail: UseCoderResult["detail"];
  providers: UseCoderResult["providers"];
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

  return {
    handoffSource,
    workerCount,
    previousWorktree,
    panelRosterKey,
    comparePeers,
    threadTitles,
  };
}
