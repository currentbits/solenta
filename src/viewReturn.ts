/**
 * Session-only return destination when a report/board opens a thread (#942).
 *
 * App keeps one record, not a history stack, and source views remount on
 * return instead of staying mounted and polling in the background.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { PlanSort } from "./planboard";
import type { ProjectInfo } from "./shared/ipc";
import { nearestScrollTop, offsetTopWithin } from "./scrollNearest";

export type ReturnableView =
  | "planboard"
  | "kanban"
  | "activity"
  | "digest"
  | "prs"
  | "insights";

export const RETURN_VIEW_LABEL: Record<ReturnableView, string> = {
  planboard: "Planboard",
  kanban: "Kanban",
  activity: "Activity",
  digest: "Digest",
  prs: "PRs",
  insights: "Insights",
};

const RETURNABLE = new Set<string>([
  "planboard",
  "kanban",
  "activity",
  "digest",
  "prs",
  "insights",
]);

export function isReturnableView(view: string): view is ReturnableView {
  return RETURNABLE.has(view);
}

export interface ThreadOpenOrigin {
  rowKey: string;
  rowIndex: number;
  scrollTop: number;
  /** Value of the originating [data-return-scroll], when that box is named. */
  scrollKey?: string;
  projectId?: string | null;
  sort?: PlanSort;
  query?: string;
  projectFilter?: string;
}

export interface ViewReturnState extends ThreadOpenOrigin {
  view: ReturnableView;
}

export function validProjectId(
  id: string | null | undefined,
  projects: readonly ProjectInfo[],
): string | null {
  if (!id) return null;
  return projects.some((project) => project.id === id) ? id : null;
}

function returnRows(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-return-row]"));
}

function namedScroller(
  root: HTMLElement,
  key: string | undefined,
): HTMLElement | null {
  if (!key) return null;
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-return-scroll]")).find(
      (el) => el.getAttribute("data-return-scroll") === key,
    ) ?? null
  );
}

function nearestScrollerWithRows(
  root: HTMLElement,
  preferredKey: string | undefined,
): HTMLElement | null {
  const scrollers = Array.from(
    root.querySelectorAll<HTMLElement>("[data-return-scroll]"),
  );
  const withRows = scrollers.filter((el) => returnRows(el).length > 0);
  if (withRows.length === 0) return null;
  if (!preferredKey) return withRows[0] ?? null;
  const preferredIdx = scrollers.findIndex(
    (el) => el.getAttribute("data-return-scroll") === preferredKey,
  );
  if (preferredIdx < 0) return withRows[0] ?? null;
  return withRows.reduce((best, el) => {
    const i = scrollers.indexOf(el);
    const bestI = scrollers.indexOf(best);
    return Math.abs(i - preferredIdx) < Math.abs(bestI - preferredIdx)
      ? el
      : best;
  });
}

function pickIndexedRow(
  rows: HTMLElement[],
  rowIndex: number,
): HTMLElement | null {
  if (rows.length === 0) return null;
  const i = Math.min(Math.max(0, rowIndex), rows.length - 1);
  return rows[i] ?? null;
}

export function originFromRowKey(
  root: HTMLElement | null,
  rowKey: string,
  extra: Partial<ThreadOpenOrigin> = {},
): ThreadOpenOrigin {
  const rows = root ? returnRows(root) : [];
  const row =
    rows.find((el) => el.getAttribute("data-return-row") === rowKey) ?? null;
  const scroller =
    (row?.closest("[data-return-scroll]") as HTMLElement | null) ??
    (root?.querySelector("[data-return-scroll]") as HTMLElement | null) ??
    root;
  const scoped = scroller ? returnRows(scroller) : rows;
  const rowIndex = row ? scoped.indexOf(row) : 0;
  const rawKey = scroller?.getAttribute("data-return-scroll");
  return {
    rowKey,
    rowIndex: rowIndex >= 0 ? rowIndex : 0,
    scrollTop: scroller?.scrollTop ?? 0,
    scrollKey: rawKey ? rawKey : undefined,
    ...extra,
  };
}

export function applyViewRestore(
  root: HTMLElement,
  restore: Pick<
    ViewReturnState,
    "rowKey" | "rowIndex" | "scrollTop" | "scrollKey"
  >,
): boolean {
  const allRows = returnRows(root);
  let row =
    allRows.find((el) => el.getAttribute("data-return-row") === restore.rowKey) ??
    null;
  let scroller =
    (row?.closest("[data-return-scroll]") as HTMLElement | null) ??
    namedScroller(root, restore.scrollKey);

  if (!row && scroller) {
    row = pickIndexedRow(returnRows(scroller), restore.rowIndex);
  }
  if (!row) {
    scroller = nearestScrollerWithRows(root, restore.scrollKey);
    row = scroller
      ? pickIndexedRow(returnRows(scroller), restore.rowIndex)
      : pickIndexedRow(allRows, restore.rowIndex);
    if (!scroller && row) {
      scroller = row.closest("[data-return-scroll]") as HTMLElement | null;
    }
  }

  scroller =
    scroller ??
    (root.querySelector("[data-return-scroll]") as HTMLElement | null) ??
    root;
  scroller.scrollTop = restore.scrollTop;
  if (row) {
    if (scroller.clientHeight > 0) {
      const next = nearestScrollTop(
        {
          scrollTop: scroller.scrollTop,
          clientHeight: scroller.clientHeight,
        },
        {
          offsetTop: offsetTopWithin(scroller, row),
          offsetHeight: row.offsetHeight,
        },
      );
      if (next !== scroller.scrollTop) scroller.scrollTop = next;
    }
    const focusable = row.querySelector<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus({ preventScroll: true });
  }
  return true;
}

export function useViewRestore(
  ready: boolean,
  restore: ViewReturnState | null | undefined,
  rootRef: RefObject<HTMLElement | null>,
  onApplied?: () => void,
): void {
  const token = restore
    ? `${restore.view}:${restore.scrollKey ?? ""}:${restore.rowKey}:${restore.rowIndex}:${restore.scrollTop}`
    : "";
  const appliedToken = useRef("");
  useEffect(() => {
    if (!ready || !restore || !token || appliedToken.current === token) return;
    const root = rootRef.current;
    if (!root) return;
    const hasRow = returnRows(root).some(
      (el) => el.getAttribute("data-return-row") === restore.rowKey,
    );
    if (!hasRow && root.querySelector("[data-return-row]") == null) return;
    applyViewRestore(root, restore);
    appliedToken.current = token;
    onApplied?.();
  }, [ready, restore, token, rootRef, onApplied]);
}
