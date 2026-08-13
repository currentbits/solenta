"use strict";

const ACTIVITY_LIMIT = 100;

function isRealTime(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function workLogEndedAt(entry) {
  if (!entry || typeof entry !== "object") return null;
  const candidates = [
    entry.endedAt,
    entry.ended,
    entry.finishedAt,
    entry.completedAt,
  ];
  for (const value of candidates) {
    if (isRealTime(value)) return value;
  }
  return null;
}

function workLogKind(entry) {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry.kind ?? entry.status ?? entry.result;
  if (raw === "done" || raw === "failed") return raw;
  const label = String(entry.label ?? "").toLowerCase();
  if (/\berror\b|\bfail/.test(label)) return "failed";
  if (/\b(done|complete|finished|success)\b/.test(label)) return "done";
  return null;
}

function pushItem(items, thread, kind, at, suffix) {
  items.push({
    id: `${thread.id}:${kind}:${suffix}`,
    threadId: thread.id,
    projectId: thread.projectId,
    kind,
    at,
    threadTitle: thread.title,
  });
}

/**
 * Same semantics as src/activity.ts buildActivity.
 * @param {object[]} threads
 * @param {Record<string, object[] | undefined>} workLogByThread
 * @param {number} _nowMs
 * @returns {object[]}
 */
function buildActivity(threads, workLogByThread, _nowMs) {
  const items = [];
  const list = Array.isArray(threads) ? threads : [];
  const logs =
    workLogByThread && typeof workLogByThread === "object"
      ? workLogByThread
      : {};

  for (const thread of list) {
    if (!thread || thread.archived) continue;

    if (isRealTime(thread.createdAt)) {
      pushItem(items, thread, "created", thread.createdAt, "created");
    }

    if (isRealTime(thread.runStartedAt)) {
      pushItem(
        items,
        thread,
        "started",
        thread.runStartedAt,
        String(thread.runStartedAt),
      );
    }

    const entries = Array.isArray(logs[thread.id]) ? logs[thread.id] : [];
    let fromLog = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const at = workLogEndedAt(entry);
      if (at == null) continue;
      const kind = workLogKind(entry);
      if (kind !== "done" && kind !== "failed") continue;
      fromLog += 1;
      pushItem(items, thread, kind, at, entry.id != null ? entry.id : `log-${i}`);
    }

    if (
      fromLog === 0 &&
      (thread.status === "done" || thread.status === "failed") &&
      isRealTime(thread.updatedAt)
    ) {
      pushItem(items, thread, thread.status, thread.updatedAt, thread.status);
    }
  }

  items.sort((a, b) => (b.at !== a.at ? b.at - a.at : a.id < b.id ? -1 : 1));
  return items.slice(0, ACTIVITY_LIMIT);
}

module.exports = { ACTIVITY_LIMIT, buildActivity };
