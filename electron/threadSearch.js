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

/**
 * @param {Array<{ id: string, updatedAt: number }>} hits
 * @returns {string[]}
 */
function rankSearchHits(hits) {
  hits.sort((a, b) => b.updatedAt - a.updatedAt);
  return hits.slice(0, 50).map((h) => h.id);
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
 * @returns {string[]} matching ids, updatedAt DESC, max 50
 */
function scanSearchSnapshot(snapshot) {
  const needle = snapshot && snapshot.needle != null ? String(snapshot.needle) : "";
  if (needle.length < 2) return [];
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
    parentPort.postMessage(scanSearchSnapshot(snapshot));
  });
}

module.exports = {
  collectMessageTexts,
  threadMatches,
  rankSearchHits,
  scanSearchSnapshot,
};
