import type { ProjectInfo, ThreadInfo } from "./shared/ipc";
import {
  AUTO_SETTLE_AFTER_DAYS,
  compareSettledNewestFirst,
  effectiveSettled,
  type SettleOpts,
} from "./threadSettle";

export interface SidebarGroup {
  project: ProjectInfo | null;
  threads: ThreadInfo[];
}

export type { SettleOpts };

/**
 * Split non-archived threads into attention vs settled.
 * Order within each side is preserved (caller sorts first when needed).
 */
export function splitSettled(
  threads: readonly ThreadInfo[],
  opts: SettleOpts,
): {
  attention: ThreadInfo[];
  settled: ThreadInfo[];
} {
  const attention: ThreadInfo[] = [];
  const settled: ThreadInfo[] = [];
  for (const t of threads) {
    (effectiveSettled(t, opts) ? settled : attention).push(t);
  }
  return { attention, settled };
}

/**
 * Global partition for the round-40 sidebar layout (t3-style).
 *
 * - attentionThreads: non-archived threads with effectiveSettled false.
 * - settled: one flat list of all non-archived settled threads across every
 *   project, newest-settled first (resolveSettledTimestamp).
 *
 * Archived never enters the global settled tail (archived wins over settled).
 * Project grouping is the caller's job (buildSidebarGroups on attention).
 */
export function partitionSidebar(
  threads: readonly ThreadInfo[],
  opts: SettleOpts,
): {
  attentionThreads: ThreadInfo[];
  settled: ThreadInfo[];
} {
  const nonArchived = threads.filter((t) => !t.archived);
  const { attention, settled } = splitSettled(nonArchived, opts);
  const sortedSettled = [...settled].sort(compareSettledNewestFirst);
  return { attentionThreads: attention, settled: sortedSettled };
}

/**
 * Working-only summary for a project header: "2 working".
 * Settled counts live on the global tail header now (round 40), not here.
 * Null when there is nothing to say.
 */
export function groupHeaderSummary(
  threads: readonly ThreadInfo[],
): string | null {
  if (threads.length === 0) return null;
  const working = threads.filter((t) => t.status === "working").length;
  if (working > 0) return `${working} working`;
  return null;
}

/** Default opts when a caller has no clock of its own (tests, pure helpers). */
export function defaultSettleOpts(now = Date.now()): SettleOpts {
  return { now, autoSettleAfterDays: AUTO_SETTLE_AFTER_DAYS };
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
