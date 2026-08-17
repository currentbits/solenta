"use strict";

const { createHash } = require("node:crypto");

// Agent turns think for minutes (runner.js: 48s to first token on a large
// resume) and implement for tens of minutes. One hour without a terminal
// event is past a healthy run and the same order as walking away from an
// approval prompt.
const STALL_AFTER_MS = 60 * 60 * 1000;

// ponytail: hard caps so a pathological store cannot flood the view.
const MAX_MODES = 20;
const MAX_OFFENDERS = 20;
const MAX_SIGNATURE = 160;
const MAX_SAMPLE = 300;

function isFiniteMs(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function asText(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isErrorEventText(text) {
  const s = asText(text).trim();
  return (
    /^(run error|run failed|run stuck|run interrupted)\b/i.test(s) ||
    /\bnot delivered:/i.test(s)
  );
}

/** Head of the diagnostic, not the runner wrapper or a stack. */
function extractErrorHead(raw) {
  const text = asText(raw).trim();
  if (!text) return "";
  const delivered = text.match(/Not delivered:\s*([\s\S]+)/i);
  if (delivered) return delivered[1].split(/\r?\n/, 1)[0].trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && /^run error\b/i.test(lines[0]) && /:$/.test(lines[0])) {
    return lines[1];
  }
  const first = lines[0] || "";
  const cut = first.search(/(?<=\S[.!?])\s+\S/);
  return cut === -1 ? first : first.slice(0, cut).trim();
}

function normalizeSignature(raw) {
  let s = extractErrorHead(raw);
  if (!s) return "";
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>");
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/gi, "<dur>");
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|KiB|MiB|GiB|bytes?)\b/gi, "<bytes>");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>");
  s = s.replace(/\b[0-9a-f]{7,}\b/gi, "<id>");
  s = s.replace(/\b\d{5,}\b/g, "<id>");
  s = s.replace(/\bpid[:\s]+\d+\b/gi, "pid <id>");
  s = s.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>");
  s = s.replace(/(?:file:\/\/)?(?:[A-Za-z]:)?(?:\/|\\)[^\s:'"]+/g, "<path>");
  s = s.replace(/\b(?:\.\.\/|\.\/)[^\s:'"]+/g, "<path>");
  s = s.replace(/\b[\w.-]+(?:\/[\w.-]+)+/g, "<path>");
  // Keep HTTP 1xx-5xx: 404 vs 500 is two modes. Exit codes collapse (1/2/130).
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, (token) => {
    const n = Number(token);
    return /^\d{3}$/.test(token) && n >= 100 && n <= 599 ? token : "<n>";
  });
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_SIGNATURE ? s.slice(0, MAX_SIGNATURE).trimEnd() : s;
}

function isMeaningfulSignature(signature) {
  if (!signature) return false;
  return signature.replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= 2;
}

function strField(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function collectFromThread(thread, messages, nowMs) {
  const threadId = strField(thread.id, "");
  if (!threadId) return [];
  const base = {
    threadId,
    threadTitle: strField(thread.title, threadId),
    projectId: strField(thread.projectId, ""),
    provider: strField(thread.provider, ""),
  };
  const hits = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const msg of list) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "event" || !isErrorEventText(msg.text)) continue;
    hits.push({ raw: asText(msg.text), at: isFiniteMs(msg.createdAt) ? msg.createdAt : 0, kindHint: "failed" });
  }
  if (hits.length === 0 && thread.status === "failed") {
    const lastError = asText(thread.lastError).trim();
    if (lastError) {
      hits.push({ raw: lastError, at: isFiniteMs(thread.updatedAt) ? thread.updatedAt : 0, kindHint: "failed" });
    } else {
      for (let i = list.length - 1; i >= 0; i--) {
        const msg = list[i];
        if (!msg || msg.role !== "assistant") continue;
        const text = asText(msg.text).trim();
        if (!text) continue;
        hits.push({ raw: text, at: isFiniteMs(msg.createdAt) ? msg.createdAt : 0, kindHint: "failed" });
        break;
      }
    }
  }
  const awaiting = thread.awaitingInput === true;
  const working = thread.status === "working";
  if (awaiting || working) {
    let lastMsgAt = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && isFiniteMs(list[i].createdAt)) { lastMsgAt = list[i].createdAt; break; }
    }
    const awaitSince = lastMsgAt ?? (isFiniteMs(thread.updatedAt) ? thread.updatedAt : null) ??
      (isFiniteMs(thread.runStartedAt) ? thread.runStartedAt : null);
    if (awaiting && isFiniteMs(awaitSince) && nowMs - awaitSince >= STALL_AFTER_MS) {
      hits.push({ raw: "stalled: awaiting input", at: awaitSince, kindHint: "stalled" });
    } else if (working && isFiniteMs(thread.runStartedAt) && nowMs - thread.runStartedAt >= STALL_AFTER_MS) {
      hits.push({ raw: "stalled: working with no terminal event", at: thread.runStartedAt, kindHint: "stalled" });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const seen = new Map();
  return hits.map((hit) => {
    const signature = normalizeSignature(hit.raw);
    const prev = seen.get(signature) || 0;
    seen.set(signature, prev + 1);
    const kind = hit.kindHint === "stalled" ? "stalled" : prev > 0 ? "retried" : "failed";
    return { ...base, raw: hit.raw, at: hit.at, kind, signature };
  });
}

