import type { ThreadDetail, ThreadPatch } from "./shared/ipc";

/**
 * Apply a streamed tail (see ThreadPatch) to the open detail.
 *
 * The patch replaces everything from its index onward, so a shrinking
 * transcript (checkpoint restore, compaction) merges correctly too.
 *
 * Returns null when the tail starts past the end of what we hold — a push was
 * missed (web reconnect), and merging would leave a hole. The caller must
 * refetch the full detail instead.
 */
export function mergeThreadPatch(
  prev: ThreadDetail,
  patch: ThreadPatch,
): ThreadDetail | null {
  const { messagesFrom = 0, workLogFrom = 0, ...rest } = patch;
  if (messagesFrom > prev.messages.length || workLogFrom > prev.workLog.length) {
    return null;
  }
  return {
    ...rest,
    messages:
      messagesFrom === 0
        ? patch.messages
        : [...prev.messages.slice(0, messagesFrom), ...patch.messages],
    workLog:
      workLogFrom === 0
        ? patch.workLog
        : [...prev.workLog.slice(0, workLogFrom), ...patch.workLog],
  };
}
