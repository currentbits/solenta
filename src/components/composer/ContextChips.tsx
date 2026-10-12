import { useState } from "react";
import {
  contextChipLabel,
  type ContextChip,
} from "../../contextChips";
import { excerptReply } from "../../replyContext";
import styles from "../Composer.module.css";

/** Typed context chips in the draft (#1526). Quote notes edit in place. */
export function ContextChips({
  chips,
  onEditComment,
  onRemove,
  onReveal,
  unavailable,
}: {
  chips: ContextChip[];
  onEditComment: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
  onReveal?: (chip: ContextChip) => void;
  unavailable?: (chip: ContextChip) => boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const commit = (id: string) => {
    onEditComment(id, value.trim());
    setEditing(null);
  };
  return (
    <div className={styles.reviewCommentRow} aria-label="Context">
      {chips.map((chip) => {
        const label = contextChipLabel(chip);
        const quote = chip.kind === "quote";
        const gone = Boolean(unavailable?.(chip));
        return (
          <span
            key={chip.id}
            className={styles.reviewCommentChip}
            data-context-chip=""
            data-context-kind={chip.kind}
            data-reply-chip={quote ? "" : undefined}
            data-reply-kind={quote ? chip.quoteKind ?? "message" : undefined}
            data-reply-source={quote ? (gone ? "unavailable" : "ok") : undefined}
            onClick={() => {
              if (gone) return;
              onReveal?.(chip);
            }}
          >
            <button
              type="button"
              className={styles.reviewCommentWhere}
              data-context-label=""
              data-reply-source={quote ? "" : undefined}
              disabled={!onReveal || gone || (quote && !chip.messageId)}
              aria-label={label}
              title={quote ? chip.text : label}
              onClick={() => onReveal?.(chip)}
            >
              {quote ? excerptReply(chip.text) : label}
            </button>
            {quote ? (
              editing === chip.id ? (
                <input
                  className={styles.reviewCommentInput}
                  aria-label={`Edit note on ${label}`}
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onBlur={() => commit(chip.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commit(chip.id);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={styles.reviewCommentText}
                  aria-label={`Edit note on ${label}`}
                  onClick={() => {
                    setValue(chip.comment);
                    setEditing(chip.id);
                  }}
                >
                  {chip.comment || (
                    <span className={styles.reviewCommentHint}>Add a note</span>
                  )}
                </button>
              )
            ) : null}
            <button
              type="button"
              className={styles.attachmentRemove}
              aria-label={`Remove ${label}`}
              title="Remove"
              onClick={() => onRemove(chip.id)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
