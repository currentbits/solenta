import { useState } from "react";
import { formatRelativeAge } from "../../format";
import { summarizeReleaseNotes } from "../../releaseNotes";
import styles from "../Sidebar.module.css";

/**
 * "What's new" popover beside the footer update button (issue #1757). Shows
 * nothing, and renders nothing, when the update check carried no release
 * body: today's Update/Restart button is unaffected either way.
 */
export function UpdateNotesPopover({
  tag,
  url,
  notesBody,
  publishedAt,
}: {
  tag: string | null | undefined;
  url: string | null | undefined;
  notesBody: string | null | undefined;
  publishedAt: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const bullets = summarizeReleaseNotes(notesBody);
  if (!bullets.length) return null;

  const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN;
  const age = Number.isFinite(publishedMs) ? formatRelativeAge(publishedMs) : null;

  return (
    <span
      className={styles.updateNotesHost}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={styles.updateNotesTrigger}
        aria-expanded={open}
        aria-haspopup="true"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        What's new
      </button>
      {open && (
        <div className={styles.updateNotesPopover} role="tooltip" data-update-notes="">
          <div className={styles.updateNotesHead}>
            {tag}
            {age ? (
              <span className={styles.updateNotesAge}>
                {age === "now" ? "shipped just now" : `shipped ${age} ago`}
              </span>
            ) : null}
          </div>
          <ul className={styles.updateNotesList}>
            {bullets.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className={styles.updateNotesLink}>
              Full notes
            </a>
          ) : null}
        </div>
      )}
    </span>
  );
}
