import { useCallback } from "react";
import { useComposerVimEnabled } from "../uiPrefs";
import { useEscapeClose } from "../useEscapeClose";
import styles from "./KeyboardSheet.module.css";

interface ShortcutRow {
  keys: string;
  action: string;
}

/** Static shortcut list — not a remapping panel. */
const APP_SHORTCUTS: readonly ShortcutRow[] = [
  { keys: "⌘ + N", action: "New thread" },
  { keys: "⌘ + ⇧ + N", action: "New thread in current project" },
  { keys: "⌘ + click", action: "Toggle thread in multi-select" },
  { keys: "⇧ + click", action: "Select range in visible list" },
  { keys: "⌘ + 1…9", action: "Jump to nth visible thread" },
  { keys: "⌘ + J / K", action: "Next / previous thread" },
  { keys: "⌘ + Enter", action: "Send message" },
  { keys: "⌥ + Enter", action: "Ask a side question (/btw)" },
  { keys: "Escape", action: "Stop the live turn · close menus" },
  { keys: "Escape Escape", action: "Rewind the last turn" },
  { keys: "Ctrl + C", action: "Stop the live turn" },
  { keys: "?", action: "Show this keyboard reference" },
  { keys: "⌘ + \\", action: "Close the focused pane" },
  { keys: "⌘ + .", action: "Toggle agents panel" },
];

/** Escape in insert leaves vim; Escape from normal still stops the run. */
const VIM_ESCAPE: ShortcutRow = {
  keys: "Escape",
  action: "Leave insert · stop from normal · close menus",
};

/** Composer vim motions (#779 / #817 / #820 / #822). Shown only when coder.composerVim is on. */
const VIM_SHORTCUTS: readonly ShortcutRow[] = [
  { keys: "h / j / k / l", action: "Move left / down / up / right" },
  { keys: "0 / $", action: "Start / end of line" },
  { keys: "w / b", action: "Next / previous word" },
  { keys: "dd", action: "Delete line" },
  { keys: "x", action: "Delete character" },
  { keys: "i / a / I / A", action: "Insert · after · line start · line end" },
  { keys: "^", action: "First non-blank" },
  { keys: "gg / G", action: "First / last line" },
  { keys: "X", action: "Delete previous character" },
  { keys: "D", action: "Delete to end of line" },
  { keys: "dw", action: "Delete word" },
  { keys: "d0", action: "Delete to start of line" },
  { keys: "o / O", action: "Open line below / above" },
];

function appShortcutRows(composerVim: boolean): readonly ShortcutRow[] {
  if (!composerVim) return APP_SHORTCUTS;
  return APP_SHORTCUTS.map((row) =>
    row.keys === "Escape" ? VIM_ESCAPE : row,
  );
}

function ShortcutList({ rows }: { rows: readonly ShortcutRow[] }) {
  return (
    <ul className={styles.list}>
      {rows.map((row) => (
        <li key={row.keys} className={styles.row}>
          <kbd className={styles.keys}>{row.keys}</kbd>
          <span className={styles.action}>{row.action}</span>
        </li>
      ))}
    </ul>
  );
}

interface KeyboardSheetProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardSheet({ open, onClose }: KeyboardSheetProps) {
  const composerVim = useComposerVimEnabled();
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
        <ShortcutList rows={appShortcutRows(composerVim)} />
        {composerVim && (
          <>
            <h3 className={styles.section}>Composer vim</h3>
            <ShortcutList rows={VIM_SHORTCUTS} />
          </>
        )}
      </div>
    </div>
  );
}
