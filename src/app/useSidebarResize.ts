import {
  useCallback,
  useLayoutEffect,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  bindSidebarDrag,
  browserSidebarStorage,
  nextSidebarPreference,
  saveSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_STEP,
  SIDEBAR_WIDTH_STEP_COARSE,
} from "../sidebarWidth";

/** Sidebar resize handle: pointer drag, arrow keys, double-click reset. */
export function useSidebarResize({
  narrow,
  sidebarDragRef,
  sidebarPaneRef,
  preferredSidebarRef,
  sidebarFitRef,
  setPreferredSidebarWidth,
}: {
  narrow: boolean;
  sidebarDragRef: RefObject<{ finish(commit: boolean): void } | null>;
  sidebarPaneRef: RefObject<HTMLDivElement | null>;
  preferredSidebarRef: RefObject<number>;
  sidebarFitRef: RefObject<number>;
  setPreferredSidebarWidth: Dispatch<SetStateAction<number>>;
}) {
  const commitSidebarWidth = useCallback((width: number) => {
    setPreferredSidebarWidth(width);
    saveSidebarWidth(width, browserSidebarStorage());
  }, []);

  const endSidebarDrag = useCallback((commit: boolean) => {
    const session = sidebarDragRef.current;
    sidebarDragRef.current = null;
    session?.finish(commit);
  }, []);

  useLayoutEffect(() => {
    if (narrow) endSidebarDrag(false);
  }, [narrow, endSidebarDrag]);

  useLayoutEffect(() => {
    return () => {
      const session = sidebarDragRef.current;
      sidebarDragRef.current = null;
      session?.finish(false);
    };
  }, []);

  const onSidebarResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || narrow || sidebarDragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // jsdom, or a pointer the browser will not capture.
    }
    try {
      handle.focus({ preventScroll: true });
    } catch {
      handle.focus();
    }
    const startPreferred = preferredSidebarRef.current;
    const sidebarLeft =
      sidebarPaneRef.current?.getBoundingClientRect().left ?? 0;
    const clearDrag = () => {
      sidebarDragRef.current = null;
    };
    sidebarDragRef.current = bindSidebarDrag({
      pointerId,
      handle,
      originX: event.clientX,
      sidebarLeft,
      startPreferred,
      fitCap: () => sidebarFitRef.current,
      onPreview: setPreferredSidebarWidth,
      onCommit: (width) => {
        clearDrag();
        commitSidebarWidth(width);
      },
      onCancel: () => {
        clearDrag();
        setPreferredSidebarWidth(startPreferred);
      },
    });
  };

  const onSidebarResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (sidebarDragRef.current) return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
      return;
    }
    let delta = 0;
    if (event.key === "ArrowLeft") {
      delta = -(event.shiftKey ? SIDEBAR_WIDTH_STEP_COARSE : SIDEBAR_WIDTH_STEP);
    } else if (event.key === "ArrowRight") {
      delta = event.shiftKey ? SIDEBAR_WIDTH_STEP_COARSE : SIDEBAR_WIDTH_STEP;
    } else {
      return;
    }
    event.preventDefault();
    const next = nextSidebarPreference(
      preferredSidebarRef.current,
      delta,
      sidebarFitRef.current,
      "delta",
    );
    if (next !== preferredSidebarRef.current) commitSidebarWidth(next);
  };

  const onSidebarResizeReset = () => {
    if (sidebarDragRef.current) return;
    commitSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  };

  return {
    onSidebarResizePointerDown,
    onSidebarResizeKeyDown,
    onSidebarResizeReset,
  };
}
