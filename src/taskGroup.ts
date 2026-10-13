/**
 * Multi-repo task roll-up (#263): one thread per repo, grouped by
 * `taskGroupId`. Pure so the banner and its tests share one source.
 */
import type { PrLink, ProjectInfo, ThreadInfo, ThreadStatus } from "./shared/ipc";
import { normalizePrLinks } from "./prLinks";

export interface TaskGroupMember {
  id: string;
  title: string;
  projectName: string;
  status: ThreadStatus;
  prs: PrLink[];
  current: boolean;
}

export interface TaskGroupRollup {
  members: TaskGroupMember[];
  prsMerged: number;
  prsTotal: number;
}

type Row = Pick<
  ThreadInfo,
  "id" | "title" | "projectId" | "status" | "createdAt" | "taskGroupId" | "prNumber" | "prUrl" | "prLinks"
> & { prState?: ThreadInfo["prState"] };

/** The open thread's task across repos; null unless it has a sibling. */
export function taskGroupRollup(
  thread: Row | null | undefined,
  threads: Row[],
  projects: Pick<ProjectInfo, "id" | "name">[],
): TaskGroupRollup | null {
  const gid = thread?.taskGroupId;
  if (!thread || !gid) return null;
  const rows = threads
    .filter((t) => t.taskGroupId === gid)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (rows.length < 2) return null;
  const members = rows.map((t) => ({
    id: t.id,
    title: t.title,
    projectName: projects.find((p) => p.id === t.projectId)?.name ?? "Deleted project",
    status: t.status,
    prs: normalizePrLinks(t),
    current: t.id === thread.id,
  }));
  const prs = members.flatMap((m) => m.prs);
  return {
    members,
    prsMerged: prs.filter((p) => p.state === "MERGED").length,
    prsTotal: prs.length,
  };
}

/** Projects the open thread's task can still grow into: real repos not already in it. */
export function taskRepoTargets(
  thread: Row | null | undefined,
  threads: Row[],
  projects: Pick<ProjectInfo, "id" | "name" | "scratch">[],
): { id: string; name: string }[] {
  if (!thread) return [];
  const taken = new Set([thread.projectId]);
  if (thread.taskGroupId) {
    for (const t of threads) {
      if (t.taskGroupId === thread.taskGroupId) taken.add(t.projectId);
    }
  }
  return projects
    .filter((p) => !p.scratch && !taken.has(p.id))
    .map((p) => ({ id: p.id, name: p.name }));
}
