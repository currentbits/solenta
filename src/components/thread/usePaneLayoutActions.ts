import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  closePane,
  defaultPaneLayout,
  findLeaf,
  firstLeafId,
  hasPaneType,
  leaves,
  openPane,
  savePaneLayout,
  type LayoutNode,
  type PaneType,
} from "../../paneLayout";

/** Persist the per-thread pane layout and the pane open/close/reset actions. */
export function usePaneLayoutActions({
  threadId,
  layoutThreadId,
  layout,
  setLayout,
  focusedId,
  setFocusedId,
  changesOpen,
  changesNonce,
  onPanesNeedRoom,
  onCloseChanges,
  onViewChanges,
}: {
  threadId: string | null;
  layoutThreadId: string | null;
  layout: LayoutNode;
  setLayout: Dispatch<SetStateAction<LayoutNode>>;
  focusedId: string;
  setFocusedId: Dispatch<SetStateAction<string>>;
  changesOpen: boolean;
  changesNonce: number;
  onPanesNeedRoom?: () => void;
  onCloseChanges: () => void;
  onViewChanges?: () => void;
}) {
  useEffect(() => {
    if (threadId && threadId === layoutThreadId) {
      savePaneLayout(threadId, layout);
    }
  }, [threadId, layoutThreadId, layout]);

  useEffect(() => {
    if (!changesOpen) return;
    // A newly opened pane needs the width the agents rail is holding.
    if (!hasPaneType(layout, "diff")) onPanesNeedRoom?.();
    setLayout((prev) => {
      if (hasPaneType(prev, "diff")) return prev;
      const next = openPane(prev, "diff", focusedId);
      setFocusedId(next.focusId);
      return next.layout;
    });
  }, [changesOpen, changesNonce]);

  const applyLayout = useCallback(
    (next: LayoutNode, focusId: string) => {
      setLayout(next);
      setFocusedId(findLeaf(next, focusId) ? focusId : firstLeafId(next));
      if (!hasPaneType(next, "diff")) onCloseChanges();
    },
    [onCloseChanges],
  );

  const handlePaneChange = useCallback(
    (next: LayoutNode) => {
      applyLayout(next, focusedId);
    },
    [applyLayout, focusedId],
  );

  const handleOpenPane = useCallback(
    (type: PaneType) => {
      const fresh = !hasPaneType(layout, type);
      const next = openPane(layout, type, focusedId);
      applyLayout(next.layout, next.focusId);
      // Git, Terminal, Browser, … all want the width the agents rail holds.
      if (fresh) onPanesNeedRoom?.();
      if (type === "diff") onViewChanges?.();
    },
    [layout, focusedId, applyLayout, onViewChanges, onPanesNeedRoom],
  );

  const terminalLeaf = leaves(layout).find((l) => l.type === "terminal") ?? null;
  const handleToggleTerminal = useCallback(() => {
    if (!terminalLeaf) {
      handleOpenPane("terminal");
      return;
    }
    const next = closePane(layout, terminalLeaf.id);
    if (next.closed) applyLayout(next.layout, next.focusId);
  }, [terminalLeaf, layout, applyLayout, handleOpenPane]);

  const handleResetLayout = useCallback(() => {
    const next = defaultPaneLayout();
    applyLayout(next, firstLeafId(next));
  }, [applyLayout]);
  return {
    handlePaneChange,
    handleOpenPane,
    terminalLeaf,
    handleToggleTerminal,
    handleResetLayout,
  };
}
