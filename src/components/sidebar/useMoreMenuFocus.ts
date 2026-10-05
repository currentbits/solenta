import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * Insights menu: focus the current (or first) item when it opens, and close
 * it on a mousedown outside its host, returning focus to the trigger when
 * focus was inside the menu.
 */
export function useMoreMenuFocus(
  moreOpen: boolean,
  setMoreOpen: (open: boolean) => void,
  moreHostRef: RefObject<HTMLSpanElement | null>,
  moreTriggerRef: RefObject<HTMLButtonElement | null>,
): void {
  useLayoutEffect(() => {
    if (!moreOpen) return;
    const menu = moreHostRef.current?.querySelector<HTMLElement>(
      "[data-app-more-menu]",
    );
    if (!menu) return;
    const current = menu.querySelector<HTMLElement>('[aria-current="page"]');
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]');
    (current ?? first)?.focus();
  }, [moreOpen]);
  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (moreHostRef.current?.contains(e.target as Node)) return;
      const menu = moreHostRef.current?.querySelector("[data-app-more-menu]");
      const restore = Boolean(menu?.contains(document.activeElement));
      setMoreOpen(false);
      if (restore) moreTriggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer, true);
    return () => document.removeEventListener("mousedown", onPointer, true);
  }, [moreOpen]);
}
