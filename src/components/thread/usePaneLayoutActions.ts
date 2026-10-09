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
  REOPEN_PANE_EVENT,
  rememberClosedPanes,
  savePaneLayout,
  takeClosedPane,
  type LayoutNode,
  type PaneType,
} from "../../paneLayout";
import { matchesBinding } from "../../keybindings";

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
  terminalNonce = 0,
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
  /** Bumps when something (Sign in, #1501) wants the Terminal pane shown. */
  terminalNonce?: number;
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

  useEffect(() => {
    if (!terminalNonce) return;
    if (!hasPaneType(layout, "terminal")) onPanesNeedRoom?.();
    setLayout((prev) => {
      if (hasPaneType(prev, "terminal")) return prev;
      const next = openPane(prev, "terminal", focusedId);
      setFocusedId(next.focusId);
      return next.layout;
    });
  }, [terminalNonce]);

  const applyLayout = useCallback(
    (next: LayoutNode, focusId: string) => {
      if (threadId) rememberClosedPanes(threadId, layout, next);
      setLayout(next);
      setFocusedId(findLeaf(next, focusId) ? focusId : firstLeafId(next));
      if (!hasPaneType(next, "diff")) onCloseChanges();
    },
    [threadId, layout, onCloseChanges],
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

  const handleReopenPane = useCallback(() => {
    const type = threadId ? takeClosedPane(threadId, layout) : null;
    if (type) handleOpenPane(type);
  }, [threadId, layout, handleOpenPane]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesBinding(e, "pane.reopen")) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      handleReopenPane();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(REOPEN_PANE_EVENT, handleReopenPane);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(REOPEN_PANE_EVENT, handleReopenPane);
    };
  }, [handleReopenPane]);

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
