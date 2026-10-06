import { useCallback, useRef } from "react";
import { bindingLabel, formatChord, KEYBINDINGS } from "../keybindings";
import {
  useComposerVimEnabled,
  useEnterSendsEnabled,
  useKeybindingOverrides,
} from "../uiPrefs";
import { useEscapeClose } from "../useEscapeClose";
import { useModalFocus } from "../useModalFocus";
import styles from "./KeyboardSheet.module.css";

interface ShortcutRow {
  keys: string;
  action: string;
}

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

function enterSendsRows(): ShortcutRow[] {
  return [
    { keys: "Enter", action: "Send message" },
    { keys: formatChord("shift+enter"), action: "New line" },
  ];
}

/** Rendered from the shared table, so remapped chords show as remapped. */
function appShortcutRows(
  composerVim: boolean,
  enterSends: boolean,
): readonly ShortcutRow[] {
  return KEYBINDINGS.flatMap((def): ShortcutRow[] => {
    if (composerVim && def.id === "composer.stop") return [VIM_ESCAPE];
    if (enterSends && def.id === "composer.send") return enterSendsRows();
    return [{ keys: bindingLabel(def.id) ?? "", action: def.label }];
  });
}

function ShortcutList({ rows }: { rows: readonly ShortcutRow[] }) {
  return (
    <ul className={styles.list}>
      {rows.map((row) => (
        <li key={`${row.keys} ${row.action}`} className={styles.row}>
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
  const enterSends = useEnterSendsEnabled();
  useKeybindingOverrides();
  const dialogRef = useRef<HTMLDivElement>(null);
  const handleClose = useCallback(() => onClose(), [onClose]);
  useEscapeClose(open, handleClose);
  useModalFocus(open, dialogRef);
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
        ref={dialogRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        data-keyboard-sheet-dialog=""
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
        <ShortcutList rows={appShortcutRows(composerVim, enterSends)} />
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
