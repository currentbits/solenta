import type { ChatMessage, RunArtifactInfo, WorkLogItem } from "./shared/ipc";

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

export interface ArtifactGroup {
  kind: "artifacts";
  key: string;
  runId: string | null;
  toolCallId?: string;
  artifacts: RunArtifactInfo[];
  timestamp: number;
}

export type TimelineEntry = WorkLogGroup | MessageEntry | ArtifactGroup;

function artifactGroupKey(artifact: RunArtifactInfo): string {
  return `${artifact.runId ?? "manual"}\0${artifact.toolCallId ?? ""}`;
}

function artifactTimestamp(createdAt: string): number {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? t : 0;
}

function timelineKindOrder(kind: TimelineEntry["kind"]): number {
  if (kind === "message") return 0;
  if (kind === "artifacts") return 1;
  return 2;
}

/**
 * Build a single chronological timeline: every ChatMessage plus one WorkLogGroup
 * per distinct runId (timestamp = earliest item in the group) and artifact
 * groups keyed by run/tool call. Empty work-log groups are never emitted.
 * When timestamps tie, messages sort before artifact groups before work logs
 * so a user prompt that starts a run appears above that run's evidence card.
 */
export function buildTimeline(
  messages: ChatMessage[],
  workLog: WorkLogItem[],
  artifacts: RunArtifactInfo[] = [],
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

  const artifactGroups = new Map<string, RunArtifactInfo[]>();
  for (const artifact of artifacts) {
    const key = artifactGroupKey(artifact);
    const list = artifactGroups.get(key);
    if (list) list.push(artifact);
    else artifactGroups.set(key, [artifact]);
  }

  for (const [key, groupArtifacts] of artifactGroups) {
    const sorted = [...groupArtifacts].sort((a, b) => {
      const at = artifactTimestamp(a.createdAt);
      const bt = artifactTimestamp(b.createdAt);
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
    const earliest = sorted.reduce(
      (min, a) => Math.min(min, artifactTimestamp(a.createdAt)),
      Number.POSITIVE_INFINITY,
    );
    const first = sorted[0]!;
    entries.push({
      kind: "artifacts",
      key,
      runId: first.runId,
      toolCallId: first.toolCallId,
      artifacts: sorted,
      timestamp: Number.isFinite(earliest) ? earliest : 0,
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
    const order = timelineKindOrder(a.kind) - timelineKindOrder(b.kind);
    if (order !== 0) return order;
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
