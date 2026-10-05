import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { matchPaletteShortcut, type PaletteMode } from "../commandPalette";

function dialogOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector('[role="dialog"]') != null
  );
}

/** Window shortcuts: ⌘B sidebar, ⌘. agents panel, palette modes. */
export function useAppShortcuts({
  toggleSidebar,
  narrow,
  toggleAgents,
  paletteModeRef,
  setPaletteMode,
  setPaletteOpen,
}: {
  toggleSidebar: () => void;
  narrow: boolean;
  toggleAgents: () => void;
  paletteModeRef: RefObject<PaletteMode>;
  setPaletteMode: Dispatch<SetStateAction<PaletteMode>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "b" || narrow || dialogOpen()) return;
      e.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      if (e.altKey || e.shiftKey) return;
      if (dialogOpen()) return;
      e.preventDefault();
      toggleAgents();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAgents]);

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
