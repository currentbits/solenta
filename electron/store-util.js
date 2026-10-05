"use strict";

const { randomUUID } = require("node:crypto");

const SPEND_RETENTION_DAYS = 90;

/**
 * Bound a per-thread list to its retention cap, dropping the oldest entries
 * on overflow. Message lists get an event marker in the oldest kept slot so
 * the gap is visible in the transcript instead of silent.
 * @param {unknown} list
 * @param {number} max
 * @param {number} slack
 * @param {string | null} markerText
 * @returns {object[]}
 */
function capList(list, max, slack, markerText) {
  if (!Array.isArray(list)) return [];
  if (list.length <= max + slack) return list;
  const kept = list.slice(-max);
  if (markerText) {
    const first = kept[0] && typeof kept[0] === "object" ? kept[0] : {};
    kept[0] = {
      id: typeof first.id === "string" ? first.id : randomUUID(),
      role: "event",
      text: markerText,
      createdAt: Number(first.createdAt) || Date.now(),
    };
  }
  return kept;
}

/**
 * Local calendar day key YYYY-MM-DD (LOCAL timezone, not UTC).
 * @param {Date} [now]
 * @returns {string}
 */
function localDayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Drop day-keyed map entries older than retention days relative to `now`.
 * Shared by spendByDay and usageByDay so the cutoff maths lives in one place.
 * Mutates the map in place.
 * @param {Record<string, unknown>} spendByDay
 * @param {Date} [now]
 */
function pruneSpendByDay(spendByDay, now = new Date()) {
  if (!spendByDay || typeof spendByDay !== "object") return;
  const cutoff = new Date(now instanceof Date ? now.getTime() : Date.now());
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - SPEND_RETENTION_DAYS);
  const cutoffKey = localDayKey(cutoff);
  for (const key of Object.keys(spendByDay)) {
    if (typeof key !== "string" || key < cutoffKey) {
      delete spendByDay[key];
    }
  }
}

/**
 * Normalize runArtifactsByThread: every thread id maps to an array of plain objects.
 * @param {unknown} raw
 * @returns {Record<string, object[]>}
 */
function normalizeRunArtifactsByThread(raw) {
  /** @type {Record<string, object[]>} */
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [threadId, artifacts] of Object.entries(raw)) {
    if (!Array.isArray(artifacts)) {
      map[threadId] = [];
      continue;
    }
    map[threadId] = artifacts
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({ ...item }));
  }
  return map;
}

/**
 * Normalize spendByDay map and prune old buckets.
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {Record<string, number>}
 */
function normalizeSpendByDay(raw, now = new Date()) {
  /** @type {Record<string, number>} */
  const map = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === "string" && typeof v === "number" && Number.isFinite(v)) {
        map[k] = v;
      }
    }
  }
  pruneSpendByDay(map, now);
  return map;
}

/**
 * @param {unknown} n
 * @returns {number}
 */
function coerceFiniteNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * One usage cell. cachedInputTokens/cacheWriteTokens/wastedUsd are absent on
 * rows written before #556 and read back as 0.
 * @typedef {{ costUsd: number, inputTokens: number, cachedInputTokens: number, cacheWriteTokens: number, outputTokens: number, turns: number, wastedUsd: number }} UsageCell
 * @typedef {UsageCell & { projectId: string, projectName: string, title: string, provider: string, model: string }} UsageThreadCell
 */

/** @returns {UsageCell} */
function emptyUsageCell() {
  return {
    costUsd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 0,
    wastedUsd: 0,
  };
}

/**
 * Coerce a stored cell, defaulting fields older rows never wrote.
 * @param {unknown} entry
 * @returns {UsageCell}
 */
function coerceUsageCell(entry) {
  const row = /** @type {Record<string, unknown>} */ (entry || {});
  return {
    costUsd: coerceFiniteNumber(row.costUsd),
    inputTokens: coerceFiniteNumber(row.inputTokens),
    cachedInputTokens: coerceFiniteNumber(row.cachedInputTokens),
    cacheWriteTokens: coerceFiniteNumber(row.cacheWriteTokens),
    outputTokens: coerceFiniteNumber(row.outputTokens),
    turns: coerceFiniteNumber(row.turns),
    wastedUsd: coerceFiniteNumber(row.wastedUsd),
  };
}

