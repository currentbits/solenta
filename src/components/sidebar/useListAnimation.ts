import { useCallback, useRef } from "react";
import autoAnimate from "@formkit/auto-animate";
import {
  listMotionBlocked,
  releaseAbortedRows,
  skipDetachedObserve,
  type ListAnimCtrl,
  type ListMotionSkip,
} from "./motion";

skipDetachedObserve();

const FAMILY_MOTION_MS = 160;

/**
 * Row motion for the sidebar lists. `bindListAnimation` is the callback ref
 * for each animated container; `listAnimSkip` gates motion off for hydrate,
 * bulk churn and keyboard snaps, and `applyListMotion` pushes the gate out.
 */
export function useListAnimation() {
  const listAnimCtrls = useRef(new Map<HTMLElement, ListAnimCtrl>());
  const listAnimSkip = useRef<ListMotionSkip>({
    hydrate: true,
    bulk: false,
    keyboard: false,
  });
  const prevRowIds = useRef<string[]>([]);
  const applyListMotion = useCallback(() => {
    const enable = !listMotionBlocked(listAnimSkip.current);
    for (const [node, ctrl] of listAnimCtrls.current) {
      if (enable) ctrl.enable();
      else {
        ctrl.disable();
        releaseAbortedRows(node);
      }
    }
  }, []);
  const bindListAnimation = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    if (typeof ResizeObserver === "undefined") return;
    // The library samples prefers-reduced-motion only while binding and, when
    // it matches, never installs an observer. enable() cannot bring that
    // observer back, so a session that starts reduced stays frozen after the
    // user turns motion on. Own the gate instead.
    const ctrl = autoAnimate(node, {
      duration: FAMILY_MOTION_MS,
      easing: "ease-out",
      disrespectUserMotionPreference: true,
    });
    listAnimCtrls.current.set(node, ctrl);
    if (listMotionBlocked(listAnimSkip.current)) {
      ctrl.disable();
      releaseAbortedRows(node);
    }
    return () => {
      ctrl.destroy?.();
      listAnimCtrls.current.delete(node);
    };
  }, []);
  return { listAnimSkip, prevRowIds, applyListMotion, bindListAnimation };
}
