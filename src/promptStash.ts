/**
 * Per-provider prompt stash (issue #381). A STACK, not a draft: Cmd+S
 * captures the current composer (text + images + model) and clears it.
 * Distinct from the per-thread draft that follows you across switches.
 */

import type { AttachmentInfo, ReasoningEffort } from "./shared/ipc";

export const STASH_STACK_CAP = 20;
export const STASH_KEY_PREFIX = "coder.promptStash.";

export interface StashEntry {
  text: string;
  attachments: AttachmentInfo[];
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  at: number;
}

export function stashStorageKey(provider: string): string {
  return `${STASH_KEY_PREFIX}${provider}`;
}

function readStore(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadStash(provider: string): StashEntry[] {
  const store = readStore();
  if (!store) return [];
  try {
    const raw = store.getItem(stashStorageKey(provider));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStashEntry).slice(0, STASH_STACK_CAP);
  } catch {
    return [];
  }
}

function isStashEntry(row: unknown): row is StashEntry {
  if (!row || typeof row !== "object") return false;
  const r = row as StashEntry;
  return typeof r.text === "string" && Array.isArray(r.attachments);
}

export function saveStash(provider: string, stack: StashEntry[]): void {
  const store = readStore();
  if (!store) return;
  try {
    store.setItem(
      stashStorageKey(provider),
      JSON.stringify(stack.slice(0, STASH_STACK_CAP)),
    );
  } catch {
    // Private mode / quota: stash is best-effort.
  }
}

export function pushStash(
  provider: string,
  entry: Omit<StashEntry, "at">,
  now = Date.now(),
): StashEntry[] {
  const next: StashEntry = { ...entry, at: now };
  const stack = [next, ...loadStash(provider)].slice(0, STASH_STACK_CAP);
  saveStash(provider, stack);
  return stack;
}

/** Remove and return the most recent entry, or null when the stack is empty. */
export function popStash(provider: string): StashEntry | null {
  const stack = loadStash(provider);
  const top = stack[0];
  if (!top) return null;
  saveStash(provider, stack.slice(1));
  return top;
}

/** Undo a just-pushed stash: pop and return that entry. */
export function undoStash(provider: string): StashEntry | null {
  return popStash(provider);
}

export function stashIsEmpty(entry: Omit<StashEntry, "at">): boolean {
  return !entry.text.trim() && entry.attachments.length === 0;
}
