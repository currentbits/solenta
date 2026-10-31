import { useState, type ReactNode } from "react";
import { formatRelativeAge } from "../../format";
import { summarizeReleaseNotes } from "../../releaseNotes";
import styles from "../Sidebar.module.css";

/**
 * "What's new" popover on the footer update button (issue #1757): hovering or
 * focusing the Update/Restart button (children) shows the release notes. With
 * no release body it renders just the button.
 */
export function UpdateNotesPopover({
  tag,
  url,
  notesBody,
  publishedAt,
  children,
}: {
  tag: string | null | undefined;
  url: string | null | undefined;
  notesBody: string | null | undefined;
  publishedAt: string | null | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bullets = summarizeReleaseNotes(notesBody);
  if (!bullets.length) return <>{children}</>;

  const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN;
  const age = Number.isFinite(publishedMs) ? formatRelativeAge(publishedMs) : null;

  return (
    <span
      className={styles.updateNotesHost}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
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
