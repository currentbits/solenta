import { useLayoutEffect, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
  );
}

/**
 * Initial focus, Tab cycle, and restore. Same idea as the context-menu
 * stack in contextMenuFallback: keep keyboard work inside the overlay.
 */
export function useModalFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    if (!root) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    root.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (!root.contains(document.activeElement)) return;
      e.preventDefault();
      const items = focusableIn(root);
      if (items.length === 0) {
        root.focus();
        return;
      }
      const from = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey) {
        const next = from <= 0 ? items.length - 1 : from - 1;
        items[next]!.focus();
      } else {
        const next = from === -1 || from === items.length - 1 ? 0 : from + 1;
        items[next]!.focus();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      if (root.contains(e.target as Node)) return;
      e.stopPropagation();
      const items = focusableIn(root);
      (items[0] ?? root).focus();
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, containerRef]);
}
