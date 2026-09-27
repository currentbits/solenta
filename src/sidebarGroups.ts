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

/** Minimal handoff shape for crew walks (ThreadInfo or wait rows). */
export interface CrewLink {
  id: string;
  projectId?: string;
  handoffFrom: string | null;
  orchWorker?: boolean;
}

export function isCrewWorker(t: { orchWorker?: boolean }): boolean {
  return t.orchWorker === true;
}

/**
 * Walk orchWorker handoffFrom toward the crew lead. Cycle, missing parent,
 * and cross-project hops stop the walk. Returns ancestor ids nearest-first.
 */
export function crewAncestorIds(
  row: CrewLink,
  byId: ReadonlyMap<string, CrewLink>,
): string[] {
  if (!isCrewWorker(row) || !row.handoffFrom || row.handoffFrom === row.id) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>([row.id]);
  let cur: string | null = row.handoffFrom;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const parent = byId.get(cur);
    if (!parent) break;
    if (
      row.projectId != null &&
      parent.projectId != null &&
      parent.projectId !== row.projectId
    ) {
      break;
    }
    out.push(parent.id);
    if (
      !isCrewWorker(parent) ||
      !parent.handoffFrom ||
      parent.handoffFrom === parent.id
    ) {
      break;
    }
    cur = parent.handoffFrom;
  }
  return out;
}

/**
 * Topmost ancestor that is in `inList`. Flattens grandchildren onto the
 * visible crew lead while preserving handoffFrom on the row.
 * A cycle of orchWorkers has no non-worker lead — return null so those
 * rows stay independent and discoverable when collapsed.
 */
export function crewOwnerInList(
  row: CrewLink,
  byId: ReadonlyMap<string, CrewLink>,
  inList: ReadonlySet<string>,
): string | null {
  const ancestors = crewAncestorIds(row, byId);
  const hasLead = ancestors.some((id) => {
    const node = byId.get(id);
    return node != null && !isCrewWorker(node);
  });
  if (!hasLead) return null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const id = ancestors[i]!;
    if (inList.has(id)) return id;
  }
  return null;
}

/**
 * Reorder so orchWorker descendants sit under their visible crew lead,
 * flattened to one level. Manual forks (no orchWorker) keep list order.
 * `byIdFull` should include rows outside `list` so a missing intermediate
 * worker does not strand a grandchild (archived parent, other shelf).
 */
