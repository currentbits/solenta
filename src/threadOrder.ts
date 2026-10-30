/**
 * Manual sidebar order (#1769): a persisted, fractional sortKey that lets a
 * user drag threads into their own order within the pinned or active
 * section. Pure math only — no IPC, no React. Sidebar.tsx drives the drag
 * and keyboard UI; sidebarGroups.ts applies applyManualOrder inside
 * buildFlatSidebar.
 */

/** The only fields this module reads. */
export interface Orderable {
  id: string;
  sortKey?: number | null;
}

/** Spacing left between fresh keys so a few more drops midpoint cleanly. */
const KEY_GAP = 1024;

/** Below this gap, two real neighbors are too close to divide further. */
const MIN_GAP = 1e-6;

function keyOf(t: Orderable): number | null {
  return t.sortKey != null && Number.isFinite(t.sortKey) ? t.sortKey : null;
}

/**
 * Today's order for a section, with manual placement applied: every thread
 * that has a sortKey sorts first, ascending; every thread without one
 * follows, keeping the relative order `list` arrived in (that order is
 * whatever the section's normal comparator produced — createdAt desc for
 * active, oldest-pin-first for pinned).
 */
export function applyManualOrder<T extends Orderable>(list: readonly T[]): T[] {
  const keyed: T[] = [];
  const unkeyed: T[] = [];
  for (const t of list) {
    (keyOf(t) != null ? keyed : unkeyed).push(t);
  }
  keyed.sort((a, b) => keyOf(a)! - keyOf(b)!);
  return [...keyed, ...unkeyed];
}

/**
 * New sort keys after dragging `draggedId` to sit between `beforeId` and
 * `afterId` — neighbor ids in `section`'s CURRENT manual-ordered display
 * order (applyManualOrder output), including draggedId itself. Either
 * neighbor may be null for "start of section" / "end of section".
 *
 * Usually returns one patch: a midpoint (or boundary offset) key for the
 * dragged thread alone. Falls back to renumbering the whole section — fresh,
 * evenly spaced keys for every thread, in the new order — whenever a
 * midpoint cannot be computed cleanly: an unkeyed neighbor (nothing to
 * midpoint against) or two real neighbors that have collapsed too close to
 * divide further.
 */
export function reorderSortKeys<T extends Orderable>(
  section: readonly T[],
  draggedId: string,
  beforeId: string | null,
  afterId: string | null,
): Map<string, number> {
  const rest = section.filter((t) => t.id !== draggedId);
  const beforeIdx = beforeId != null ? rest.findIndex((t) => t.id === beforeId) : -1;
  const afterIdx = afterId != null ? rest.findIndex((t) => t.id === afterId) : -1;
  const insertAt =
    beforeIdx >= 0 ? beforeIdx + 1 : afterIdx >= 0 ? afterIdx : rest.length;

  const prev = insertAt > 0 ? rest[insertAt - 1]! : null;
  const next = insertAt < rest.length ? rest[insertAt]! : null;
  const prevKey = prev ? keyOf(prev) : null;
  const nextKey = next ? keyOf(next) : null;

  // True edges (nothing before/after at all) are always safe to offset from:
  // no other real key can be sitting beyond that boundary.
  if (prev == null && nextKey != null) {
    return new Map([[draggedId, nextKey - KEY_GAP]]);
  }
  if (next == null && prevKey != null) {
    return new Map([[draggedId, prevKey + KEY_GAP]]);
  }
  if (prevKey != null && nextKey != null && nextKey - prevKey >= MIN_GAP * 2) {
    return new Map([[draggedId, (prevKey + nextKey) / 2]]);
  }

  // ponytail: everything else (an unkeyed neighbor that isn't a true edge,
  // or two real keys with no room left between them) renumbers the whole
  // section instead of chasing every edge case — correct, costs a few extra
  // writes, upgrade to a narrower patch only if that write volume matters.
  const newOrder = [
    ...rest.slice(0, insertAt),
    { id: draggedId } as T,
    ...rest.slice(insertAt),
  ];
  const patches = new Map<string, number>();
  newOrder.forEach((t, i) => patches.set(t.id, (i + 1) * KEY_GAP));
  return patches;
}

/**
 * Neighbor ids for a one-step keyboard move of `id` within `section`
 * (applyManualOrder output). Returns null at the edge the move would leave
 * the section through — reorderSortKeys's beforeId/afterId for the move.
 */
export function moveNeighbors<T extends Orderable>(
  section: readonly T[],
  id: string,
  direction: "up" | "down",
): { beforeId: string | null; afterId: string | null } | null {
  const idx = section.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  if (direction === "up") {
    if (idx === 0) return null;
    return {
      beforeId: idx >= 2 ? section[idx - 2]!.id : null,
      afterId: section[idx - 1]!.id,
    };
  }
  if (idx === section.length - 1) return null;
  return {
    beforeId: section[idx + 1]!.id,
    afterId: idx + 2 < section.length ? section[idx + 2]!.id : null,
  };
}
