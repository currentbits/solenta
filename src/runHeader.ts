import type { ChatMessage, ThreadStatus } from "./shared/ipc";
import { completedRunIds } from "./reviewBar";

export interface RunHeader {
  runId: string;
  /** Earliest message of the run; the header row anchors above it. */
  firstMessageId: string;
  /** "Worked for 2m 5s" style label. */
  label: string;
}

/**
 * "Worked for 2m 5s" from a millisecond span. Anything under one second,
 * including a zero span (a run with a single timestamp), reads
 * "Worked for <1s".
 */
export function formatRunDuration(spanMs: number): string {
  const secs = Math.floor(Math.max(0, spanMs) / 1000);
  if (secs < 1) return "Worked for <1s";
  if (secs < 60) return `Worked for ${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `Worked for ${m}m ${s}s` : `Worked for ${m}m`;
}

/**
 * One collapsible header per completed run (same run set as the review bars:
 * the in-progress last run of a working thread is dropped). Duration is the
 * last message's createdAt minus the first message's createdAt of the run.
 */
export function mapRunHeaders(
  messages: ChatMessage[],
  threadStatus: ThreadStatus,
): RunHeader[] {
  const runIds = completedRunIds(messages, threadStatus);
  if (runIds.length === 0) return [];
  const wanted = new Set(runIds);
  const spans = new Map<
    string,
    { firstId: string; firstAt: number; lastAt: number }
  >();
  for (const m of messages) {
    const id = m.runId;
    if (!id || !wanted.has(id)) continue;
    const span = spans.get(id);
    if (!span) {
      spans.set(id, {
        firstId: m.id,
        firstAt: m.createdAt,
        lastAt: m.createdAt,
      });
      continue;
    }
    if (m.createdAt < span.firstAt) {
      span.firstAt = m.createdAt;
      span.firstId = m.id;
    }
    if (m.createdAt > span.lastAt) span.lastAt = m.createdAt;
  }
  const headers: RunHeader[] = [];
  for (const runId of runIds) {
    const span = spans.get(runId);
    if (!span) continue;
    headers.push({
      runId,
      firstMessageId: span.firstId,
      label: formatRunDuration(span.lastAt - span.firstAt),
    });
  }
  return headers;
}

/** Per-run open state: a run is open unless its id is in the collapsed set. */
export function isRunCollapsed(
  collapsed: ReadonlySet<string>,
  runId: string,
): boolean {
  return collapsed.has(runId);
}

/** Flip one run's collapsed state, returning a new set. */
export function toggleRunCollapsed(
  collapsed: ReadonlySet<string>,
  runId: string,
): Set<string> {
  const next = new Set(collapsed);
  if (next.has(runId)) next.delete(runId);
  else next.add(runId);
  return next;
}
