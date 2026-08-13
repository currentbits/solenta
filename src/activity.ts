/**
 * Cross-thread activity feed. Newest first, real timestamps only.
 */
import type { ActivityItem, ActivityKind, ThreadInfo } from "./shared/ipc";

export type { ActivityItem, ActivityKind };

export const ACTIVITY_LIMIT = 100;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Work-log rows may grow extra end fields; only those are used for terminals. */
export type ActivityWorkLogEntry = {
  id?: string;
  runId?: string;
  label?: string;
  done?: boolean;
  timestamp?: number;
  endedAt?: number;
  ended?: number;
  finishedAt?: number;
  completedAt?: number;
  kind?: string;
  status?: string;
  result?: string;
};

export type ActivityThread = Pick<
  ThreadInfo,
  | "id"
  | "projectId"
  | "title"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "runStartedAt"
  | "archived"
>;

export interface ActivityDayGroup {
  key: string;
  label: string;
  items: ActivityItem[];
}

export function activityKindLabel(kind: ActivityKind): string {
  if (kind === "done") return "finished";
  return kind;
}

function isRealTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function workLogEndedAt(entry: ActivityWorkLogEntry): number | null {
  const candidates = [
    entry.endedAt,
    entry.ended,
    entry.finishedAt,
    entry.completedAt,
  ];
  for (const value of candidates) {
    if (isRealTime(value)) return value;
  }
  return null;
}

function workLogKind(entry: ActivityWorkLogEntry): ActivityKind | null {
  const raw = entry.kind ?? entry.status ?? entry.result;
  if (raw === "done" || raw === "failed") return raw;
  const label = String(entry.label ?? "").toLowerCase();
  if (/\berror\b|\bfail/.test(label)) return "failed";
  if (/\b(done|complete|finished|success)\b/.test(label)) return "done";
  return null;
}

function pushItem(
  items: ActivityItem[],
  thread: ActivityThread,
  kind: ActivityKind,
  at: number,
  suffix: string,
): void {
  items.push({
    id: `${thread.id}:${kind}:${suffix}`,
    threadId: thread.id,
    projectId: thread.projectId,
    kind,
    at,
    threadTitle: thread.title,
  });
}

/**
 * Build a newest-first feed. `nowMs` is part of the contract (day grouping
 * and tests pin it); items themselves use only stored timestamps.
 */
export function buildActivity(
  threads: readonly ActivityThread[],
  workLogByThread: Readonly<Record<string, readonly ActivityWorkLogEntry[] | undefined>>,
  _nowMs: number,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  const list = Array.isArray(threads) ? threads : [];
  const logs = workLogByThread && typeof workLogByThread === "object"
    ? workLogByThread
    : {};

  for (const thread of list) {
    if (!thread || thread.archived) continue;

    if (isRealTime(thread.createdAt)) {
      pushItem(items, thread, "created", thread.createdAt, "created");
    }

    if (isRealTime(thread.runStartedAt)) {
      pushItem(
        items,
        thread,
        "started",
        thread.runStartedAt,
        String(thread.runStartedAt),
      );
    }

    const entries = Array.isArray(logs[thread.id]) ? logs[thread.id]! : [];
    let fromLog = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const at = workLogEndedAt(entry);
      if (at == null) continue;
      const kind = workLogKind(entry);
      if (kind !== "done" && kind !== "failed") continue;
      fromLog += 1;
      pushItem(items, thread, kind, at, entry.id ?? `log-${i}`);
    }

    if (
      fromLog === 0 &&
      (thread.status === "done" || thread.status === "failed") &&
      isRealTime(thread.updatedAt)
    ) {
      pushItem(items, thread, thread.status, thread.updatedAt, thread.status);
    }
  }

  items.sort((a, b) => (b.at !== a.at ? b.at - a.at : a.id < b.id ? -1 : 1));
  return items.slice(0, ACTIVITY_LIMIT);
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(key: string, todayKey: string, yesterdayKey: string): string {
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  const [ys, ms, ds] = key.split("-");
  const month = MONTHS[Number(ms) - 1] ?? ms;
  return `${Number(ds)} ${month} ${ys}`;
}

/** Group a newest-first feed into Today / Yesterday / dated sections. */
export function groupActivityByDay(
  items: readonly ActivityItem[],
  nowMs: number,
): ActivityDayGroup[] {
  const todayKey = localDayKey(nowMs);
  const y = new Date(nowMs);
  y.setDate(y.getDate() - 1);
  const yesterdayKey = localDayKey(y.getTime());

  const groups: ActivityDayGroup[] = [];
  const index = new Map<string, ActivityDayGroup>();
  for (const item of items) {
    if (!isRealTime(item.at)) continue;
    const key = localDayKey(item.at);
    let group = index.get(key);
    if (!group) {
      group = { key, label: dayLabel(key, todayKey, yesterdayKey), items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
