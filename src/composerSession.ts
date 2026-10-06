/**
 * Unsent composer text, attachments, and paste cards, keyed by thread.
 * Composer used to keep these in useRef/useState, so they vanished when the
 * thread view unmounted. The maps live here for the app session, and are
 * mirrored to localStorage (debounced) so a draft also survives a restart.
 */
import type { AttachmentInfo } from "./shared/ipc";
import type { PasteCard } from "./pasteCards";

export const keptDrafts: Record<string, string> = {};
export const keptAttachments: Record<string, AttachmentInfo[]> = {};
export const keptPasteCards: Record<string, PasteCard[]> = {};

export const DRAFTS_STORAGE_KEY = "coder.composerDrafts";
export const DRAFTS_SAVE_MS = 400;
/**
 * Serialized size budget. Attachments are path references, so text and
 * paste cards are what grow; paste cards (up to 120k each) go first.
 */
export const DRAFTS_STORE_CAP = 1_000_000;

interface SavedDraft {
  text?: string;
  attachments?: AttachmentInfo[];
  pasteCards?: PasteCard[];
}

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
  scheduleDraftSave();
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function snapshot(): Record<string, SavedDraft> {
  const out: Record<string, SavedDraft> = {};
  const row = (id: string) => (out[id] ??= {});
  for (const [id, text] of Object.entries(keptDrafts)) {
    if (text.trim()) row(id).text = text;
  }
  for (const [id, list] of Object.entries(keptAttachments)) {
    if (list.length) row(id).attachments = list;
  }
  for (const [id, list] of Object.entries(keptPasteCards)) {
    if (list.length) row(id).pasteCards = list;
  }
  return out;
}

/**
 * JSON for storage. Over DRAFTS_STORE_CAP, the largest paste cards are
 * dropped first; typed text and attachment references are always kept.
 */
export function serializeDrafts(cap = DRAFTS_STORE_CAP): string {
  const rows = snapshot();
  let json = JSON.stringify(rows);
  if (json.length <= cap) return json;
  const cards = Object.entries(rows)
    .flatMap(([id, r]) => (r.pasteCards ?? []).map((c) => ({ id, c })))
    .sort((a, b) => b.c.text.length - a.c.text.length);
  for (const { id, c } of cards) {
    const r = rows[id]!;
    r.pasteCards = r.pasteCards!.filter((x) => x !== c);
    if (!r.pasteCards.length) delete r.pasteCards;
    json = JSON.stringify(rows);
    if (json.length <= cap) break;
  }
  return json;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function flushDraftSave(): void {
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = null;
  const store = storage();
  if (!store) return;
  try {
    const json = serializeDrafts();
    if (json === "{}") store.removeItem(DRAFTS_STORAGE_KEY);
    else store.setItem(DRAFTS_STORAGE_KEY, json);
  } catch {
    // Quota / private mode: the in-memory draft still holds for this session.
  }
}

/** Called after any draft map mutation; coalesces bursts of typing. */
export function scheduleDraftSave(): void {
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDraftSave, DRAFTS_SAVE_MS);
}

/** Refill the maps from storage. Runs once at import; tests call it again. */
export function hydrateComposerSession(): void {
  const store = storage();
  if (!store) return;
  let rows: Record<string, SavedDraft>;
  try {
    rows = JSON.parse(store.getItem(DRAFTS_STORAGE_KEY) ?? "{}");
  } catch {
    return;
  }
  if (!rows || typeof rows !== "object") return;
  for (const [id, r] of Object.entries(rows)) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.text === "string") keptDrafts[id] = r.text;
    if (Array.isArray(r.attachments)) keptAttachments[id] = r.attachments;
    if (Array.isArray(r.pasteCards)) keptPasteCards[id] = r.pasteCards;
  }
}

/** Drop drafts of threads that no longer exist (deleted, not archived). */
export function pruneComposerDrafts(threadIds: Iterable<string>): number {
  const known = new Set(threadIds);
  const gone = new Set<string>();
  for (const store of [keptDrafts, keptAttachments, keptPasteCards]) {
    for (const id of Object.keys(store)) {
      if (known.has(id)) continue;
      delete store[id];
      gone.add(id);
    }
  }
  if (gone.size) flushDraftSave();
  return gone.size;
}

export function resetComposerSession(): void {
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = null;
  clearRecord(keptDrafts);
  clearRecord(keptAttachments);
  clearRecord(keptPasteCards);
  try {
    storage()?.removeItem(DRAFTS_STORAGE_KEY);
  } catch {
    // jsdom without storage
  }
}

hydrateComposerSession();
if (typeof window !== "undefined") {
  // A quit inside the debounce window would otherwise lose the last keys.
  window.addEventListener("beforeunload", flushDraftSave);
}
