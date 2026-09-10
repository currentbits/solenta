"use strict";

/**
 * Per-thread transcript bookmarks (issue #1217). Mirror of src/messagePins.ts
 * + src/shared/ipc.ts caps. Keep the numbers in sync.
 */
const THREAD_MESSAGE_PINS_MAX = 20;
const THREAD_MESSAGE_PIN_EXCERPT_MAX = 120;
const THREAD_MESSAGE_PIN_LABEL_MAX = 80;

function excerptFromText(text, max = THREAD_MESSAGE_PIN_EXCERPT_MAX) {
  const one = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (one.length <= max) return one;
  return one.slice(0, max).trimEnd();
}

function asFiniteMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeMessagePins(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const messageId =
      typeof row.messageId === "string" ? row.messageId.trim() : "";
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    const excerpt = excerptFromText(
      typeof row.excerpt === "string" ? row.excerpt : "",
    );
    const labelRaw = typeof row.label === "string" ? row.label.trim() : "";
    const label = labelRaw.slice(0, THREAD_MESSAGE_PIN_LABEL_MAX);
    const pin = {
      messageId,
      excerpt,
      pinnedAt: asFiniteMs(row.pinnedAt),
    };
    if (label) pin.label = label;
    out.push(pin);
    if (out.length >= THREAD_MESSAGE_PINS_MAX) break;
  }
  return out;
}

module.exports = {
  THREAD_MESSAGE_PINS_MAX,
  THREAD_MESSAGE_PIN_EXCERPT_MAX,
  THREAD_MESSAGE_PIN_LABEL_MAX,
  excerptFromText,
  normalizeMessagePins,
};
