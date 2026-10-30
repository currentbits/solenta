import { useCallback, useEffect, type RefObject } from "react";
import { matchesBinding } from "../../keybindings";
import { isShortcutBlocked } from "../../sidebarSelection";
import { dialogOpen } from "../../app/useAppShortcuts";
import { currentRailTurn, type RailTurn } from "./TurnRail";

/**
 * turn.prev/turn.next (#1770) step to the previous/next user prompt
 * relative to the current scroll position: currentRailTurn finds "current"
 * the same way the rail's own scrollspy highlight does, then onJump (the
 * rail's scroll-to-turn mechanism) lands on the neighboring turn.
 *
 * Default alt+arrowup/alt+arrowdown collide on paper with the composer's
 * alt+arrowup "edit last queued" (keybindings.ts), but the two never fire
 * for the same keypress: this hook steps back off entirely once the
 * composer textarea owns focus, which is exactly when that binding applies.
 *
 * PageUp/PageDown page the transcript body ~90% of its height. Any editable
 * element (including the composer, which has its own paging) keeps native
 * behavior via isShortcutBlocked.
 */
export function useTurnNavigation({
  turns,
  bodyRef,
  start,
  onJump,
}: {
  turns: RailTurn[];
  bodyRef: RefObject<HTMLDivElement | null>;
  start: number;
  onJump: (id: string) => void;
}): void {
  const step = useCallback(
    (delta: 1 | -1) => {
      if (turns.length === 0) return;
      const body = bodyRef.current;
      const currentId = body ? currentRailTurn(turns, body, start) : null;
      const idx = currentId ? turns.findIndex((t) => t.id === currentId) : -1;
      const nextIdx =
        idx === -1
          ? delta === 1
            ? 0
            : turns.length - 1
          : Math.min(turns.length - 1, Math.max(0, idx + delta));
      const target = turns[nextIdx];
      if (target) onJump(target.id);
    },
    [turns, bodyRef, start, onJump],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || dialogOpen()) return;
      const prev = matchesBinding(e, "turn.prev");
      const next = !prev && matchesBinding(e, "turn.next");
      if (!prev && !next) return;
      if (
        e.target instanceof Element &&
        e.target.closest("[data-composer-input]")
      ) {
        return;
      }
      e.preventDefault();
      step(prev ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key !== "PageUp" && e.key !== "PageDown") return;
      if (isShortcutBlocked(e.target)) return;
      const body = bodyRef.current;
      if (!body) return;
      e.preventDefault();
      const delta = body.clientHeight * 0.9;
      body.scrollBy({ top: e.key === "PageDown" ? delta : -delta });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bodyRef]);
}
