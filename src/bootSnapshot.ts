import type { ProjectInfo, ThreadDetail, ThreadInfo } from "./shared/ipc";

/**
 * Render-first boot (#364): the first paint after launch shows the sidebar
 * and the last-opened thread from localStorage while loadBootLists /
 * threads.get are still in flight, instead of flashing the empty states.
 * Everything here is best-effort: a corrupt, stale, oversized or unwritable
 * store just means the app boots the old way (empty lists until IPC answers).
 */
const SNAPSHOT_KEY = "coder.bootSnapshot.v1";
const DETAIL_KEY = "coder.threadDetail.v1";
/** Older snapshots describe a week-old workspace; not worth painting. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** ~600 threads serialize to well under 1 MB; past this something is wrong. */
const MAX_SNAPSHOT_CHARS = 4_000_000;

export interface BootSnapshot {
  savedAt: number;
  projects: ProjectInfo[];
  threads: ThreadInfo[];
  selectedThreadId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dropKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // storage went away between the read and here
  }
}

export function loadBootSnapshot(): BootSnapshot | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SNAPSHOT_KEY);
  } catch {
    return null;
  }
  if (!raw || raw.length > MAX_SNAPSHOT_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > MAX_AGE_MS
    ) {
      return null;
    }
    if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.threads)) {
      return null;
    }
    const sel = parsed.selectedThreadId;
    return {
      savedAt: parsed.savedAt,
      projects: parsed.projects as ProjectInfo[],
      threads: parsed.threads as ThreadInfo[],
      selectedThreadId: typeof sel === "string" ? sel : null,
    };
  } catch {
    // Corrupt JSON: drop the key so every launch does not pay the parse.
    dropKey(SNAPSHOT_KEY);
    return null;
  }
}

export function saveBootSnapshot(snap: Omit<BootSnapshot, "savedAt">): void {
  try {
    window.localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ savedAt: Date.now(), ...snap }),
    );
  } catch {
    // Quota/private mode: the next launch simply boots empty.
  }
}

/**
 * The last-opened thread's transcript, for painting a thread switch (or the
 * boot-selected thread) before threads.get answers. Stale tails are fine:
 * the fresh detail REPLACES the cached one in one round-trip, it is never
 * merged into it.
 */
export function loadCachedThreadDetail(id: string | null): ThreadDetail | null {
  if (!id) return null;
  try {
    const raw = window.localStorage.getItem(DETAIL_KEY);
    if (!raw || raw.length > MAX_SNAPSHOT_CHARS) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.thread)) return null;
    const d = parsed as unknown as ThreadDetail;
    return d.thread.id === id ? d : null;
  } catch {
    dropKey(DETAIL_KEY);
    return null;
  }
}

export function saveCachedThreadDetail(d: ThreadDetail | null): void {
  try {
    if (d == null) window.localStorage.removeItem(DETAIL_KEY);
    else window.localStorage.setItem(DETAIL_KEY, JSON.stringify(d));
  } catch {
    // Quota/private mode: a switch just shows the empty pane until the fetch.
  }
}
