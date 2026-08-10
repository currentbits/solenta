import type { ProjectInfo, ThreadInfo } from "./shared/ipc";

export interface SidebarGroup {
  project: ProjectInfo | null;
  threads: ThreadInfo[];
}

/**
 * Split a group's non-archived threads into the ones that still want
 * attention and the ones that settled.
 *
 * Settled means status "done": the run finished and nothing is asking for the
 * user. Failed threads are NOT settled (they need attention), idle ones are
 * not either (they have not run yet, hiding them buries new work). Archived
 * is a separate, stronger state with its own toggle and wins over settled.
 */
export function splitSettled(threads: readonly ThreadInfo[]): {
  attention: ThreadInfo[];
  settled: ThreadInfo[];
} {
  const attention: ThreadInfo[] = [];
  const settled: ThreadInfo[] = [];
  for (const t of threads) {
    (t.status === "done" ? settled : attention).push(t);
  }
  return { attention, settled };
}

/**
 * Counts for a group header, t3-style: "2 working · 5 settled".
 * Null when there is nothing to say (no threads at all).
 */
export function groupHeaderSummary(
  threads: readonly ThreadInfo[],
): string | null {
  if (threads.length === 0) return null;
  const working = threads.filter((t) => t.status === "working").length;
  const settled = threads.filter((t) => t.status === "done").length;
  const parts: string[] = [];
  if (working > 0) parts.push(`${working} working`);
  if (settled > 0) parts.push(`${settled} settled`);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/**
 * Group threads under every registered project.
 * Threads newest-first by updatedAt inside a group.
 * Groups ordered by newest thread activity; empty projects last.
 * Orphan threads (missing project) form a trailing group.
 */
export function buildSidebarGroups(
  projects: ProjectInfo[],
  threads: ThreadInfo[],
): SidebarGroup[] {
  const byProject = new Map<string, ThreadInfo[]>();
  for (const t of threads) {
    const list = byProject.get(t.projectId) ?? [];
    list.push(t);
    byProject.set(t.projectId, list);
  }

  for (const list of byProject.values()) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const newest = (list: ThreadInfo[]) =>
    list.length === 0 ? 0 : list[0]!.updatedAt;

  const withThreads: SidebarGroup[] = [];
  const empty: SidebarGroup[] = [];

  for (const p of projects) {
    const list = byProject.get(p.id) ?? [];
    byProject.delete(p.id);
    if (list.length === 0) {
      empty.push({ project: p, threads: list });
    } else {
      withThreads.push({ project: p, threads: list });
    }
  }

  withThreads.sort((a, b) => newest(b.threads) - newest(a.threads));

  const orphans: SidebarGroup[] = [];
  for (const [, list] of byProject) {
    if (list.length > 0) {
      orphans.push({ project: null, threads: list });
    }
  }
  orphans.sort((a, b) => newest(b.threads) - newest(a.threads));

  return [...withThreads, ...empty, ...orphans];
}
