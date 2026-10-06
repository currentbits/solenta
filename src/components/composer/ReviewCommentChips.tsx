import { useState } from "react";
import { reviewCommentLabel, type ReviewComment } from "../../diffView";
import styles from "../Composer.module.css";

/** Diff comments waiting in the draft (#1493). Click the text to edit. */
export function ReviewCommentChips({
  comments,
  onEdit,
  onRemove,
}: {
  comments: ReviewComment[];
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const commit = (id: string) => {
    if (value.trim()) onEdit(id, value.trim());
    setEditing(null);
  };
  return (
    <div className={styles.reviewCommentRow} aria-label="Review comments">
      {comments.map((c) => {
        const label = reviewCommentLabel(c);
        return (
          <span
            key={c.id}
            className={styles.reviewCommentChip}
            data-review-comment-chip=""
            title={c.code}
          >
            <span className={styles.reviewCommentWhere}>{label}</span>
            {editing === c.id ? (
              <input
                className={styles.reviewCommentInput}
                aria-label={`Edit comment on ${label}`}
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => commit(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit(c.id);
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
                aria-label={`Edit comment on ${label}`}
                onClick={() => {
                  setValue(c.text);
                  setEditing(c.id);
                }}
              >
                {c.text || (
                  <span className={styles.reviewCommentHint}>Add a note</span>
                )}
              </button>
            )}
            <button
              type="button"
              className={styles.attachmentRemove}
              aria-label={`Remove comment on ${label}`}
              title="Remove comment"
              onClick={() => onRemove(c.id)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
