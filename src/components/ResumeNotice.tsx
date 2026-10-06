import { useState } from "react";
import type { ThreadInfo } from "../shared/ipc";
import styles from "./ArchiveToast.module.css";

/** Titles named before "and N more". */
const MAX_NAMED = 3;

/**
 * The newest batch of threads auto-resumed after a restart (issue #1512 I3).
 * One boot stamps the whole batch with the same autoResumedAt; batches from
 * before this renderer loaded (`since`) are history, not news.
 */
export function resumedBatch(
  threads: ThreadInfo[],
  since: number,
): { at: number; threads: ThreadInfo[] } | null {
  let at = 0;
  for (const t of threads) {
    if (t.autoResumedAt && t.autoResumedAt > at) at = t.autoResumedAt;
  }
  if (!at || at < since) return null;
  return { at, threads: threads.filter((t) => t.autoResumedAt === at) };
}

/** Dismissible notice listing what was resumed, with "Stop all". */
export function ResumeNotice({
  threads,
  since = performance.timeOrigin,
  onStopAll,
}: {
  threads: ThreadInfo[];
  since?: number;
  onStopAll: (threadIds: string[]) => void;
}) {
  const [dismissedAt, setDismissedAt] = useState(0);
  const batch = resumedBatch(threads, since);
  if (!batch || batch.at <= dismissedAt) return null;
  const names = batch.threads.slice(0, MAX_NAMED).map((t) => t.title);
  const more = batch.threads.length - names.length;
  const dismiss = () => setDismissedAt(batch.at);
  return (
    <div
      className={styles.toast}
      role="status"
      aria-live="polite"
      data-toast="resume"
    >
      <span className={styles.message}>
        Resumed after restart: {names.join(", ")}
        {more > 0 ? ` and ${more} more` : ""}
      </span>
      <button
        type="button"
        className={styles.undo}
        onClick={() => {
          onStopAll(batch.threads.map((t) => t.id));
          dismiss();
        }}
      >
        Stop all
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={dismiss}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
