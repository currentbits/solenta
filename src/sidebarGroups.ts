import type { ProjectInfo, ThreadInfo } from "./shared/ipc";

export interface SidebarGroup {
  project: ProjectInfo | null;
  threads: ThreadInfo[];
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