/**
 * Failure-mode clustering across threads (issue #280).
 *
 * Reads the event log already on disk and groups offending threads by a
 * NORMALIZED error signature, so "spawn claude ENOENT" in six threads reads
 * as one recurring mode with six offenders instead of six separate failures.
 *
 * ponytail: exact signature match, add token-similarity grouping if
 * signatures prove too literal. No LLM and no embeddings. Deterministic,
 * runs in milliseconds on the whole store, and every cluster is explainable
 * by the signature itself.
 *
 * @param {object} input
 * @param {Array<object>} input.threads
 * @param {Record<string, Array<object> | undefined>} input.messagesByThread
 * @param {number} [input.nowMs]
 * @returns {Array<{ id: string, signature: string, sample: string, count: number, offenders: Array<{ threadId: string, threadTitle: string, projectId: string, provider: string, kind: "failed" | "stalled" | "retried", at: number }>, lastAt: number }>}
 */
function clusterFailureModes(input) {
  try {
    const src = input && typeof input === "object" ? input : {};
    const threads = Array.isArray(src.threads) ? src.threads : [];
    const messagesByThread = src.messagesByThread && typeof src.messagesByThread === "object" ? src.messagesByThread : {};
    const nowMs = isFiniteMs(src.nowMs) ? src.nowMs : Date.now();
    const groups = new Map();

    for (const thread of threads) {
      if (!thread || typeof thread !== "object") continue;
      let rows;
      try {
        rows = collectFromThread(thread, messagesByThread[thread.id], nowMs);
      } catch {
        continue;
      }
      for (const row of rows) {
        // collectFromThread already normalized it to spot repeats within
        // the thread ("retried"); re-deriving it here would be the same work.
        const signature = row.signature;
        if (!isMeaningfulSignature(signature)) continue;
        let group = groups.get(signature);
        const sample = asText(row.raw).trim().slice(0, MAX_SAMPLE);
        if (!group) {
          group = { signature, sample, sampleAt: row.at, offenders: [] };
          groups.set(signature, group);
        } else if (row.at < group.sampleAt) {
          group.sample = sample;
          group.sampleAt = row.at;
        }
        group.offenders.push({
          threadId: row.threadId,
          threadTitle: row.threadTitle,
          projectId: row.projectId,
          provider: row.provider,
          kind: row.kind,
          at: row.at,
        });
      }
    }

    const modes = [];
    for (const group of groups.values()) {
      if (group.offenders.length < 2) continue;
      group.offenders.sort((a, b) => (b.at !== a.at ? b.at - a.at : a.threadId < b.threadId ? -1 : 1));
      modes.push({
        id: createHash("sha256").update(group.signature).digest("hex").slice(0, 12),
        signature: group.signature,
        sample: group.sample,
        count: group.offenders.length,
        offenders: group.offenders.slice(0, MAX_OFFENDERS),
        lastAt: group.offenders[0].at,
      });
    }
    modes.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
      return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
    });
    return modes.slice(0, MAX_MODES);
  } catch {
    return [];
  }
}

module.exports = { clusterFailureModes, STALL_AFTER_MS };
