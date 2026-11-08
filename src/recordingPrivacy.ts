import type { ThreadInfo } from "./shared/ipc";

export interface RecordingPrivacy {
  enabled: boolean;
  hiddenTags: string[];
}
export const RECORDING_PRIVACY_KEY = "coder.recordingPrivacy";
export const DEFAULT_RECORDING_PRIVACY: RecordingPrivacy = { enabled: false, hiddenTags: [] };

export function parseRecordingPrivacy(raw: string | null): RecordingPrivacy {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || !Array.isArray(value.hiddenTags)) return DEFAULT_RECORDING_PRIVACY;
    return {
      enabled: value.enabled === true,
      hiddenTags: [...new Set<string>(value.hiddenTags.filter((tag: unknown): tag is string => typeof tag === "string" && tag.trim().length > 0))],
    };
  } catch {
    return DEFAULT_RECORDING_PRIVACY;
  }
}

/** Presentation only: never mutate, archive, or stop the underlying threads. */
export function recordingVisibility(threads: readonly ThreadInfo[], privacy: RecordingPrivacy) {
  const tags = new Set(privacy.hiddenTags);
  const hiddenIds = new Set(privacy.enabled
    ? threads.filter((t) => t.tags?.some((tag) => tags.has(tag))).map((t) => t.id)
    : []);
  const knownIds = new Set(threads.map((t) => t.id));
  const visible = (id: string) => !hiddenIds.has(id) && (!privacy.enabled || knownIds.has(id));
  const presentThread = (thread: ThreadInfo): ThreadInfo => !privacy.enabled ? thread : ({
    ...thread,
    remoteWorkers: thread.remoteWorkers?.filter((w) => visible(w.threadId)),
    crewRelay: thread.crewRelay && visible(thread.crewRelay.leadId) ? thread.crewRelay : null,
    teleportedTo: thread.teleportedTo?.threadId && !visible(thread.teleportedTo.threadId) ? null : thread.teleportedTo,
    teleportedFrom: thread.teleportedFrom && !visible(thread.teleportedFrom.threadId) ? null : thread.teleportedFrom,
    integrationReceipts: thread.integrationReceipts?.filter((r) => visible(r.workerId)),
  });
  return {
    visible,
    enabled: privacy.enabled,
    hiddenIds,
    presentThread,
    threads: threads.filter((t) => visible(t.id)).map(presentThread),
    // Invalidates presentation caches immediately when mode or membership changes.
    key: JSON.stringify([privacy.enabled, [...hiddenIds].sort()]),
  };
}
