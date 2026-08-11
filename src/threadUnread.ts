import type { ThreadInfo } from "./shared/ipc";

/**
 * Pure unread predicate for ThreadInfo.lastVisitedAt (round 43).
 *
 * Contract (src/shared/ipc.ts): Unread = updatedAt > lastVisitedAt.
 * Null lastVisitedAt means legacy (pre-field) threads — treat as NOT unread
 * so an upgrade does not light up every historical row.
 *
 * The SELECTED thread never *renders* unread (you are looking at it). That is
 * a Sidebar render rule, not part of this predicate — keep selection out so
 * headers can still count a selected unread row if the list has not re-stamped.
 */
export function isUnread(thread: Pick<ThreadInfo, "updatedAt" | "lastVisitedAt">): boolean {
  return thread.lastVisitedAt != null && thread.updatedAt > thread.lastVisitedAt;
}

/** Count isUnread threads (for group / settled headers). */
export function countUnread(threads: readonly Pick<ThreadInfo, "updatedAt" | "lastVisitedAt">[]): number {
  let n = 0;
  for (const t of threads) if (isUnread(t)) n += 1;
  return n;
}
