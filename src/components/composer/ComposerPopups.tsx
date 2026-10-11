import type { Dispatch, SetStateAction } from "react";
import type { SlashCommand } from "../../slashCommands";
import type { PromptSnippet } from "../../shared/ipc";
import { scrollChildIntoNearestView } from "../../scrollNearest";
import styles from "../Composer.module.css";

/** The @-mention listbox above the textarea. */
export function MentionList({
  snippetMatches,
  acceptSnippet,
  mentionFiles,
  mentionIndex,
  setMentionIndex,
  acceptMention,
  onPickMentionFolder,
  browseMentionFolder,
}: {
  /** Snippet rows (issue #189) come first; indices continue into files. */
  snippetMatches: PromptSnippet[];
  acceptSnippet: (snippet: PromptSnippet) => void;
  mentionFiles: string[];
  mentionIndex: number;
  setMentionIndex: Dispatch<SetStateAction<number>>;
  acceptMention: (path: string) => void;
  onPickMentionFolder?: () => Promise<string | null>;
  browseMentionFolder: () => void;
}) {
  return (
    <ul
      className={styles.mentionList}
      role="listbox"
      aria-label="Mention a file or folder"
    >
      {snippetMatches.map((sn, i) => (
        <li key={`snippet:${sn.name}`} role="option" aria-selected={i === mentionIndex}>
          <button
            type="button"
            className={styles.mentionRow}
            ref={(el) => {
              if (i === mentionIndex && el) {
                scrollChildIntoNearestView(
                  el.closest<HTMLElement>('[role="listbox"]'),
                  el,
                );
              }
            }}
            data-highlighted={i === mentionIndex ? "true" : undefined}
            data-mention-kind="snippet"
            title={sn.text}
            onMouseEnter={() => setMentionIndex(i)}
            onClick={() => acceptSnippet(sn)}
          >
            {sn.name}{" "}
            <span className={styles.snippetPreview}>{sn.text}</span>
          </button>
        </li>
      ))}
      {mentionFiles.map((f, fi) => {
        const i = fi + snippetMatches.length;
        return (
        <li key={f} role="option" aria-selected={i === mentionIndex}>
          <button
            type="button"
            className={styles.mentionRow}
            // Same overflow box as the slash palette (16+ rows in 240px).
            // Without this the highlight walks off-screen and the list
            // looks frozen. Matches the model picker.
            ref={(el) => {
              if (i === mentionIndex && el) {
                scrollChildIntoNearestView(
                  el.closest<HTMLElement>('[role="listbox"]'),
                  el,
                );
              }
            }}
            data-highlighted={i === mentionIndex ? "true" : undefined}
            data-mention-kind={f.endsWith("/") ? "folder" : "file"}
            onMouseEnter={() => setMentionIndex(i)}
            onClick={() => acceptMention(f)}
          >
            {f}
          </button>
        </li>
        );
      })}
      {onPickMentionFolder && (
        <li role="option" aria-selected={false}>
          <button
            type="button"
            className={styles.mentionRow}
            data-mention-browse=""
            onClick={browseMentionFolder}
          >
            Browse folder…
          </button>
        </li>
      )}
    </ul>
  );
}

/** The `/` command listbox above the textarea. */
export function CommandList({
  commandMatches,
  commandIndex,
  setCommandIndex,
  acceptCommand,
}: {
  commandMatches: SlashCommand[];
  commandIndex: number;
  setCommandIndex: Dispatch<SetStateAction<number>>;
  acceptCommand: (cmd: SlashCommand) => void;
}) {
  return (
    <ul
      className={styles.mentionList}
      role="listbox"
      aria-label="Commands"
    >
      {commandMatches.map((cmd, i) => (
        <li key={cmd.name} role="option" aria-selected={i === commandIndex}>
          <button
            type="button"
            className={styles.mentionRow}
            // 16 slash rows in a 240px box. Arrow keys only bump
            // commandIndex; without this the highlight walks off-screen
            // and the palette looks frozen. Matches the model picker.
            ref={(el) => {
              if (i === commandIndex && el) {
                scrollChildIntoNearestView(
                  el.closest<HTMLElement>('[role="listbox"]'),
                  el,
                );
              }
            }}
            data-highlighted={i === commandIndex ? "true" : undefined}
            onMouseEnter={() => setCommandIndex(i)}
            onClick={() => acceptCommand(cmd)}
          >
            <span className={styles.providerRowText}>
              <span className={styles.modelRowLabel}>{cmd.name}</span>
              <span className={styles.modelRowVendor}>{cmd.hint}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
