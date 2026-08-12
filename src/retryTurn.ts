import type { ChatMessage, ThreadStatus } from "./shared/ipc";

/**
 * Round 48: Retry-turn affordance decisions (pure).
 *
 * Show "Retry turn" beside the last transcript message when it is an event
 * and either:
 *   - thread status is "failed", OR
 *   - that event text contains "Run interrupted"
 * and there is a user message to re-send, and no run is active.
 *
 * The anchor must be the LAST MESSAGE (not merely the last event). A stale
 * interrupt mid-transcript after a successful retry must not keep the button.
 *
 * Click re-sends the LAST user message via the same onStartRun path as Composer.
 */

const INTERRUPT_MARKER = "Run interrupted";
const TITLE_MAX = 60;

/** Last user message in transcript order (not first). */
export function lastUserMessage(
  messages: readonly ChatMessage[],
): ChatMessage | null {
  let last: ChatMessage | null = null;
  for (const m of messages) {
    if (m.role === "user") last = m;
  }
  return last;
}

/** Last event message in transcript order (any position). */
export function lastEventMessage(
  messages: readonly ChatMessage[],
): ChatMessage | null {
  let last: ChatMessage | null = null;
  for (const m of messages) {
    if (m.role === "event") last = m;
  }
  return last;
}

export function isInterruptEvent(text: string): boolean {
  return text.includes(INTERRUPT_MARKER);
}

/**
 * Id of the event card that should carry the Retry button, or null if
 * the affordance is absent (active run, no user text, no eligible surface).
 *
 * The anchor event MUST be the last message in the transcript. Anchoring on
 * "last event anywhere" leaves a stale "Run interrupted…" button after a
 * successful retry (status done, assistant reply after the interrupt).
 */
export function retryAnchorEventId(
  status: ThreadStatus,
  messages: readonly ChatMessage[],
): string | null {
  // Mid-retry: status is working while the interrupt event is still last —
  // hide the button so a double-send cannot fire.
  if (status === "working") return null;
  if (!lastUserMessage(messages)) return null;
  const last = messages.length > 0 ? messages[messages.length - 1]! : null;
  if (!last || last.role !== "event") return null;
  if (status === "failed" || isInterruptEvent(last.text)) {
    return last.id;
  }
  return null;
}

/** Tooltip / title: "Retry: " + first ~60 codepoints of the last user message. */
export function retryButtonTitle(userText: string): string {
  const trimmed = userText.trim();
  // Codepoint-safe (not UTF-16 code unit) so a surrogate pair is not split.
  const chars = Array.from(trimmed);
  const snippet =
    chars.length <= TITLE_MAX
      ? trimmed
      : `${chars.slice(0, TITLE_MAX).join("")}…`;
  return `Retry: ${snippet}`;
}
