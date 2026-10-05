import type { Dispatch, SetStateAction } from "react";
import type { TrashedThreadInfo } from "../../shared/ipc";
import { Icon } from "./Icon";
import styles from "../Sidebar.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatTrashExpiry(expiresAt: number, now: number): string {
  const days = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
  if (days <= 0) return "Expires today";
  return days === 1 ? "Expires in 1d" : `Expires in ${days}d`;
}

/** Recently deleted shelf (#940): restore, or delete permanently after a confirm. */
export function TrashedShelf({
  trashedThreads,
  trashedOpen,
  setTrashedOpen,
  now,
  onRestoreThread,
  onPurgeThread,
  purgeConfirmId,
  setPurgeConfirmId,
}: {
  trashedThreads: TrashedThreadInfo[];
  trashedOpen: boolean;
  setTrashedOpen: Dispatch<SetStateAction<boolean>>;
  now: number;
  onRestoreThread: ((threadId: string) => void | Promise<void>) | undefined;
  onPurgeThread: ((threadId: string) => void | Promise<void>) | undefined;
  purgeConfirmId: string | null;
  setPurgeConfirmId: Dispatch<SetStateAction<string | null>>;
}) {
  return (
    <div className={styles.shelf} data-trashed-shelf="">
      <div className={styles.shelfHeaderRow}>
        <button
          type="button"
          className={styles.shelfToggle}
          data-trashed-shelf-toggle=""
          aria-expanded={trashedOpen}
          onClick={() => setTrashedOpen((open) => !open)}
        >
          <span className={styles.shelfLabelSettled}>
            {`Recently deleted · ${trashedThreads.length}`}
          </span>
          <span className={styles.shelfRuleSettled} />
          <span
            className={styles.shelfChevron}
            data-open={trashedOpen}
            aria-hidden
          >
            <Icon size={12}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </span>
        </button>
      </div>
      {trashedOpen &&
        trashedThreads.map((row) => (
          <div
            key={row.id}
            className={styles.slimRow}
            data-trashed-row={row.id}
          >
            <div className={styles.slimBody}>
              <span className={styles.slimTitle}>{row.title}</span>
              <span className={styles.slimSlug}>
                {row.projectMissing
                  ? "Project unavailable"
                  : (row.projectSlug ?? "unknown")}
              </span>
              <span className={styles.slimSlot}>
                <span className={styles.slimAge}>
                  {formatTrashExpiry(row.expiresAt, now)}
                </span>
                {onRestoreThread && (
                  <button
                    type="button"
                    className={styles.slimAction}
                    data-restore-btn={row.id}
                    disabled={row.projectMissing}
                    title={
                      row.projectMissing
                        ? "Cannot restore: project is no longer available"
                        : "Restore thread"
                    }
                    onClick={() => void onRestoreThread(row.id)}
                  >
                    Restore
                  </button>
                )}
                {onPurgeThread &&
                  (purgeConfirmId === row.id ? (
                    <button
                      type="button"
                      className={`${styles.slimAction} ${styles.trashPurge}`}
                      data-purge-confirm={row.id}
                      onClick={() => {
                        setPurgeConfirmId(null);
                        void onPurgeThread(row.id);
                      }}
                    >
                      Confirm
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`${styles.slimAction} ${styles.trashPurge}`}
                      data-purge-btn={row.id}
                      title="Delete permanently"
                      onClick={() => setPurgeConfirmId(row.id)}
                    >
                      Delete
                    </button>
                  ))}
              </span>
            </div>
          </div>
        ))}
    </div>
  );
}
