import type { ThreadInfo } from "./shared/ipc";

/**
 * After archiving or deleting `leavingId`, pick the next thread still shown
 * in the default sidebar (non-archived). Prefers the same project, then any
 * other visible thread. Returns null for empty state.
 */
export function nextVisibleThreadId(
  threads: ThreadInfo[],
  leavingId: string,
): string | null {
  const leaving = threads.find((t) => t.id === leavingId);
  const visible = threads.filter((t) => t.id !== leavingId && !t.archived);
  if (visible.length === 0) return null;

  if (leaving) {
    const sameProject = visible.filter((t) => t.projectId === leaving.projectId);
    if (sameProject.length > 0) {
      return sameProject[0]!.id;
    }
  }
  return visible[0]!.id;
}
