import type { ThreadDetail, ThreadInfo, ThreadPatch } from "./shared/ipc";

/**
 * Structural equality for pushed payloads. They cross an IPC/JSON boundary and
 * are built by the same code path on every push, so key order is stable and
 * stringify is a sound comparison — and orders of magnitude cheaper than the
 * re-render a false "changed" costs. A false "changed" is only a wasted
 * render, never a stale view.
 *
 * ponytail: stringify, not a deep-equal walker; the payloads are small.
 */
function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Replace `next`'s row in the thread list, KEEPING the old array and row
 * identity when nothing actually changed.
 *
 * A run pushes thread:updated every 700ms whether or not the summary moved.
 * Mapping a fresh array each time re-rendered every pane that holds the list
 * (issue #91), so the no-op ticks — tool still running, waiting on a prompt —
 * now cost nothing above the wire.
 */
export function patchThreadList(
  list: ThreadInfo[],
  next: ThreadInfo,
): ThreadInfo[] {
  const i = list.findIndex((t) => t.id === next.id);
  if (i < 0 || sameJson(list[i], next)) return list;
  const out = list.slice();
  out[i] = next;
  return out;
}

/**
 * True when applying `tail` at `from` would reproduce the array we already
 * hold — i.e. the pushed tail is identical to the existing suffix. Compared
 * per element so an empty or unchanged tail costs almost nothing.
 */
function sameTail(prevArr: unknown[], from: number, tail: unknown[]): boolean {
  if (prevArr.length - from !== tail.length) return false;
  for (let i = 0; i < tail.length; i++) {
    if (!sameJson(prevArr[from + i], tail[i])) return false;
  }
  return true;
}

/**
 * Apply a streamed tail (see ThreadPatch) to the open detail.
 *
 * The patch replaces everything from its index onward, so a shrinking
 * transcript (checkpoint restore, compaction) merges correctly too.
 *
 * Returns null when the tail starts past the end of what we hold — a push was
 * missed (web reconnect), and merging would leave a hole. The caller must
 * refetch the full detail instead.
 *
 * Returns `prev` itself when nothing moved: ThreadView keys its timeline
 * derivation on the detail identity, so a tick that only re-sent identical
 * data must not produce a fresh object.
 */
export function mergeThreadPatch(
  prev: ThreadDetail,
  patch: ThreadPatch,
): ThreadDetail | null {
  const { messagesFrom = 0, workLogFrom = 0, ...rest } = patch;
  if (messagesFrom > prev.messages.length || workLogFrom > prev.workLog.length) {
    return null;
  }
  // Keep the identities the panes are memoized on: an unchanged summary or
  // usage must not invalidate AgentsPanel (or effects keyed on `thread`)
  // just because the tick rebuilt the object.
  const thread = sameJson(prev.thread, rest.thread) ? prev.thread : rest.thread;
  const usage = sameJson(prev.usage, rest.usage) ? prev.usage : rest.usage;
  const workflow = sameJson(prev.workflow, rest.workflow)
    ? prev.workflow
    : rest.workflow;
  const pendingPermission = sameJson(
    prev.pendingPermission,
    rest.pendingPermission,
  )
    ? prev.pendingPermission
    : rest.pendingPermission;
  const messages = sameTail(prev.messages, messagesFrom, patch.messages)
    ? prev.messages
    : messagesFrom === 0
      ? patch.messages
      : [...prev.messages.slice(0, messagesFrom), ...patch.messages];
  const workLog = sameTail(prev.workLog, workLogFrom, patch.workLog)
    ? prev.workLog
    : workLogFrom === 0
      ? patch.workLog
      : [...prev.workLog.slice(0, workLogFrom), ...patch.workLog];
  if (
    thread === prev.thread &&
    usage === prev.usage &&
    workflow === prev.workflow &&
    pendingPermission === prev.pendingPermission &&
    messages === prev.messages &&
    workLog === prev.workLog
  ) {
    return prev;
  }
  return { ...rest, thread, usage, workflow, pendingPermission, messages, workLog };
}
