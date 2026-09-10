import type { ThreadDetail } from "./shared/ipc";

/**
 * Session-only cache of previously opened transcripts (#1225).
 * Render-first switching (#364) stays for a small recent set; visiting the
 * whole history must not retain every ThreadDetail in the renderer.
 */

/** Recent working set. Enough to flip between a handful of open threads. */
export const DETAIL_CACHE_MAX_ENTRIES = 8;
/** Retained payload across cached details. One larger transcript is not admitted. */
export const DETAIL_CACHE_MAX_BYTES = 8 * 1024 * 1024;

type Entry = { detail: ThreadDetail; bytes: number };

export interface ThreadDetailCache {
  get(id: string): ThreadDetail | undefined;
  /** False when the detail is too large to keep. */
  set(id: string, detail: ThreadDetail): boolean;
  delete(id: string): void;
  /** Drop entries whose thread id is not in the authoritative list. */
  retain(aliveIds: ReadonlySet<string>): void;
  dropProject(projectId: string): void;
  readonly size: number;
  readonly bytes: number;
}

/** Cheap payload estimate: transcript strings, not JSON.stringify on every stream tick. */
export function estimateThreadDetailBytes(detail: ThreadDetail): number {
  let n = 128;
  for (const m of detail.messages ?? []) {
    n += 32 + (m.text?.length ?? 0) + (m.id?.length ?? 0);
    if (m.tool) {
      n += (m.tool.input?.length ?? 0) + (m.tool.output?.length ?? 0);
    }
  }
  for (const w of detail.workLog ?? []) {
    n += 24 + (w.label?.length ?? 0) + (w.id?.length ?? 0);
  }
  return n;
}

export function createThreadDetailCache(opts?: {
  maxEntries?: number;
  maxBytes?: number;
}): ThreadDetailCache {
  const maxEntries = opts?.maxEntries ?? DETAIL_CACHE_MAX_ENTRIES;
  const maxBytes = opts?.maxBytes ?? DETAIL_CACHE_MAX_BYTES;
  const map = new Map<string, Entry>();
  let totalBytes = 0;

  function drop(id: string): void {
    const prev = map.get(id);
    if (!prev) return;
    map.delete(id);
    totalBytes -= prev.bytes;
  }

  function evict(): void {
    for (const [id, entry] of map) {
      if (map.size <= maxEntries && totalBytes <= maxBytes) return;
      map.delete(id);
      totalBytes -= entry.bytes;
    }
  }

  return {
    get(id: string): ThreadDetail | undefined {
      const hit = map.get(id);
      if (!hit) return undefined;
      map.delete(id);
      map.set(id, hit);
      return hit.detail;
    },
    set(id: string, detail: ThreadDetail): boolean {
      drop(id);
      const bytes = estimateThreadDetailBytes(detail);
      if (bytes > maxBytes) return false;
      map.set(id, { detail, bytes });
      totalBytes += bytes;
      evict();
      return map.has(id);
    },
    delete: drop,
    retain(aliveIds: ReadonlySet<string>): void {
      for (const id of [...map.keys()]) {
        if (!aliveIds.has(id)) drop(id);
      }
    },
    dropProject(projectId: string): void {
      for (const [id, entry] of [...map]) {
        if (entry.detail.thread.projectId === projectId) drop(id);
      }
    },
    get size() {
      return map.size;
    },
    get bytes() {
      return totalBytes;
    },
  };
}
