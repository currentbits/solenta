import type { ThreadInfo } from "../../shared/ipc";
import { formatRelativeAge } from "../../format";
import { resolveSettledTimestamp } from "../../threadSettle";
import { formatSnoozeWakeLabel } from "../../threadSnooze";
import { isUnread } from "../../threadUnread";
import { ProjectIcon } from "../ProjectIcon";
import type { SelectOpts } from "./ThreadCard";
import styles from "../Sidebar.module.css";

/**
 * Slim shelf row: title + slug + time. Dimmed at rest, restored on hover.
 * Selectable; hover swaps time for the row's one action.
 */
export function SettledRow({
  thread,
  slug,
  iconUrl = null,
  active,
  now,
  onSelect,
  onSetSettled,
  pinMode = false,
  onSetPinned,
  archived = false,
  onSetArchived,
  multiSelected = false,
  indexHint = null,
}: {
  thread: ThreadInfo;
  slug: string;
  iconUrl?: string | null;
  active: boolean;
  now: number;
  onSelect: (id: string, opts?: SelectOpts) => void;
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
  pinMode?: boolean;
  onSetPinned?: (threadId: string, pinned: boolean) => void | Promise<void>;
  archived?: boolean;
  onSetArchived?: (threadId: string, archived: boolean) => void | Promise<void>;
  multiSelected?: boolean;
  indexHint?: number | null;
}) {
  const wrapUpAt = pinMode
    ? (thread.pinnedAt ?? thread.updatedAt)
    : archived
      ? thread.updatedAt
      : resolveSettledTimestamp(thread);
  const showUnread = !active && isUnread(thread);
  const selectLabel = showUnread
    ? `Select thread: ${thread.title}, unread`
    : `Select thread: ${thread.title}`;
  return (
    <div
      className={styles.slimRow}
      data-slim-row={thread.id}
      data-thread-card={thread.id}
      data-settled={pinMode || archived ? undefined : "true"}
      data-pinned={pinMode ? "true" : undefined}
      data-archived={archived ? "true" : undefined}
      data-active={active}
      data-multi={multiSelected ? "true" : undefined}
      data-unread={showUnread ? "true" : undefined}
    >
      {indexHint != null && (
        <span className={styles.indexHint} data-index-hint={indexHint} aria-hidden>
          {indexHint}
        </span>
      )}
      <button
        type="button"
        className={styles.cardSelect}
        onClick={(e) =>
          onSelect(thread.id, {
            meta: e.metaKey || e.ctrlKey,
            shift: e.shiftKey,
          })
        }
        aria-label={selectLabel}
      />
      <div className={styles.slimBody}>
        {showUnread && <span className={styles.srOnly}>unread</span>}
        <span className={styles.slimTitle}>{thread.title}</span>
        <ProjectIcon url={iconUrl} name={slug} seed={thread.projectId} size={12} />
        <span className={styles.slimSlug}>{slug}</span>
        <span className={styles.slimSlot}>
          <span className={styles.slimAge}>
            {formatRelativeAge(wrapUpAt, now)}
          </span>
          {archived && onSetArchived ? (
            <button
              type="button"
              className={styles.slimAction}
              aria-label="Unarchive thread"
              title="Unarchive thread"
              data-unarchive-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetArchived(thread.id, false);
              }}
            >
              unarchive
            </button>
          ) : pinMode && onSetPinned ? (
            <button
              type="button"
              className={styles.slimAction}
              aria-label="Unpin thread"
              title="Unpin thread"
              data-unpin-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetPinned(thread.id, false);
              }}
            >
              unpin
            </button>
          ) : onSetSettled ? (
            <button
              type="button"
              className={styles.slimAction}
              aria-label="Keep thread active"
              title="Keep thread active"
              data-unsettle-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetSettled(thread.id, "active");
              }}
            >
              keep
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** Slim snoozed shelf row: title + slug + wake countdown. */
export function SnoozedRow({
  thread,
  slug,
  iconUrl = null,
  active,
  now,
  onSelect,
  onSetSnoozed,
  multiSelected = false,
  indexHint = null,
}: {
  thread: ThreadInfo;
  slug: string;
  iconUrl?: string | null;
  active: boolean;
  now: number;
  onSelect: (id: string, opts?: SelectOpts) => void;
  onSetSnoozed?: (threadId: string, until: number | null) => void | Promise<void>;
  onSetSettled?: (
    threadId: string,
    override: "settled" | "active",
  ) => void | Promise<void>;
  multiSelected?: boolean;
  indexHint?: number | null;
}) {
  const showUnread = !active && isUnread(thread);
  const wake = formatSnoozeWakeLabel(thread, now);
  const selectLabel = showUnread
    ? `Select thread: ${thread.title}, unread`
    : `Select thread: ${thread.title}`;
  return (
    <div
      className={styles.slimRow}
      data-slim-row={thread.id}
      data-thread-card={thread.id}
      data-snoozed="true"
      data-active={active}
      data-multi={multiSelected ? "true" : undefined}
      data-unread={showUnread ? "true" : undefined}
    >
      {indexHint != null && (
        <span className={styles.indexHint} data-index-hint={indexHint} aria-hidden>
          {indexHint}
        </span>
      )}
      <button
        type="button"
        className={styles.cardSelect}
        onClick={(e) =>
          onSelect(thread.id, {
            meta: e.metaKey || e.ctrlKey,
            shift: e.shiftKey,
          })
        }
        aria-label={selectLabel}
      />
      <div className={styles.slimBody}>
        {showUnread && <span className={styles.srOnly}>unread</span>}
        <span className={styles.slimTitle}>{thread.title}</span>
        <ProjectIcon url={iconUrl} name={slug} seed={thread.projectId} size={12} />
        <span className={styles.slimSlug}>{slug}</span>
        <span className={styles.slimSlot}>
          <span className={styles.slimAge} data-wake-label={thread.id}>
            {wake}
          </span>
          {onSetSnoozed && (
            <button
              type="button"
              className={styles.slimAction}
              aria-label="Wake thread now"
              title="Wake thread now"
              data-wake-btn={thread.id}
              onClick={(e) => {
                e.stopPropagation();
                void onSetSnoozed(thread.id, null);
              }}
            >
              wake
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
