import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  commandQuery,
  matchSlashCommands,
  type SlashAction,
  type SlashCommand,
} from "../../slashCommands";

/**
 * The `/` command palette: the token at the start of the draft, its matches,
 * and running or inserting a picked command. No effects, so it cannot reorder
 * Composer's effects wherever it is called.
 */
export function useSlashMenu({
  textareaRef,
  cliCommands,
  disabled,
  busy,
  writeDraft,
  setModelOpen,
  setModeOpen,
  setEffortOpen,
  setOptionsOpen,
  onModelPickerOpen,
  onSlashAction,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  cliCommands?: readonly SlashCommand[];
  disabled: boolean;
  busy: boolean;
  writeDraft: (text: string, caret?: number) => void;
  setModelOpen: Dispatch<SetStateAction<boolean>>;
  setModeOpen: Dispatch<SetStateAction<boolean>>;
  setEffortOpen: Dispatch<SetStateAction<boolean>>;
  setOptionsOpen: Dispatch<SetStateAction<boolean>>;
  onModelPickerOpen?: () => void;
  onSlashAction?: (action: SlashAction) => void;
}) {
  /** `/` command popup: `command` null means closed. */
  const [command, setCommand] = useState<string | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  /**
   * Escape must stay closed while the same text is still in the box —
   * without this the onSelect that follows the key would reopen it. Cleared
   * by the next edit and by a thread switch. Accepting needs no such guard:
   * the inserted trailing space ends the token on its own.
   */
  const commandDismissed = useRef(false);
  const commandMatches = command
    ? matchSlashCommands(command, cliCommands)
    : [];
  const commandOpen = commandMatches.length > 0;

  const closeCommand = useCallback(() => {
    setCommand(null);
    setCommandIndex(0);
  }, []);

  /** Recompute the active `/` token from the live textarea. */
  const refreshCommand = useCallback(() => {
    const el = textareaRef.current;
    const q =
      el && !disabled && !commandDismissed.current
        ? commandQuery(el.value)
        : null;
    if (q === null) {
      closeCommand();
      return;
    }
    setCommand(q);
    setCommandIndex(0);
  }, [disabled, closeCommand]);

  const acceptCommand = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.kind === "insert") {
        const inserted = `${cmd.name} `;
        writeDraft(inserted, inserted.length);
        closeCommand();
        return;
      }
      // Run verbs must not remain in the draft: sending `/compact` as a
      // prompt is the bug this palette exists to stop.
      writeDraft("", 0);
      closeCommand();
      const action = cmd.action;
      if (!action) return;
      if (action === "model") {
        if (disabled || busy) return;
        setModelOpen(true);
        setModeOpen(false);
        setEffortOpen(false);
        setOptionsOpen(false);
        onModelPickerOpen?.();
        return;
      }
      if (action === "effort") {
        if (disabled || busy) return;
        setEffortOpen(true);
        setModelOpen(false);
        setModeOpen(false);
        setOptionsOpen(false);
        return;
      }
      if (action === "permissions") {
        if (disabled || busy) return;
        setModeOpen(true);
        setModelOpen(false);
        setEffortOpen(false);
        setOptionsOpen(false);
        return;
      }
      onSlashAction?.(action);
    },
    [writeDraft, closeCommand, disabled, busy, onModelPickerOpen, onSlashAction],
  );
  return {
    commandIndex,
    setCommandIndex,
    commandDismissed,
    commandMatches,
    commandOpen,
    closeCommand,
    refreshCommand,
    acceptCommand,
  };
}
