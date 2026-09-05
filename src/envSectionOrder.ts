import { useSyncExternalStore } from "react";

/**
 * Personal Environment-tab section order. Module state is the source of
 * truth (GitTab unmounts when another right-sidebar tab is selected);
 * localStorage carries it across launches, matching uiPrefs.
 */
export const ENV_ORDER_KEY = "coder.envSectionOrder";

export const ENV_SECTION_IDS = [
  "scm",
  "repository",
  "pullRequests",
  "recap",
  "fork",
  "changes",
  "display",
  "remote",
  "pull",
  "devServer",
  "verify",
  "localServers",
  "editor",
  "checkpoints",
] as const;

export type EnvSectionId = (typeof ENV_SECTION_IDS)[number];

export const ENV_SECTION_LABELS: Record<EnvSectionId, string> = {
  scm: "Source control",
  repository: "Repository",
  pullRequests: "Pull requests",
  recap: "Recap",
  fork: "Fork",
  changes: "Changes",
  display: "Display",
  remote: "Remote",
  pull: "Pull",
  devServer: "Dev server",
  verify: "Verification",
  localServers: "Local servers",
  editor: "Editor",
  checkpoints: "Checkpoints",
};

const DEFAULT_ORDER: EnvSectionId[] = [...ENV_SECTION_IDS];

let cached: string[] | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Keep saved ids that still exist, drop unknown/duplicates, append any
 * newly introduced canonical ids in their default relative order.
 */
export function mergeEnvSectionOrder(
  saved: unknown,
  canonical: readonly string[] = ENV_SECTION_IDS,
): string[] {
  const known = new Set(canonical);
  const seen = new Set<string>();
  const result: string[] = [];
  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === "string" && known.has(id) && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
  }
  for (const id of canonical) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

export function moveEnvSection(
  order: readonly string[],
  fromId: string,
  targetId: string,
  place: "before" | "after",
): string[] {
  if (fromId === targetId) return [...order];
  if (!order.includes(fromId) || !order.includes(targetId)) {
    return [...order];
  }
  const next = order.filter((id) => id !== fromId);
  let idx = next.indexOf(targetId);
  if (idx < 0) {
    next.push(fromId);
    return next;
  }
  if (place === "after") idx += 1;
  next.splice(idx, 0, fromId);
  return next;
}

/** Move among currently visible ids; hidden ids keep their relative slots. */
export function moveEnvSectionAmong(
  order: readonly string[],
  visible: readonly string[],
  fromId: string,
  dir: -1 | 1,
): string[] | null {
  const idx = visible.indexOf(fromId);
  if (idx < 0) return null;
  const target = visible[idx + dir];
  if (!target) return null;
  return moveEnvSection(order, fromId, target, dir < 0 ? "before" : "after");
}

export function isDefaultEnvSectionOrder(order: readonly string[]): boolean {
  return (
    order.length === ENV_SECTION_IDS.length &&
    ENV_SECTION_IDS.every((id, i) => order[i] === id)
  );
}

function readStored(): unknown {
  try {
    const raw = globalThis.window?.localStorage?.getItem(ENV_ORDER_KEY) ?? null;
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeStored(order: readonly string[]): void {
  try {
    globalThis.window?.localStorage?.setItem(
      ENV_ORDER_KEY,
      JSON.stringify(order),
    );
  } catch {
    // Private mode / quota: the in-memory order still applies this session.
  }
}

export function getEnvSectionOrder(): string[] {
  if (cached) return cached;
  const stored = readStored();
  cached = stored == null ? [...DEFAULT_ORDER] : mergeEnvSectionOrder(stored);
  return cached;
}

export function setEnvSectionOrder(order: readonly string[]): void {
  const next = mergeEnvSectionOrder(order);
  const prev = cached;
  if (
    prev &&
    prev.length === next.length &&
    prev.every((id, i) => id === next[i])
  ) {
    return;
  }
  cached = next;
  writeStored(next);
  notify();
}

export function resetEnvSectionOrder(): void {
  setEnvSectionOrder(DEFAULT_ORDER);
}

/** Forget the in-memory cache so the next get() re-reads storage. */
export function reloadEnvSectionOrder(): string[] {
  cached = null;
  return getEnvSectionOrder();
}

export function useEnvSectionOrder(): string[] {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getEnvSectionOrder,
    () => DEFAULT_ORDER,
  );
}
