import type { ProjectInfo, ThreadInfo } from "./shared/ipc";
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

/** The single "not now" shelf (#567): snoozed wake-soonest, then settled
 *  newest, then archived newest. Rendered in that order. */
export interface LaterPartition {
  snoozed: ThreadInfo[];
  settled: ThreadInfo[];
  archived: ThreadInfo[];
}

/**
 * Global partition for the sidebar (#567: two zones, Active and Later).
 *
 * Precedence (first match wins):
 *   1. archived — Later, always
 *   2. snoozed  — Later (an explicit "not now" beats a pin)
 *   3. pinned   — Active, sorted first in its project group; beats settle
 *   4. settled  — Later (PR/inactivity/override)
 *   5. attention — Active, per-project groups
 */
export function partitionSidebar(
  threads: readonly ThreadInfo[],
  opts: SettleOpts,
): {
  attentionThreads: ThreadInfo[];
  later: LaterPartition;
} {
  const snoozed: ThreadInfo[] = [];
  const attention: ThreadInfo[] = [];
  const settled: ThreadInfo[] = [];
  const archived: ThreadInfo[] = [];

  for (const t of threads) {
    if (t.archived) {
      archived.push(t);
      continue;
    }
    if (effectiveSnoozed(t, opts.now)) {
      snoozed.push(t);
      continue;
    }
    if (isPinned(t) || !effectiveSettled(t, opts)) {
      attention.push(t);
    } else {
      settled.push(t);
    }
  }

  snoozed.sort(compareSnoozedWakeSoonest);
  settled.sort(compareSettledNewestFirst);
  archived.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );

  return {
    attentionThreads: attention,
    later: { snoozed, settled, archived },
  };
}

/** Later shelf render order, flattened. */
export function flattenLater(later: LaterPartition): ThreadInfo[] {
  return [...later.snoozed, ...later.settled, ...later.archived];
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
    // Pinned rows sort first in their group (#567: the pinned shelf is gone).
    // Among pinned, oldest pin first; the rest keep static createdAt order.
    list.sort(
      (a, b) =>
        Number(isPinned(b)) - Number(isPinned(a)) ||
        (isPinned(a) && isPinned(b) ? comparePinnedOldestFirst(a, b) : 0) ||
        createdKey(b) - createdKey(a) ||
        a.id.localeCompare(b.id),
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
