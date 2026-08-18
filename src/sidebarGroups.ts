import type { ProjectInfo, SpaceInfo, ThreadInfo } from "./shared/ipc";
import {
  AUTO_SETTLE_AFTER_DAYS,
  compareSettledNewestFirst,
  effectiveSettled,
  type SettleOpts,
} from "./threadSettle";
import {
  comparePinnedOldestFirst,
  compareSnoozedWakeSoonest,
  effectiveSnoozed,
  isPinned,
} from "./threadSnooze";
import { countUnread } from "./threadUnread";

export interface SidebarGroup {
  project: ProjectInfo | null;
  threads: ThreadInfo[];
}

/**
 * Max attention threads rendered per project group before a "Show more"
 * disclosure (session-only, like the archived toggle). Group order is static
 * createdAt desc, so the cap hides the OLDEST threads — newest work and
 * fresh runs are always visible. Search bypasses the cap.
 */
export const GROUP_ATTENTION_CAP = 8;

/**
 * How many attention threads of one group render before the "Show more"
 * disclosure. When capped, the slice extends past the cap to include any
 * keepIds (active / revealed thread) — the open thread never vanishes.
 * Pure: Sidebar render and buildVisibleThreadIds share it so keyboard
 * navigation mirrors the render exactly.
 */
export function visibleAttentionCount(
  attention: readonly ThreadInfo[],
  opts: {
    capped: boolean;
    keepIds?: readonly (string | null | undefined)[];
  },
): number {
  if (!opts.capped || attention.length <= GROUP_ATTENTION_CAP) {
    return attention.length;
  }
  let count = GROUP_ATTENTION_CAP;
  for (const id of opts.keepIds ?? []) {
    if (!id) continue;
    const idx = attention.findIndex((t) => t.id === id);
    if (idx >= count) count = idx + 1;
  }
  return count;
}

export type { SettleOpts };

/**
 * Split non-archived threads into attention vs settled.
 * Order within each side is preserved (caller sorts first when needed).
 * Does NOT account for pin/snooze shelves — prefer partitionSidebar.
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
 * Global partition for the sidebar (rounds 40–44, t3-style).
 *
 * Precedence (first match wins):
 *   1. snoozed  — beats pin (suspends, never clears) and settle
 *   2. pinned   — global shelf, oldest pin first; beats settle
 *   3. settled  — PR/inactivity/override (pin already blocked above)
 *   4. attention — everything else, for per-project groups
 *
 * Archived never enters any shelf.
 */
export function partitionSidebar(
  threads: readonly ThreadInfo[],
  opts: SettleOpts,
): {
  pinned: ThreadInfo[];
  attentionThreads: ThreadInfo[];
  snoozed: ThreadInfo[];
  settled: ThreadInfo[];
} {
  const nonArchived = threads.filter((t) => !t.archived);
  const pinned: ThreadInfo[] = [];
  const snoozed: ThreadInfo[] = [];
  const attention: ThreadInfo[] = [];
  const settled: ThreadInfo[] = [];

  for (const t of nonArchived) {
    if (effectiveSnoozed(t, opts.now)) {
      snoozed.push(t);
      continue;
    }
    if (isPinned(t)) {
      pinned.push(t);
      continue;
    }
    if (effectiveSettled(t, opts)) {
      settled.push(t);
    } else {
      attention.push(t);
    }
  }

  pinned.sort(comparePinnedOldestFirst);
  snoozed.sort(compareSnoozedWakeSoonest);
  settled.sort(compareSettledNewestFirst);

  return {
    pinned,
    attentionThreads: attention,
    snoozed,
    settled,
  };
}

/**
 * Project header summary: working count (round 40) plus unread (round 43).
 * Examples: "2 working", "3 unread", "2 working · 3 unread".
 * Settled counts live on the global tail header, not here.
 * Null when there is nothing to say.
 */
