"use strict";

/**
 * Sidebar content scan that can run in a worker_threads Worker.
 * Reads shard files itself and never touches Store._messagesHydrated.
 */

const { isMainThread, parentPort } = require("node:worker_threads");
const fs = require("node:fs");

/**
 * @param {unknown} messages
 * @returns {string[]}
 */
function collectMessageTexts(messages) {
  if (!Array.isArray(messages)) return [];
  const texts = [];
  for (const m of messages) {
    if (m && m.text != null) texts.push(String(m.text));
  }
  return texts;
}

/**
 * @param {string[]} texts
 * @param {string} needle already lowercased
 */
function textsMatch(texts, needle) {
  for (const text of texts) {
    if (text.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Parse a shard or raw JSON array and match message text only.
 * Corrupt JSON is a miss — callers must not write the file back.
 * @param {string} json
 * @param {string} needle
 * @returns {boolean}
 */
function parseAndMatch(json, needle) {
  let val;
  try {
    val = JSON.parse(json);
  } catch {
    return false;
  }
  return textsMatch(collectMessageTexts(val), needle);
}

/**
 * @param {{
 *   id?: string,
 *   title?: string,
 *   notes?: string,
 *   liveTexts?: string[] | null,
 *   rawJson?: string | null,
 *   shardPath?: string | null,
 * }} thread
 * @param {string} needle already lowercased
 * @returns {boolean}
 */
function threadMatches(thread, needle) {
  if (!thread || thread.id == null) return false;
  if (thread.title && String(thread.title).toLowerCase().includes(needle)) {
    return true;
  }
  if (thread.notes && String(thread.notes).toLowerCase().includes(needle)) {
    return true;
  }
  if (thread.liveTexts && textsMatch(thread.liveTexts, needle)) return true;
  if (thread.rawJson && parseAndMatch(thread.rawJson, needle)) return true;
  if (!thread.shardPath) return false;
  let raw;
  try {
    raw = fs.readFileSync(thread.shardPath, "utf8");
  } catch {
    return false;
  }
  if (!raw.toLowerCase().includes(needle)) return false;
  return parseAndMatch(raw, needle);
}

const SEARCH_LIMIT = 50;

/**
 * @param {Array<{ id: string, updatedAt: number }>} hits
 * @returns {{ ids: string[], truncated: boolean }}
 */
function rankSearchHits(hits) {
  hits.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    ids: hits.slice(0, SEARCH_LIMIT).map((h) => h.id),
    truncated: hits.length > SEARCH_LIMIT,
  };
}

// Roles that never surface as a message-search hit (#1761): tool-call
// summaries and event noise are not something the user typed or read.
const MESSAGE_SEARCH_SKIP_ROLES = new Set(["tool", "event"]);
const MESSAGE_SEARCH_LIMIT = 30;
const MESSAGE_SEARCH_PER_THREAD = 3;
const SNIPPET_RADIUS = 60;

/**
 * @param {unknown} messages
 * @returns {Array<{ id: unknown, text: unknown, createdAt: unknown }>}
 */
function searchableMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m) => m && m.text != null && !MESSAGE_SEARCH_SKIP_ROLES.has(m.role),
  );
}

/**
 * @param {string} lowerText
 * @param {string[]} words already lowercased
 */
function allWordsMatch(lowerText, words) {
  for (const w of words) {
    if (!lowerText.includes(w)) return false;
  }
  return true;
}

/**
 * ~120 chars of context around the earliest matching word.
 * @param {string} text
 * @param {string} lowerText
 * @param {string[]} words already lowercased
 */
