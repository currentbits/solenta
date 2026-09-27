/**
 * Unsent composer text, attachments, and paste cards, keyed by thread.
 * Composer used to keep these in useRef/useState, so they vanished when the
 * thread view unmounted. The maps live here for the app session instead.
 */
import type { AttachmentInfo } from "./shared/ipc";
import type { PasteCard } from "./pasteCards";

export const keptDrafts: Record<string, string> = {};
export const keptAttachments: Record<string, AttachmentInfo[]> = {};
export const keptPasteCards: Record<string, PasteCard[]> = {};

function clearRecord<T>(store: Record<string, T>): void {
  for (const key of Object.keys(store)) delete store[key];
}

export function copyListRecord<T>(store: Record<string, T[]>): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const key of Object.keys(store)) out[key] = store[key]!.slice();
  return out;
}

export function syncListRecord<T>(
  store: Record<string, T[]>,
  next: Record<string, T[]>,
): void {
  for (const key of Object.keys(store)) {
    if (!(key in next)) delete store[key];
  }
  for (const key of Object.keys(next)) store[key] = next[key]!.slice();
}

export function resetComposerSession(): void {
  clearRecord(keptDrafts);
  clearRecord(keptAttachments);
  clearRecord(keptPasteCards);
}
