import { useCallback, useMemo, useRef, useState } from "react";
import type { ThreadInfo } from "../../shared/ipc";
import {
  moveNeighbors,
  reorderSortKeys,
  type Orderable,
} from "../../threadOrder";

type Section = "pinned" | "active";

/**
 * Drag-and-drop + keyboard reorder for the flat sidebar's pinned and active
 * sections (#1769). Sidebar.tsx wires the returned handlers onto every
 * ThreadCard (same stable-reference-per-render shape as onSetPinned etc. —
 * ThreadCard supplies its own thread.id when it calls them) and `dragging`
 * / `dropIndicator` as plain per-row booleans/strings, so React.memo still
 * bails on an unrelated re-render (#617) while a drag is not in progress.
 * The pure midpoint / renumber math lives in src/threadOrder.ts.
 *
 * Only root rows (not nested family children) participate — a dragged
 * family moves as its root, same as every other sidebar ordering rule.
 * Dragging across sections is refused: no patch, no indicator.
 */
export function useThreadReorder({
  pinned,
  active,
  pinnedFamilies,
  activeFamilies,
  onSetSortKey,
}: {
  pinned: readonly ThreadInfo[];
  active: readonly ThreadInfo[];
  pinnedFamilies: ReadonlyMap<string, string[]>;
  activeFamilies: ReadonlyMap<string, string[]>;
  onSetSortKey?: (threadId: string, sortKey: number | null) => void | Promise<void>;
}) {
  const rootsOf = (
    list: readonly ThreadInfo[],
    families: ReadonlyMap<string, string[]>,
  ): Orderable[] => {
    const childIds = new Set<string>();
    for (const kids of families.values()) {
      for (const id of kids) childIds.add(id);
    }
    return list
      .filter((t) => !childIds.has(t.id))
      .map((t) => ({ id: t.id, sortKey: t.sortKey ?? null }));
  };

  const pinnedRoots = useMemo(
    () => rootsOf(pinned, pinnedFamilies),
    [pinned, pinnedFamilies],
  );
  const activeRoots = useMemo(
    () => rootsOf(active, activeFamilies),
    [active, activeFamilies],
  );

  const sectionOf = useCallback(
    (id: string): { section: Section; roots: Orderable[] } | null => {
      if (pinnedRoots.some((t) => t.id === id)) {
        return { section: "pinned", roots: pinnedRoots };
      }
      if (activeRoots.some((t) => t.id === id)) {
        return { section: "active", roots: activeRoots };
      }
      return null;
    },
    [pinnedRoots, activeRoots],
  );

  const applyPatches = useCallback(
    (patches: ReadonlyMap<string, number>) => {
      if (!onSetSortKey) return;
      for (const [id, key] of patches) void onSetSortKey(id, key);
    },
    [onSetSortKey],
  );

  const [dragThreadId, setDragThreadId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    edge: "before" | "after";
  } | null>(null);

  // Mirrors the state above for the drag/drop handlers below: reading a ref
  // instead of closing over the state keeps those handlers' identity stable
  // across a drag (no dependency on dragThreadId/dropTarget), so passing
  // the same reference to every card never defeats ThreadCard's memo.
  const dragRef = useRef<string | null>(null);
  dragRef.current = dragThreadId;

  const onDragStartRow = useCallback(
    (id: string) => {
      setDragThreadId(sectionOf(id) ? id : null);
    },
    [sectionOf],
  );

  const onDragOverRow = useCallback(
    (id: string, e: React.DragEvent<HTMLDivElement>) => {
      const dragId = dragRef.current;
      if (!dragId || dragId === id) return;
      const from = sectionOf(dragId);
      const to = sectionOf(id);
      // Cross-section drag is out of scope: refuse the drop, no indicator.
      if (!from || !to || from.section !== to.section) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const edge: "before" | "after" =
        e.clientY - rect.top < rect.height / 2 ? "before" : "after";
      setDropTarget((prev) =>
        prev && prev.id === id && prev.edge === edge ? prev : { id, edge },
      );
    },
    [sectionOf],
  );

  const onDropRow = useCallback(
    (id: string, e: React.DragEvent<HTMLDivElement>) => {
      const dragId = dragRef.current;
      const from = dragId ? sectionOf(dragId) : null;
      setDropTarget((target) => {
        if (!dragId || !from || !target || target.id !== id) return null;
        e.preventDefault();
        const { roots } = from;
        const idx = roots.findIndex((t) => t.id === id);
        if (idx < 0) return null;
        const beforeId =
          target.edge === "before"
            ? idx > 0
              ? roots[idx - 1]!.id
              : null
            : id;
        const afterId =
          target.edge === "before"
            ? id
            : idx + 1 < roots.length
              ? roots[idx + 1]!.id
              : null;
        // The dragged row is already on this exact edge — nothing to do.
        if (beforeId !== dragId && afterId !== dragId) {
          applyPatches(reorderSortKeys(roots, dragId, beforeId, afterId));
        }
        return null;
      });
    },
    [sectionOf, applyPatches],
  );

  const onDragEndRow = useCallback(() => {
    setDragThreadId(null);
    setDropTarget(null);
  }, []);

  /** Alt+Shift+ArrowUp/Down: move the focused thread within its section. */
  const moveThread = useCallback(
    (id: string, direction: "up" | "down") => {
      const found = sectionOf(id);
      if (!found) return;
      const neighbors = moveNeighbors(found.roots, id, direction);
      if (!neighbors) return;
      applyPatches(
        reorderSortKeys(found.roots, id, neighbors.beforeId, neighbors.afterId),
      );
    },
    [sectionOf, applyPatches],
  );

  return {
    dragThreadId,
    dropTarget,
    onDragStartRow,
    onDragOverRow,
    onDropRow,
    onDragEndRow,
    moveThread,
  };
}
