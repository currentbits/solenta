/**
 * Per-thread transcript bookmarks (issue #1217). Stable message IDs plus a
 * bounded excerpt/optional label. The agent never reads these.
 */
import type { ThreadMessagePin } from "./shared/ipc";
import {
  THREAD_MESSAGE_PINS_MAX,
  THREAD_MESSAGE_PIN_EXCERPT_MAX,
  THREAD_MESSAGE_PIN_LABEL_MAX,
} from "./shared/ipc";

export function excerptFromText(
  text: string,
  max = THREAD_MESSAGE_PIN_EXCERPT_MAX,
): string {
  const one = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (one.length <= max) return one;
  return one.slice(0, max).trimEnd();
}

function asFiniteMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Drop invalid rows, dedup by messageId, cap count and string lengths. */
export function normalizeMessagePins(raw: unknown): ThreadMessagePin[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ThreadMessagePin[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const messageId =
      typeof rec.messageId === "string" ? rec.messageId.trim() : "";
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    const excerpt = excerptFromText(
      typeof rec.excerpt === "string" ? rec.excerpt : "",
    );
    const labelRaw =
      typeof rec.label === "string" ? rec.label.trim() : "";
    const label = labelRaw.slice(0, THREAD_MESSAGE_PIN_LABEL_MAX);
    const pin: ThreadMessagePin = {
      messageId,
      excerpt,
      pinnedAt: asFiniteMs(rec.pinnedAt),
    };
    if (label) pin.label = label;
    out.push(pin);
    if (out.length >= THREAD_MESSAGE_PINS_MAX) break;
  }
  return out;
}

export function pinsOf(
  thread: { messagePins?: ThreadMessagePin[] | null } | null | undefined,
): ThreadMessagePin[] {
  return Array.isArray(thread?.messagePins) ? thread.messagePins : [];
}

export function pinDisplayText(pin: ThreadMessagePin): string {
  const label = pin.label?.trim();
  if (label) return label;
  if (pin.excerpt.trim()) return pin.excerpt;
  return "Pinned message";
}

export function isPinAvailable(
  pin: ThreadMessagePin,
  messageIds: ReadonlySet<string>,
): boolean {
  return messageIds.has(pin.messageId);
}

export function pinMessage(
  pins: ThreadMessagePin[],
  input: { messageId: string; text: string; at?: number },
): ThreadMessagePin[] {
  const messageId = String(input.messageId ?? "").trim();
  if (!messageId) return pins;
  const current = normalizeMessagePins(pins);
  if (current.some((p) => p.messageId === messageId)) return current;
  if (current.length >= THREAD_MESSAGE_PINS_MAX) return current;
  return current.concat({
    messageId,
    excerpt: excerptFromText(input.text),
    pinnedAt: asFiniteMs(input.at) || Date.now(),
  });
}

export function unpinMessage(
  pins: ThreadMessagePin[],
  messageId: string,
): ThreadMessagePin[] {
  const id = String(messageId ?? "").trim();
  if (!id) return normalizeMessagePins(pins);
  return normalizeMessagePins(pins).filter((p) => p.messageId !== id);
}

export function labelMessagePin(
  pins: ThreadMessagePin[],
  messageId: string,
  label: string,
): ThreadMessagePin[] {
  const id = String(messageId ?? "").trim();
  if (!id) return normalizeMessagePins(pins);
  const nextLabel = String(label ?? "")
    .trim()
    .slice(0, THREAD_MESSAGE_PIN_LABEL_MAX);
  return normalizeMessagePins(pins).map((p) => {
    if (p.messageId !== id) return p;
    const next = { ...p };
    if (!nextLabel) delete next.label;
    else next.label = nextLabel;
    return next;
  });
}
