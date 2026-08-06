import type { ChatMessage, WorkLogItem } from "./shared/ipc";

export interface WorkLogGroup {
  kind: "worklog";
  runId: string;
  items: WorkLogItem[];
  /** Earliest item timestamp in the group. */
  timestamp: number;
}

export interface MessageEntry {
  kind: "message";
  message: ChatMessage;
  timestamp: number;
}

export type TimelineEntry = WorkLogGroup | MessageEntry;

/**
 * Build a single chronological timeline: every ChatMessage plus one WorkLogGroup
 * per distinct runId (timestamp = earliest item in the group). Empty work-log
 * groups are never emitted. When timestamps tie, messages sort before work logs
 * so a user prompt that starts a run appears above that run's card.
 */
export function buildTimeline(
  messages: ChatMessage[],
  workLog: WorkLogItem[],
): TimelineEntry[] {
  const byRun = new Map<string, WorkLogItem[]>();
  for (const item of workLog) {
    const list = byRun.get(item.runId);
    if (list) list.push(item);
    else byRun.set(item.runId, [item]);
  }

  const entries: TimelineEntry[] = [];

  for (const message of messages) {
    entries.push({
      kind: "message",
      message,
      timestamp: message.createdAt,
    });
  }

  for (const [runId, items] of byRun) {
    if (items.length === 0) continue;
    const sorted = [...items].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id.localeCompare(b.id);
    });
    const earliest = sorted[0]!.timestamp;
    entries.push({
      kind: "worklog",
      runId,
      items: sorted,
      timestamp: earliest,
    });
  }

  entries.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    // Messages before work-log cards on ties (user prompt then its run card).
    if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
    // Same-kind ties: return 0 so the stable sort keeps store/input order.
    // Do not sort by randomUUID ids or runId strings.
    return 0;
  });

  return entries;
}

/** "Worked for Xm Ys" from a group's earliest to latest item timestamp. */
export function workLogDurationLabel(
  items: WorkLogItem[],
  now?: number,
): string | null {
  if (items.length === 0) return null;
  const times = items.map((i) => i.timestamp);
  const min = Math.min(...times);
  const max = now != null ? Math.max(...times, now) : Math.max(...times);
  const span = Math.max(0, max - min);
  const secs = Math.floor(span / 1000);
  if (secs < 60) return `Worked for ${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `Worked for ${m}m ${s}s` : `Worked for ${m}m`;
}
