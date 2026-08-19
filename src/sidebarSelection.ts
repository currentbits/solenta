import type { ThreadInfo } from "./shared/ipc";
import {
  GROUP_ATTENTION_CAP,
  visibleAttentionCount,
  type SidebarGroup,
} from "./sidebarGroups";

/**
 * Inputs for the ordered visible sidebar list (round 46, reshaped by #567).
 * Order mirrors render: per-project attention (pinned rows already sort
 * first inside each group) → Later shelf visible rows.
 */
interface VisibleListInput {
  /** Project groups already filtered to attention (search: full hit list). */
  groups: readonly SidebarGroup[];
  /** Group keys currently collapsed (non-search). */
  collapsedGroupKeys: ReadonlySet<string>;
  /** Group keys expanded past GROUP_ATTENTION_CAP (non-search). */
  expandedGroupKeys?: ReadonlySet<string>;
  /** Thread ids the cap must keep visible (active / revealed). */
  keepThreadIds?: readonly (string | null | undefined)[];
  /** Later shelf in render order (snoozed, settled, archived). */
  later: readonly ThreadInfo[];
  laterOpen: boolean;
  laterVisibleCount: number;
  /** Carve-out when the shelf is collapsed; null when open or none selected. */
  selectedLaterId: string | null;
  /** Search mode: flat groups only (no shelf, no cap). */
  searching?: boolean;
}

/**
 * Build the ordered list of visible thread ids matching Sidebar render order.
 * Pure — unit-tested without mounting the component.
 */
export function buildVisibleThreadIds(input: VisibleListInput): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  for (const g of input.groups) {
    const groupKey =
      g.project?.id ?? g.threads[0]?.projectId ?? "orphan";
    if (!input.searching && input.collapsedGroupKeys.has(groupKey)) {
      continue;
    }
    const attention = g.threads.filter((t) => !t.archived);
    // Mirror the render's overflow cap (GROUP_ATTENTION_CAP + keepIds
    // carve-out); search shows everything.
    const capped =
      !input.searching &&
      attention.length > GROUP_ATTENTION_CAP &&
      !input.expandedGroupKeys?.has(groupKey);
    const visibleCount = visibleAttentionCount(attention, {
      capped,
      keepIds: input.keepThreadIds,
    });
    for (const t of attention.slice(0, visibleCount)) push(t.id);
    if (input.searching) {
      for (const t of g.threads) {
        if (t.archived) push(t.id);
      }
    }
  }

  if (!input.searching) {
    if (input.laterOpen) {
      for (const t of input.later.slice(0, input.laterVisibleCount)) {
        push(t.id);
      }
    } else if (input.selectedLaterId) {
      push(input.selectedLaterId);
    }
  }

  return ids;
}

/**
 * Shift-click range in rendered order, inclusive of both ends.
 * Returns [] if either id is missing from the ordered list.
 */
export function rangeSelectIds(
  orderedIds: readonly string[],
  anchorId: string | null,
  clickId: string,
): string[] {
  if (anchorId == null) return [clickId];
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(clickId);
  if (a < 0 || b < 0) return [clickId];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return orderedIds.slice(lo, hi + 1);
}

/** Toggle id in a set (immutable). */
export function toggleIdInSet(
  set: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Batch settle plan: settle non-working; skip working (backend would reject).
 */
export function planBatchSettle(
  selectedIds: readonly string[],
  threadsById: ReadonlyMap<string, ThreadInfo>,
): { toSettle: string[]; skippedWorking: number } {
  const toSettle: string[] = [];
  let skippedWorking = 0;
  for (const id of selectedIds) {
    const t = threadsById.get(id);
    if (!t) continue;
    if (t.status === "working") {
      skippedWorking += 1;
      continue;
    }
    toSettle.push(id);
  }
  return { toSettle, skippedWorking };
}

export function formatBatchSettleFeedback(
  settled: number,
  skippedWorking: number,
): string {
  if (skippedWorking === 0) {
    return settled === 1 ? "1 settled" : `${settled} settled`;
  }
  const s = settled === 1 ? "1 settled" : `${settled} settled`;
  const k =
    skippedWorking === 1
      ? "1 skipped (running)"
      : `${skippedWorking} skipped (running)`;
  return `${s} · ${k}`;
}

/** True when keyboard shortcuts should be ignored. */
export function isShortcutBlocked(
  target: EventTarget | null,
  modalOpen = false,
): boolean {
  if (modalOpen) return true;
  // Any open dialog (settings, remove confirm, keyboard sheet).
  if (
    typeof document !== "undefined" &&
    document.querySelector('[role="dialog"]')
  ) {
    return true;
  }
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest("input, textarea, select, [contenteditable=true]")) {
    return true;
  }
  return false;
}

/** Next/prev with wrap in ordered list. */
export function stepVisibleId(
  orderedIds: readonly string[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  if (orderedIds.length === 0) return null;
  if (currentId == null) {
    return delta === 1 ? orderedIds[0]! : orderedIds[orderedIds.length - 1]!;
  }
  const i = orderedIds.indexOf(currentId);
  if (i < 0) {
    return delta === 1 ? orderedIds[0]! : orderedIds[orderedIds.length - 1]!;
  }
  const next = (i + delta + orderedIds.length) % orderedIds.length;
  return orderedIds[next]!;
}
