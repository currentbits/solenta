import type { ChatMessage, ThreadStatus } from "./shared/ipc";

/**
 * Round 48: Retry-turn affordance decisions (pure).
 *
 * Show "Retry turn" beside the last event surface when:
 *   - thread status is "failed", OR
 *   - the last event text contains "Run interrupted"
 * and there is a user message to re-send, and no run is active.
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

/** Last event message in transcript order. */
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
 */
export function retryAnchorEventId(
  status: ThreadStatus,
  messages: readonly ChatMessage[],
): string | null {
  if (status === "working") return null;
  if (!lastUserMessage(messages)) return null;
  const event = lastEventMessage(messages);
  if (!event) return null;
  if (status === "failed" || isInterruptEvent(event.text)) {
    return event.id;
  }
  return null;
}

/** Tooltip / title: "Retry: " + first ~60 chars of the last user message. */
export function retryButtonTitle(userText: string): string {
  const trimmed = userText.trim();
  const snippet =
    trimmed.length <= TITLE_MAX
      ? trimmed
      : `${trimmed.slice(0, TITLE_MAX)}…`;
  return `Retry: ${snippet}`;
}
