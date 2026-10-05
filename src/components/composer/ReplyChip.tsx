import { excerptReply, type ReplyTarget } from "../../replyContext";
import styles from "../Composer.module.css";

/** Quoted message chip above the textarea; click jumps to the source. */
export function ReplyChip({
  replyTo,
  replySourceUnavailable,
  onRevealReply,
  onClearReply,
}: {
  replyTo: ReplyTarget;
  replySourceUnavailable: boolean;
  onRevealReply?: () => void;
  onClearReply?: () => void;
}) {
  return (
    <div
      className={styles.replyChip}
      data-reply-chip=""
      data-reply-kind={replyTo.kind ?? "message"}
      data-reply-source={
        replySourceUnavailable ? "unavailable" : "ok"
      }
      data-reply-truncated={replyTo.truncated ? "" : undefined}
      onClick={() => {
        if (replySourceUnavailable) return;
        onRevealReply?.();
      }}
    >
      <span className={styles.replyChipLabel}>
        {replyTo.kind === "selection" ? "Cite" : "Reply"}
      </span>
      <button
        type="button"
        className={styles.replyChipSource}
        data-reply-source=""
        disabled={replySourceUnavailable}
        aria-label={
          replySourceUnavailable
            ? "Quoted source is unavailable"
            : "Show quoted message"
        }
        title={
          replySourceUnavailable
            ? "Quoted source is unavailable"
            : "Show quoted message"
        }
        onClick={(e) => {
          e.stopPropagation();
          if (replySourceUnavailable) return;
          onRevealReply?.();
        }}
      >
        {excerptReply(replyTo.text)}
      </button>
      {replyTo.truncated && (
        <span className={styles.replyChipTruncated} data-reply-truncated="">
          truncated
        </span>
      )}
      <button
        type="button"
        className={styles.attachmentRemove}
        aria-label="Cancel reply"
        title="Cancel reply"
        onClick={(e) => {
          e.stopPropagation();
          onClearReply?.();
        }}
      >
        ×
      </button>
    </div>
  );
}
