import type {
  AttachmentInfo,
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
 * and there is a prompt to re-send (a user row, or an undeliverable
 * orchestration notice parked on the event), and no run is active.
 *
 * The anchor must be the LAST MESSAGE (not merely the last event). A stale
 * interrupt mid-transcript after a successful retry must not keep the button.
 *
 * Click re-sends retryTarget() via the same onStartRun path as Composer.
 * A failed or undeliverable machine-delivered notice is re-sent with
 * fromNotice: true (#951 / #955), not as a new human turn of lastUserMessage.
 * Classification is the persisted ChatMessage.fromNotice flag, not the
 * noticePrompt footer string. Writer-lock park/classify is #952 / #950 —
 * this helper only selects the prompt and turn class. If the last event
 * belongs to the current Build workflow, the click routes to
 * runs.retryWorkflowAgent on the first failed slot (#830 / #825). Hide
 * when that last run is this Build but no slot failed, so we do not start
 * a chat turn. A leftover workflow after a later chat turn still shows
 * Retry turn because run ids differ (#828).
 */

const INTERRUPT_MARKER = "Run interrupted";
const TITLE_MAX = 60;
const NOT_DELIVERED = /\n\nNot delivered:\s*/i;

export type RetryTarget = {
  text: string;
  fromNotice: boolean;
  attachments?: AttachmentInfo[];
};

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

/**
 * Prompt parked on an undeliverable orchestration event, or null.
 * Requires the persisted fromNotice flag (#955). Verify-fix
 * "Not delivered" events do not set it.
 */
export function undeliverableNoticePrompt(
  event: Pick<ChatMessage, "text" | "fromNotice">,
): string | null {
  if (!event.fromNotice) return null;
  const idx = event.text.search(NOT_DELIVERED);
  if (idx < 0) return null;
  const prompt = event.text.slice(0, idx).trim();
  return prompt || null;
}

/**
 * What Retry turn will re-send. Prefers a parked undeliverable notice on
 * the last event over lastUserMessage, so raising a cap retries the
 * worker-finished continue rather than the original human task (#951).
 * fromNotice comes from the stored flag, not noticePrompt footer text (#955).
 */
export function retryTarget(
  messages: readonly ChatMessage[],
): RetryTarget | null {
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  if (last && last.role === "event" && !last.thinking) {
    const parked = undeliverableNoticePrompt(last);
    if (parked) return { text: parked, fromNotice: true };
  }
  const lastUser = lastUserMessage(messages);
  if (!lastUser) return null;
  if (lastUser.fromNotice) {
    return {
      text: lastUser.text,
      fromNotice: true,
      attachments: lastUser.attachments,
    };
  }
  return {
    text: lastUser.text,
    fromNotice: false,
    attachments: lastUser.attachments,
  };
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
 * the affordance is absent (active run, no retryTarget, no eligible surface).
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
  const last = messages.length > 0 ? messages[messages.length - 1]! : null;
  if (!last || last.role !== "event" || last.thinking) return null;
  if (!retryTarget(messages)) return null;
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

/** Tooltip for the Retry control, naming a notice when that is what will run. */
export function retryActionTitle(target: RetryTarget): string {
  if (target.fromNotice) return "Retry: continue orchestrating";
  return retryButtonTitle(target.text);
}