function buildSnippet(text, lowerText, words) {
  let at = -1;
  for (const w of words) {
    const i = lowerText.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

/**
 * Up to MESSAGE_SEARCH_PER_THREAD hits for one thread, newest message
 * first so a long thread with an old match does not cost scanning past
 * the first few hits.
 * @param {string} threadId
 * @param {unknown} messages
 * @param {string[]} words already lowercased
 * @returns {Array<{ threadId: string, messageId: string, snippet: string, createdAt: number }>}
 */
function matchThreadMessages(threadId, messages, words) {
  const list = searchableMessages(messages);
  const hits = [];
  for (let i = list.length - 1; i >= 0 && hits.length < MESSAGE_SEARCH_PER_THREAD; i--) {
    const m = list[i];
    const text = String(m.text);
    const lowerText = text.toLowerCase();
    if (!allWordsMatch(lowerText, words)) continue;
    hits.push({
      threadId,
      messageId: String(m.id),
      snippet: buildSnippet(text, lowerText, words),
      createdAt: Number(m.createdAt) || 0,
    });
  }
  return hits;
}

/**
 * Parse a message-search row's messages, whichever form the main thread
 * handed over: already-live objects, a raw JSON blob, or a shard path the
 * worker reads itself (same three cases as threadMatches above).
 * @param {{ liveMessages?: unknown[] | null, rawJson?: string | null, shardPath?: string | null }} row
 * @returns {unknown[]}
 */
function messagesForRow(row) {
  if (row.liveMessages) return row.liveMessages;
  let json = row.rawJson;
  if (json == null && row.shardPath) {
    try {
      json = fs.readFileSync(row.shardPath, "utf8");
    } catch {
      return [];
    }
  }
  if (json == null) return [];
  try {
    const val = JSON.parse(json);
    return Array.isArray(val) ? val : [];
  } catch {
    return [];
  }
}

/**
 * @param {{
 *   needle: string,
 *   threads: Array<{
 *     id: string,
 *     liveMessages?: unknown[] | null,
 *     rawJson?: string | null,
 *     shardPath?: string | null,
 *   }>,
 * }} snapshot
 * @returns {{ hits: Array<{ threadId: string, messageId: string, snippet: string, createdAt: number }>, truncated: boolean }}
 */
function scanMessageSearchSnapshot(snapshot) {
  const raw = snapshot && snapshot.needle != null ? String(snapshot.needle) : "";
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const none = { hits: [], truncated: false };
  if (words.length === 0) return none;
  const threads = (snapshot && snapshot.threads) || [];
  const hits = [];
  for (const row of threads) {
    if (!row || row.id == null) continue;
    const messages = messagesForRow(row);
    for (const hit of matchThreadMessages(row.id, messages, words)) {
      hits.push(hit);
    }
  }
  hits.sort((a, b) => b.createdAt - a.createdAt);
  return {
    hits: hits.slice(0, MESSAGE_SEARCH_LIMIT),
    truncated: hits.length > MESSAGE_SEARCH_LIMIT,
  };
}

/**
 * @param {{
 *   needle: string,
 *   threads: Array<{
 *     id: string,
 *     title: string,
 *     notes: string,
 *     updatedAt: number,
 *     liveTexts?: string[] | null,
 *     rawJson?: string | null,
 *     shardPath?: string | null,
 *   }>,
 * }} snapshot
 * @returns {{ ids: string[], truncated: boolean }} matching ids,
 *   updatedAt DESC, max SEARCH_LIMIT; truncated when more matched
 */
function scanSearchSnapshot(snapshot) {
  const needle = snapshot && snapshot.needle != null ? String(snapshot.needle) : "";
  if (needle.length < 2) return { ids: [], truncated: false };
  /** @type {Array<{ id: string, updatedAt: number }>} */
  const hits = [];
  const threads = (snapshot && snapshot.threads) || [];
  for (const t of threads) {
    if (threadMatches(t, needle)) {
      hits.push({ id: t.id, updatedAt: Number(t.updatedAt) || 0 });
    }
  }
  return rankSearchHits(hits);
}

if (!isMainThread && parentPort) {
  parentPort.on("message", (snapshot) => {
    const result =
      snapshot && snapshot.mode === "messages"
        ? scanMessageSearchSnapshot(snapshot)
        : scanSearchSnapshot(snapshot);
    parentPort.postMessage(result);
  });
}

module.exports = {
  collectMessageTexts,
  threadMatches,
  rankSearchHits,
  scanSearchSnapshot,
  scanMessageSearchSnapshot,
  matchThreadMessages,
  messagesForRow,
  SEARCH_LIMIT,
  MESSAGE_SEARCH_LIMIT,
  MESSAGE_SEARCH_PER_THREAD,
};
