import { useEffect, type Dispatch, type SetStateAction } from "react";
import { isShortcutBlocked, stepVisibleId } from "../../sidebarSelection";

/**
 * Window-level list shortcuts: ⌘/Ctrl held shows index hints, ⌘1–9 opens
 * the nth visible row, ⌘J / ⌘⇧J steps through the list, ⌘N / ⌘⇧N creates a
 * thread, and ? opens the keyboard sheet.
 */
export function useSidebarShortcuts({
  visibleIds,
  activeThreadId,
  onSelectThread,
  keyboardSheetOpen,
  setKeyboardSheetOpen,
  setCmdHeld,
  setMultiSelected,
  setSelectAnchor,
  createInTargetProject,
  handleBrandCreate,
}: {
  visibleIds: string[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  keyboardSheetOpen: boolean;
  setKeyboardSheetOpen: Dispatch<SetStateAction<boolean>>;
  setCmdHeld: Dispatch<SetStateAction<boolean>>;
  setMultiSelected: Dispatch<SetStateAction<Set<string>>>;
  setSelectAnchor: Dispatch<SetStateAction<string | null>>;
  createInTargetProject: () => void;
  handleBrandCreate: () => void;
}): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") {
        setCmdHeld(true);
        return;
      }
      if (isShortcutBlocked(e.target)) return;
      if (keyboardSheetOpen && e.key !== "Escape") return;

      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "?" && !mod) {
        e.preventDefault();
        setKeyboardSheetOpen(true);
        return;
      }

      if (!mod) return;

      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key);
        const id = visibleIds[n - 1];
        if (id) {
          e.preventDefault();
          setMultiSelected(new Set());
          setSelectAnchor(id);
          onSelectThread(id);
        }
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        const delta = e.shiftKey ? -1 : 1;
        const next = stepVisibleId(visibleIds, activeThreadId, delta as 1 | -1);
        if (next) {
          setMultiSelected(new Set());
          setSelectAnchor(next);
          onSelectThread(next);
        }
        return;
      }

      if (key === "n") {
        e.preventDefault();
        if (e.shiftKey) createInTargetProject();
        else handleBrandCreate();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") {
        setCmdHeld(false);
      }
    };
    const onBlur = () => setCmdHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    visibleIds,
    activeThreadId,
    onSelectThread,
    keyboardSheetOpen,
    createInTargetProject,
    handleBrandCreate,
  ]);
}
