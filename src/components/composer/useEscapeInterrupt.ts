import { useEffect, type RefObject } from "react";
import type { SlashAction } from "../../slashCommands";
import type { SpeechSnapshot } from "./useComposerSpeech";

/** Two distinct Esc presses within this window rewind when idle (#478). */
const DOUBLE_ESC_MS = 500;

/**
 * Esc must not steal from a modal, the narrow-window drawer, or another
 * field (notes, rename, edit-resubmit). The composer textarea itself is
 * allowed through — that is the interrupt surface.
 */
function escapeConsumedByChrome(
  target: EventTarget | null,
  composerField: HTMLTextAreaElement | null,
): boolean {
  if (typeof document !== "undefined") {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      return true;
    }
    if (document.querySelector("[data-drawer-open]")) return true;
  }
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  const typing =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable;
  return typing && target !== composerField;
}

/**
 * Document-level Esc while the composer is live: cancel dictation, else stop
 * the busy run, else a double press rewinds (#478). Open popups own Esc.
 */
export function useEscapeInterrupt({
  disabled,
  busy,
  popupOpen,
  onStopRun,
  onSlashAction,
  textareaRef,
  snapshotRef,
  cancelDictationRef,
  lastEscAt,
}: {
  disabled: boolean;
  busy: boolean;
  popupOpen: boolean;
  onStopRun?: () => void | Promise<void>;
  onSlashAction?: (action: SlashAction) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  snapshotRef: RefObject<SpeechSnapshot | null>;
  cancelDictationRef: RefObject<() => Promise<void>>;
  lastEscAt: RefObject<number>;
}) {
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat) return;
      if (e.defaultPrevented) return;
      // Mention / command / pill menus own Esc; do not stop or rewind.
      if (popupOpen) return;
      if (escapeConsumedByChrome(e.target, textareaRef.current)) return;

      if (snapshotRef.current) {
        e.preventDefault();
        lastEscAt.current = 0;
        void cancelDictationRef.current();
        return;
      }

      if (busy && onStopRun) {
        e.preventDefault();
        lastEscAt.current = 0;
        void onStopRun();
        return;
      }

      if (!busy && onSlashAction) {
        const now = Date.now();
        if (now - lastEscAt.current < DOUBLE_ESC_MS) {
          lastEscAt.current = 0;
          e.preventDefault();
          onSlashAction("rewind");
        } else {
          lastEscAt.current = now;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [disabled, busy, popupOpen, onStopRun, onSlashAction]);
}
