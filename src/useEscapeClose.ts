import { useEffect } from "react";

/**
 * When `open` is true, Escape invokes `onClose`. Listener is removed on unmount
 * or when the menu/modal closes. Shared by composer menus, thread overflow,
 * and settings modal.
 */
export function useEscapeClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
}