/**
 * Normalize usageByDay map and prune old buckets.
 * day -> provider -> model -> UsageCell
 * Malformed roots/entries are dropped; numbers are coerced.
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {Record<string, Record<string, Record<string, UsageCell>>>}
 */
function normalizeUsageByDay(raw, now = new Date()) {
  /** @type {Record<string, Record<string, Record<string, UsageCell>>>} */
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    pruneSpendByDay(map, now);
    return map;
  }
  for (const [day, providers] of Object.entries(raw)) {
    if (typeof day !== "string" || !providers || typeof providers !== "object" || Array.isArray(providers)) {
      continue;
    }
    /** @type {Record<string, Record<string, UsageCell>>} */
    const dayMap = {};
    for (const [provider, models] of Object.entries(providers)) {
      if (typeof provider !== "string" || !models || typeof models !== "object" || Array.isArray(models)) {
        continue;
      }
      /** @type {Record<string, UsageCell>} */
      const modelMap = {};
      for (const [model, entry] of Object.entries(models)) {
        if (typeof model !== "string" || !entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        modelMap[model] = coerceUsageCell(entry);
      }
      if (Object.keys(modelMap).length > 0) dayMap[provider] = modelMap;
    }
    if (Object.keys(dayMap).length > 0) map[day] = dayMap;
  }
  pruneSpendByDay(map, now);
  return map;
}

/**
 * Normalize the per-thread rollup and prune old buckets.
 * day -> threadId -> UsageThreadCell
 * @param {unknown} raw
 * @param {Date} [now]
 * @returns {Record<string, Record<string, UsageThreadCell>>}
 */
function normalizeUsageThreadsByDay(raw, now = new Date()) {
  /** @type {Record<string, Record<string, UsageThreadCell>>} */
  const map = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    pruneSpendByDay(map, now);
    return map;
  }
  for (const [day, threads] of Object.entries(raw)) {
    if (typeof day !== "string" || !threads || typeof threads !== "object" || Array.isArray(threads)) {
      continue;
    }
    /** @type {Record<string, UsageThreadCell>} */
    const dayMap = {};
    for (const [threadId, entry] of Object.entries(threads)) {
      if (typeof threadId !== "string" || !threadId || !entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const row = /** @type {Record<string, unknown>} */ (entry);
      dayMap[threadId] = {
        ...coerceUsageCell(entry),
        projectId: typeof row.projectId === "string" ? row.projectId : "",
        projectName: typeof row.projectName === "string" ? row.projectName : "",
        title: typeof row.title === "string" ? row.title : "",
        provider: typeof row.provider === "string" ? row.provider : "",
        model: typeof row.model === "string" ? row.model : "unknown",
      };
    }
    if (Object.keys(dayMap).length > 0) map[day] = dayMap;
  }
  pruneSpendByDay(map, now);
  return map;
}

/**
 * @param {unknown} id
 * @returns {string | null} path-safe filename stem, or null if the id cannot
 *   be persisted as a single path segment under messages/
 */
function encodeThreadFileId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length >= 200) {
    return null;
  }
  if (id === "." || id === "..") return null;
  let encoded;
  try {
    encoded = encodeURIComponent(id).replace(/[!'()*]/g, (c) =>
      "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
    );
  } catch {
    return null;
  }
  if (
    encoded === "." ||
    encoded === ".." ||
    encoded.includes("/") ||
    encoded.includes("\\") ||
    encoded.includes("\0") ||
    encoded.length + ".json".length > 255
  ) {
    return null;
  }
  return encoded;
}

/**
 * @param {unknown} fileId
 * @returns {string | null}
 */
function decodeThreadFileId(fileId) {
  if (typeof fileId !== "string" || !fileId) return null;
  try {
    const id = decodeURIComponent(fileId);
    return encodeThreadFileId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} id
 * @returns {id is string}
 */
function isSafeThreadId(id) {
  return encodeThreadFileId(id) != null;
}

module.exports = {
  SPEND_RETENTION_DAYS,
  capList,
  localDayKey,
  pruneSpendByDay,
  normalizeRunArtifactsByThread,
  normalizeSpendByDay,
  coerceFiniteNumber,
  emptyUsageCell,
  coerceUsageCell,
  normalizeUsageByDay,
  normalizeUsageThreadsByDay,
  encodeThreadFileId,
  decodeThreadFileId,
  isSafeThreadId,
};
