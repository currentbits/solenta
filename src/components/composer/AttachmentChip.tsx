import { useEffect, useState } from "react";
import type { AttachmentInfo } from "../../shared/ipc";
import styles from "../Composer.module.css";

/** One pending attachment: thumbnail for images, glyph for files/folders. */
export function AttachmentChip({
  attachment,
  onRemove,
  onLoadImage,
}: {
  attachment: AttachmentInfo;
  onRemove: () => void;
  onLoadImage?: (path: string) => Promise<string | null>;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (attachment.kind !== "image" || !onLoadImage) return;
    let live = true;
    void onLoadImage(attachment.path)
      .then((url) => {
        if (live) setThumb(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [attachment.kind, attachment.path, onLoadImage]);
  return (
    <span
      className={styles.attachmentChip}
      data-attachment-kind={attachment.kind}
      title={attachment.path}
    >
      {attachment.kind === "image" && thumb ? (
        <img
          className={styles.attachmentThumb}
          src={thumb}
          alt={attachment.name}
        />
      ) : (
        <svg
          className={styles.attachmentIcon}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {attachment.kind === "folder" ? (
            <path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h2.2a1.5 1.5 0 0 1 1.1.5l.8 1a1.5 1.5 0 0 0 1.1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4Z" />
          ) : attachment.kind === "file" ? (
            <>
              <path d="M4.5 2.5h5l4 4v7A1.5 1.5 0 0 1 12 15H4.5A1.5 1.5 0 0 1 3 13.5v-10A1.5 1.5 0 0 1 4.5 2.5Z" />
              <path d="M9.5 2.5V7h4" />
            </>
          ) : (
            <>
              <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
              <circle cx="5.8" cy="6" r="1" />
              <path d="m3 12 3.5-3.5 2.5 2.5 2-2L13.5 12" />
            </>
          )}
        </svg>
      )}
      <span className={styles.attachmentName}>{attachment.name}</span>
      <button
        type="button"
        className={styles.attachmentRemove}
        aria-label={`Remove ${attachment.name}`}
        title={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}