export function nestWorkerFamilies(
  list: ThreadInfo[],
  byIdFull?: ReadonlyMap<string, CrewLink>,
): ThreadInfo[] {
  const ids = new Set(list.map((t) => t.id));
  const byId = byIdFull ?? new Map(list.map((t) => [t.id, t]));
  const children = new Map<string, ThreadInfo[]>();
  const roots: ThreadInfo[] = [];
  for (const t of list) {
    const owner = isCrewWorker(t) ? crewOwnerInList(t, byId, ids) : null;
    if (owner) {
      const kids = children.get(owner) ?? [];
      kids.push(t);
      children.set(owner, kids);
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

/** Root id → nested orchWorker ids in list order. */
export function workerIdsByRoot(
  list: readonly ThreadInfo[],
  byIdFull?: ReadonlyMap<string, CrewLink>,
): Map<string, string[]> {
  const ids = new Set(list.map((t) => t.id));
  const byId = byIdFull ?? new Map(list.map((t) => [t.id, t]));
  const families = new Map<string, string[]>();
  for (const t of list) {
    if (!isCrewWorker(t)) continue;
    const owner = crewOwnerInList(t, byId, ids);
    if (!owner) continue;
    const kids = families.get(owner) ?? [];
    kids.push(t.id);
    families.set(owner, kids);
  }
  return families;
}

/**
 * Hide collapsed orchWorker rows. keepIds / keepWorkerIds keep those
 * specific workers discoverable without opening the rest of the family.
 */
export function visibleFamilyRows(
  list: readonly ThreadInfo[],
  opts: {
    expandedRootIds: ReadonlySet<string>;
    keepIds?: readonly (string | null | undefined)[];
    keepWorkerIds?: ReadonlySet<string>;
    byIdFull?: ReadonlyMap<string, CrewLink>;
  },
): ThreadInfo[] {
  const families = workerIdsByRoot(list, opts.byIdFull);
  const workerToRoot = new Map<string, string>();
  for (const [root, kids] of families) {
    for (const id of kids) workerToRoot.set(id, root);
  }
  const keep = new Set<string>();
  for (const id of opts.keepIds ?? []) {
    if (id) keep.add(id);
  }
  const keepWorkers = opts.keepWorkerIds;
  return list.filter((t) => {
    const root = workerToRoot.get(t.id);
    if (!root) return true;
    if (opts.expandedRootIds.has(root)) return true;
    if (keep.has(t.id)) return true;
    if (keepWorkers?.has(t.id)) return true;
    return false;
  });
}

/**
 * Search hits plus the crew lead of any matching worker, nested for display.
 */
export function withCrewSearchContext(
  hits: readonly ThreadInfo[],
  all: readonly ThreadInfo[],
): ThreadInfo[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const ids = new Set(hits.map((t) => t.id));
  const extra: ThreadInfo[] = [];
  for (const t of hits) {
    if (!isCrewWorker(t)) continue;
    const ancestors = crewAncestorIds(t, byId);
    const rootId = ancestors[ancestors.length - 1];
    if (!rootId || ids.has(rootId)) continue;
    const root = byId.get(rootId);
    if (!root) continue;
    extra.push(root);
    ids.add(rootId);
  }
  const combined = extra.length === 0 ? [...hits] : [...hits, ...extra];
  return nestWorkerFamilies(combined, byId);
}

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

/**
 * T3-style flat sidebar (no project group headers): one pinned block, one
 * flat active list, then the Snoozed and Settled shelves. Every card carries
 * its own project identity, so grouping happens per-card, not per-section.
 */
export interface FlatSidebar {
  /** Pin order, oldest pin first (T3: reorderable block above the inbox). */
  pinned: ThreadInfo[];
  /** createdAt desc (static — activity never reorders), forks attached. */
  active: ThreadInfo[];
  /** Wake-soonest first. */
  snoozed: ThreadInfo[];
  /** Wrap-up newest first. */
  settled: ThreadInfo[];
  /** updatedAt desc; renders at the tail of the Settled shelf. */
  archived: ThreadInfo[];
}

/**
 * Partition for the flat T3 sidebar. Precedence (first match wins), same as
 * partitionSidebar (#567) except pinned is its own section:
 *   archived > snoozed > pinned > settled > active
 * scopeProjectId filters every section ("All projects" = null).
 */
export function buildFlatSidebar(
  threads: readonly ThreadInfo[],
  opts: SettleOpts,
  scopeProjectId: string | null = null,
): FlatSidebar {
  const pinned: ThreadInfo[] = [];
  const active: ThreadInfo[] = [];
  const snoozed: ThreadInfo[] = [];
  const settled: ThreadInfo[] = [];
  const archived: ThreadInfo[] = [];

  for (const t of threads) {
    if (scopeProjectId != null && t.projectId !== scopeProjectId) continue;
    if (t.archived) archived.push(t);
    else if (effectiveSnoozed(t, opts.now)) snoozed.push(t);
    else if (isPinned(t)) pinned.push(t);
    else if (effectiveSettled(t, opts)) settled.push(t);
    else active.push(t);
  }

  pinned.sort(comparePinnedOldestFirst);
  active.sort(
    (a, b) => createdKey(b) - createdKey(a) || a.id.localeCompare(b.id),
  );
  snoozed.sort(compareSnoozedWakeSoonest);
  settled.sort(compareSettledNewestFirst);
  archived.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );

  // Auto-settled orchWorkers (merged PR, inactivity) of a still-visible
  // parent stay nested next to it. An explicit settle override files the
  // row to the Settled shelf — clicking Settle must leave Active (#1315).
  // Pinned is its own nest pass — a pinned lead must take the child in the
  // pinned block, not dump it as a disconnected Active row.
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const activeIds = new Set(active.map((t) => t.id));
  const byId = new Map<string, ThreadInfo>();
  for (const t of threads) {
    if (scopeProjectId != null && t.projectId !== scopeProjectId) continue;
    byId.set(t.id, t);
  }
  const visibleCrewOwnerKind = (
    t: ThreadInfo,
  ): "pinned" | "active" | null => {
    if (!isCrewWorker(t)) return null;
    const ancestors = crewAncestorIds(t, byId);
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const id = ancestors[i]!;
      if (pinnedIds.has(id)) return "pinned";
      if (activeIds.has(id)) return "active";
    }
    return null;
  };
  const nestPinned: ThreadInfo[] = [];
  const nestActive: ThreadInfo[] = [];
  const settledRest: ThreadInfo[] = [];
  for (const t of settled) {
    if (t.settledOverride === "settled" || !isCrewWorker(t)) {
      settledRest.push(t);
      continue;
    }
    const kind = visibleCrewOwnerKind(t);
    if (kind === "pinned") nestPinned.push(t);
    else if (kind === "active") nestActive.push(t);
    else settledRest.push(t);
  }
  const activeRest: ThreadInfo[] = [];
  for (const t of active) {
    if (isCrewWorker(t) && visibleCrewOwnerKind(t) === "pinned") {
      nestPinned.push(t);
    } else {
      activeRest.push(t);
    }
  }

  return {
    pinned: nestWorkerFamilies([...pinned, ...nestPinned], byId),
    active: nestWorkerFamilies([...activeRest, ...nestActive], byId),
    snoozed,
    settled: settledRest,
    archived,
  };
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
    byProject.set(key, nestWorkerFamilies(list));
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
