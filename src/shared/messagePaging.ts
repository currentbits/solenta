/**
 * Shared message-paging slice (#1786), used by the dev/browser fixture
 * (src/dev/threads.ts) and the renderer test fixture (test/support/fakeCoder.ts)
 * to mirror electron/store.js's getMessagesPage without duplicating the cursor
 * math in two TS call sites. Not used by the Electron main process itself
 * (store.js is CommonJS and owns its own copy).
 */
import type { ChatMessage } from "./ipc";

/** Matches electron/store.js DEFAULT_MESSAGE_PAGE_SIZE. */
export const DEFAULT_MESSAGE_PAGE_SIZE = 300;

export interface MessagePage {
  messages: ChatMessage[];
  hasOlderMessages: boolean;
  totalMessageCount: number;
}

/**
 * Newest-first page ending just before `before` (exclusive), or at the end
 * of `list` when `before` is omitted / not found.
 */
export function pageMessages(
  list: readonly ChatMessage[],
  opts?: { limit?: number; before?: string | null },
): MessagePage {
  const limit =
    opts && typeof opts.limit === "number" && opts.limit >= 0
      ? opts.limit
      : DEFAULT_MESSAGE_PAGE_SIZE;
  let end = list.length;
  if (opts && opts.before) {
    const idx = list.findIndex((m) => m.id === opts.before);
    end = idx === -1 ? list.length : idx;
  }
  const start = Math.max(0, end - limit);
  return {
    messages: list.slice(start, end),
    hasOlderMessages: start > 0,
    totalMessageCount: list.length,
  };
}
