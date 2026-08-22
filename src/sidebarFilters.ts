/**
 * Sidebar status / provider / project filters and group-by (#553).
 *
 * Pure: match ThreadInfo fields only — never scan message text (#144).
 * Search still owns full-text; callers AND these filters onto its hits.
 */
import type { ProjectInfo, ThreadInfo } from "./shared/ipc";
import { buildSidebarGroups, type SidebarGroup } from "./sidebarGroups";
import {
  comparePinnedOldestFirst,
  isPinned,
} from "./threadSnooze";
import { isDelegating, type WaitState } from "./waiting";

export const STATUS_FILTER_KEY = "sidebar:statusFilter";
export const PROVIDER_FILTER_KEY = "sidebar:providerFilter";
export const GROUP_BY_KEY = "sidebar:groupBy";

export type StatusFilter =
  | "running"
  | "waiting"
  | "failed"
  | "idle"
  | "archived";

export type GroupBy = "none" | "project" | "status";

export interface StatusFilterOption {
  id: StatusFilter;
  /** Menu copy. */
  label: string;
  /** Compact trigger copy. */
  short: string;
}

export const STATUS_FILTERS: readonly StatusFilterOption[] = [
  { id: "running", label: "Running", short: "Running" },
  { id: "waiting", label: "Waiting on you", short: "Waiting" },
  { id: "failed", label: "Failed", short: "Failed" },
  { id: "idle", label: "Idle", short: "Idle" },
  { id: "archived", label: "Archived", short: "Archived" },
];

export interface GroupByOption {
  id: GroupBy;
  label: string;
}

export const GROUP_BY_OPTIONS: readonly GroupByOption[] = [
  { id: "none", label: "Default" },
  { id: "project", label: "Project" },
  { id: "status", label: "Status" },
];

const STATUS_IDS = new Set<string>(STATUS_FILTERS.map((s) => s.id));
const GROUP_BY_IDS = new Set<string>(GROUP_BY_OPTIONS.map((g) => g.id));

/** Badge-aligned bucket. Archived wins so a failed archive is Archived. */
export function threadStatusBucket(
  thread: ThreadInfo,
  wait: WaitState | null | undefined,
): StatusFilter {
  if (thread.archived) return "archived";
  if (thread.status === "failed") return "failed";
  if (thread.status === "working" && thread.awaitingInput) return "waiting";
  if (wait && wait.blocked > 0) return "waiting";
  if (thread.status === "working") return "running";
  if (isDelegating(thread.status, wait)) return "running";
  return "idle";
}

export interface ThreadFilter {
  status: StatusFilter | null;
  /** Empty = all providers. */
  providers: readonly string[];
  /** Null = all projects. */
  projectId: string | null;
}

export function threadMatchesFilter(
  thread: ThreadInfo,
  filter: ThreadFilter,
  wait: WaitState | null | undefined,
): boolean {
  if (filter.status != null && threadStatusBucket(thread, wait) !== filter.status) {
    return false;
  }
  if (filter.providers.length > 0 && !filter.providers.includes(thread.provider)) {
    return false;
  }
  if (filter.projectId != null && thread.projectId !== filter.projectId) {
    return false;
  }
  return true;
}

/**
 * AND status + provider + project onto a thread list.
 * keepIds (open / revealed thread) stay visible even when they miss the
 * filter — the #70 carve-out. They must already be in `threads`.
 */
export function filterThreads(
  threads: readonly ThreadInfo[],
  filter: ThreadFilter,
  opts: {
    waits?: ReadonlyMap<string, WaitState>;
    keepIds?: readonly (string | null | undefined)[];
  } = {},
): ThreadInfo[] {
  const keep = new Set<string>();
  for (const id of opts.keepIds ?? []) {
    if (id) keep.add(id);
  }
  const out: ThreadInfo[] = [];
  for (const thread of threads) {
    if (keep.has(thread.id)) {
      out.push(thread);
      continue;
    }
    if (threadMatchesFilter(thread, filter, opts.waits?.get(thread.id))) {
      out.push(thread);
    }
  }
  return out;
}

export function parseStatusFilter(raw: string | null): StatusFilter | null {
  if (raw != null && STATUS_IDS.has(raw)) return raw as StatusFilter;
  return null;
}

export function parseGroupBy(raw: string | null): GroupBy {
  if (raw != null && GROUP_BY_IDS.has(raw)) return raw as GroupBy;
  return "none";
}

export function parseProviderFilter(raw: string | null): string[] {
  if (raw == null || raw === "") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function serializeProviderFilter(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : ids.join(",");
}

export interface StatusGroup {
  id: Exclude<StatusFilter, "archived">;
  label: string;
  threads: ThreadInfo[];
}

const STATUS_GROUP_ORDER: readonly StatusGroup["id"][] = [
  "running",
  "waiting",
  "failed",
  "idle",
];

function createdKey(thread: ThreadInfo): number {
  return Number.isFinite(thread.createdAt) ? thread.createdAt : thread.updatedAt;
}

/** Pin-first, then static createdAt desc — same as a project group. */
export function sortAttentionThreads(threads: readonly ThreadInfo[]): ThreadInfo[] {
  return threads.slice().sort(
    (a, b) =>
      Number(isPinned(b)) - Number(isPinned(a)) ||
      (isPinned(a) && isPinned(b) ? comparePinnedOldestFirst(a, b) : 0) ||
      createdKey(b) - createdKey(a) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Group attention threads by status bucket. Empty buckets omitted.
 * Archived rows are not a status group — they stay on the Later shelf.
 */
export function groupThreadsByStatus(
  threads: readonly ThreadInfo[],
  waits?: ReadonlyMap<string, WaitState>,
): StatusGroup[] {
  const buckets: Record<StatusGroup["id"], ThreadInfo[]> = {
    running: [],
    waiting: [],
    failed: [],
    idle: [],
  };
  for (const thread of threads) {
    const bucket = threadStatusBucket(thread, waits?.get(thread.id));
    if (bucket === "archived") continue;
    buckets[bucket].push(thread);
  }
  const out: StatusGroup[] = [];
  for (const id of STATUS_GROUP_ORDER) {
    if (buckets[id].length === 0) continue;
    const option = STATUS_FILTERS.find((s) => s.id === id);
    out.push({
      id,
      label: option?.label ?? id,
      threads: sortAttentionThreads(buckets[id]),
    });
  }
  return out;
}

/** Project groups with at least one thread. Empty projects stay hidden. */
export function groupThreadsByProject(
  projects: readonly ProjectInfo[],
  threads: readonly ThreadInfo[],
): SidebarGroup[] {
  return buildSidebarGroups([...projects], [...threads]).filter(
    (g) => g.threads.length > 0,
  );
}

export function statusFilterLabel(id: StatusFilter | null): string {
  if (id == null) return "Status";
  return STATUS_FILTERS.find((s) => s.id === id)?.short ?? "Status";
}

export function groupByLabel(id: GroupBy): string {
  if (id === "none") return "Group";
  return GROUP_BY_OPTIONS.find((g) => g.id === id)?.label ?? "Group";
}

export function providerFilterLabel(
  selected: readonly string[],
  names: ReadonlyMap<string, string>,
): string {
  if (selected.length === 0) return "Provider";
  if (selected.length === 1) {
    const id = selected[0]!;
    return names.get(id) ?? id;
  }
  return `${selected.length} providers`;
}
