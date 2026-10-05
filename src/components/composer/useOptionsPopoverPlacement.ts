import { useLayoutEffect, type RefObject } from "react";

/** Clamp the Options popover inside the window while it is open. */
export function useOptionsPopoverPlacement(
  optionsOpen: boolean,
  optionsPopoverRef: RefObject<HTMLDivElement | null>,
  optionsWrapRef: RefObject<HTMLDivElement | null>,
) {
  // The pill wraps with the others, so its left edge is not the window's.
  // Keep the panel on screen; the panel itself scrolls.
  useLayoutEffect(() => {
    if (!optionsOpen) return;
    const pop = optionsPopoverRef.current;
    const anchor = optionsWrapRef.current;
    if (!pop || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(
        320,
        Math.max(160, window.innerWidth - margin * 2),
      );
      let left = 0;
      if (rect.left + width > window.innerWidth - margin) {
        left = window.innerWidth - margin - width - rect.left;
      }
      if (rect.left + left < margin) left = margin - rect.left;
      const above = rect.top - margin;
      pop.style.left = `${Math.round(left)}px`;
      pop.style.width = `${Math.round(width)}px`;
      pop.style.maxHeight = `${Math.round(Math.min(420, Math.max(0, above)))}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [optionsOpen]);
}
