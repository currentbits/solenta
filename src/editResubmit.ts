import type { ChatMessage, ThreadStatus } from "./shared/ipc";

/**
 * Issue #254: edit-and-resubmit decisions (pure).
 *
 * A past user message is editable when no run is active. The backend rejects
 * a rewind mid-run anyway, so the affordance stays hidden then.
 *
 * Confirming calls threads.rewind (which starts nothing) then the ordinary
 * runs.start path with the edited text — rewind must not append it, or the
 * message lands twice.
 */

/** True when this bubble can open the edit-and-resubmit editor. */
export function isEditableUserMessage(
  message: Pick<ChatMessage, "role" | "fromThread">,
  status: ThreadStatus,
): boolean {
  return (
    message.role === "user" && status !== "working" && !message.fromThread
  );
}

/**
 * How many transcript rows a rewind at `messageId` would drop: that row and
 * every message after it. 0 when the id is not in the list.
 */
export function rewindDroppedCount(
  messages: readonly Pick<ChatMessage, "id">[],
  messageId: string,
): number {
  const at = messages.findIndex((m) => m.id === messageId);
  if (at < 0) return 0;
  return messages.length - at;
}

/** Confirm-dialog body: how much transcript the rewind will remove. */
export function rewindConfirmText(dropped: number): string {
  const n = Math.max(0, dropped);
  const noun = n === 1 ? "message" : "messages";
  return `This removes ${n} ${noun} from this thread (this one and everything after it) and resubmits the edited text.`;
}
