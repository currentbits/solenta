import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { matchPaletteShortcut, type PaletteMode } from "../commandPalette";
import { matchesBinding } from "../keybindings";

function dialogOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector('[role="dialog"]') != null
  );
}

/**
 * Window shortcuts: ⌘B sidebar, ⌘. agents panel, palette modes, and
 * thread back/forward from the keyboard or the mouse's side buttons.
 */
export function useAppShortcuts({
  toggleSidebar,
  narrow,
  toggleAgents,
  goHistory,
  paletteModeRef,
  setPaletteMode,
  setPaletteOpen,
}: {
  toggleSidebar: () => void;
  narrow: boolean;
  toggleAgents: () => void;
  goHistory: (delta: 1 | -1) => void;
  paletteModeRef: RefObject<PaletteMode>;
  setPaletteMode: Dispatch<SetStateAction<PaletteMode>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesBinding(e, "sidebar.toggle") || narrow || dialogOpen()) return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesBinding(e, "agents.toggle") || dialogOpen()) return;
      e.preventDefault();
      toggleAgents();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAgents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const delta = matchesBinding(e, "history.back")
        ? -1
        : matchesBinding(e, "history.forward")
          ? 1
          : 0;
      if (!delta || dialogOpen()) return;
      // The terminal owns its keys (Alt+← is word-left in a shell).
      if (e.target instanceof Element && e.target.closest(".xterm")) return;
      e.preventDefault();
      goHistory(delta);
    };
    // Mouse buttons 3/4 are the side Back/Forward buttons.
    const onMouse = (e: MouseEvent) => {
      if ((e.button !== 3 && e.button !== 4) || dialogOpen()) return;
      e.preventDefault();
      goHistory(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [goHistory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = matchPaletteShortcut(e);
      if (!next) return;
      const paletteEl = document.querySelector("[data-command-palette]");
      if (dialogOpen() && !paletteEl) return;
      e.preventDefault();
      e.stopPropagation();
      if (paletteEl && paletteModeRef.current === next) {
        setPaletteOpen(false);
        return;
      }
      setPaletteMode(next);
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
