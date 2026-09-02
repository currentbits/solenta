import type {
  ChatMessage,
  ThreadStatus,
  WorkflowView,
} from "./shared/ipc";

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
 * Click re-sends the LAST user message via the same onStartRun path as Composer,
 * unless the last event belongs to the current Build workflow: then the click
 * routes to runs.retryWorkflowAgent on the first failed slot (#830 / #825).
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

/** True when the last transcript message is this Build's run (public view id). */
export function isWorkflowLastRun(
  messages: readonly ChatMessage[],
  workflow?: { id: string } | null,
): boolean {
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  return Boolean(workflow && last?.runId && last.runId === workflow.id);
}

/**
 * First failed phase agent in Agents-panel order (phases, then agents).
 * Same eligibility as the per-slot Retry: failed agent, thread not working.
 */
export function failedWorkflowRetryAgentId(
  workflow: WorkflowView | null | undefined,
  status: ThreadStatus,
): string | null {
  if (!workflow || status === "working") return null;
  for (const phase of workflow.phases) {
    for (const agent of phase.agents) {
      if (agent.status === "failed") return agent.id;
    }
  }
  return null;
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
  workflow?: WorkflowView | null,
): string | null {
  // Mid-retry: status is working while the interrupt event is still last —
  // hide the button so a double-send cannot fire.
  if (status === "working") return null;
  if (!lastUserMessage(messages)) return null;
  const last = messages.length > 0 ? messages[messages.length - 1]! : null;
  if (!last || last.role !== "event" || last.thinking) return null;
  // Last run was this Build: only offer Retry turn when a failed slot
  // exists to route to. No slot → hide so we do not start a chat turn.
  if (
    isWorkflowLastRun(messages, workflow) &&
    !failedWorkflowRetryAgentId(workflow, status)
  ) {
    return null;
  }
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
