import { useCallback } from "react";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./KeyboardSheet.module.css";

interface ShortcutRow {
  keys: string;
  action: string;
}

/** Static shortcut list — not a remapping panel. */
const APP_SHORTCUTS: readonly ShortcutRow[] = [
  { keys: "⌘ + click", action: "Toggle thread in multi-select" },
  { keys: "⇧ + click", action: "Select range in visible list" },
  { keys: "⌘ + 1…9", action: "Jump to nth visible thread" },
  { keys: "⌘ + J / K", action: "Next / previous thread" },
  { keys: "⌘ + Enter", action: "Send message" },
  { keys: "Escape", action: "Close menus and dialogs" },
  { keys: "?", action: "Show this keyboard reference" },
];

interface KeyboardSheetProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardSheet({ open, onClose }: KeyboardSheetProps) {
  const handleClose = useCallback(() => onClose(), [onClose]);
  useEscapeClose(open, handleClose);
  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      data-keyboard-sheet=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Keyboard shortcuts</h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </header>
        <ul className={styles.list}>
          {APP_SHORTCUTS.map((row) => (
            <li key={row.keys} className={styles.row}>
              <kbd className={styles.keys}>{row.keys}</kbd>
              <span className={styles.action}>{row.action}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