export function groupHeaderSummary(
  threads: readonly ThreadInfo[],
): string | null {
  if (threads.length === 0) return null;
  const working = threads.filter((t) => t.status === "working").length;
  const unread = countUnread(threads);
  const parts: string[] = [];
  if (working > 0) parts.push(`${working} working`);
  if (unread > 0) parts.push(`${unread} unread`);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/** Default opts when a caller has no clock of its own (tests, pure helpers). */
export function defaultSettleOpts(now = Date.now()): SettleOpts {
  return {
    now,
    autoSettleAfterDays: AUTO_SETTLE_AFTER_DAYS,
    autoSettleOnMerge: true,
  };
}

/**
 * Sort key for the static sidebar order: creation time. Legacy rows with a
 * missing/NaN createdAt fall back to updatedAt.
 */
function createdKey(t: ThreadInfo): number {
  return Number.isFinite(t.createdAt) ? t.createdAt : t.updatedAt;
}

/**
 * Reorder a sorted group list so forked threads (orchestration workers,
 * manual forks) sit directly under the thread that started them
 * (handoffFrom), depth-first. Threads whose source is absent from the list
 * keep their normal position.
 */
function attachForks(list: ThreadInfo[]): ThreadInfo[] {
  const ids = new Set(list.map((t) => t.id));
  const children = new Map<string, ThreadInfo[]>();
  const roots: ThreadInfo[] = [];
  for (const t of list) {
    if (t.handoffFrom && t.handoffFrom !== t.id && ids.has(t.handoffFrom)) {
      const kids = children.get(t.handoffFrom) ?? [];
      kids.push(t);
      children.set(t.handoffFrom, kids);
    } else {
      roots.push(t);
    }
  }
  const out: ThreadInfo[] = [];
  const seen = new Set<string>();
  const emit = (t: ThreadInfo) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
    for (const kid of children.get(t.id) ?? []) emit(kid);
  };
  for (const t of roots) emit(t);
  // Corrupt-data guard: a handoffFrom cycle would strand its members.
  for (const t of list) emit(t);
  return out;
}

/**
 * Group threads under every registered project.
 *
 * t3 sidebar rule: activity NEVER reorders the list. A row holds its
 * position from creation until a lifecycle transition (create / settle /
 * unsettle / pin / snooze / archive), so both threads-in-a-group and the
 * groups themselves sort by createdAt — never updatedAt, which streaming
 * bumps constantly. id tie-break keeps equal timestamps stable.
 * Empty projects last. Orphan threads (missing project) form a trailing group.
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

  for (const [key, list] of byProject) {
    list.sort(
      (a, b) => createdKey(b) - createdKey(a) || a.id.localeCompare(b.id),
    );
    byProject.set(key, attachForks(list));
  }

  const newest = (list: ThreadInfo[]) =>
    list.length === 0 ? 0 : createdKey(list[0]!);

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

export interface SidebarSpaceSection {
  /** null = the trailing Unassigned section (and the only section when there are no spaces). */
  space: SpaceInfo | null;
  groups: SidebarGroup[];
}

/**
 * Layer named spaces on top of buildSidebarGroups without changing it.
 *
 * Sections follow `spaces` array order, then one trailing Unassigned
 * section (space: null). A dangling spaceId lands in Unassigned so the
 * project never vanishes. Empty spaces still emit a section (that is
 * how a user drops the first project in).
 *
 * Zero spaces is a no-op: one Unassigned section whose groups equal
 * buildSidebarGroups(projects, threads). Activity never reorders within
 * a section — that rule stays inside buildSidebarGroups.
 */
export function buildSidebarSections(
  spaces: SpaceInfo[],
  projects: ProjectInfo[],
  threads: ThreadInfo[],
): SidebarSpaceSection[] {
  const known = new Set(spaces.map((s) => s.id));
  const allProjectIds = new Set(projects.map((p) => p.id));
  const bySpace = new Map<string, ProjectInfo[]>();
  const unassigned: ProjectInfo[] = [];
  for (const p of projects) {
    if (p.spaceId && known.has(p.spaceId)) {
      const list = bySpace.get(p.spaceId) ?? [];
      list.push(p);
      bySpace.set(p.spaceId, list);
    } else {
      unassigned.push(p);
    }
  }

  const threadsFor = (ids: Set<string>, includeOrphans: boolean) =>
    threads.filter(
      (t) =>
        ids.has(t.projectId) ||
        (includeOrphans && !allProjectIds.has(t.projectId)),
    );

  const sections: SidebarSpaceSection[] = spaces.map((space) => {
    const spaceProjects = bySpace.get(space.id) ?? [];
    const ids = new Set(spaceProjects.map((p) => p.id));
    return {
      space,
      groups: buildSidebarGroups(spaceProjects, threadsFor(ids, false)),
    };
  });

  const unassignedIds = new Set(unassigned.map((p) => p.id));
  sections.push({
    space: null,
    groups: buildSidebarGroups(
      unassigned,
      threadsFor(unassignedIds, true),
    ),
  });
  return sections;
}
