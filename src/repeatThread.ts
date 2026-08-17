import type { ThreadDetail } from "./shared/ipc";

/**
 * Issue #285: the seed for "repeat this" on a finished thread. Everything an
 * automation needs is already on the thread, so this is a projection, not a
 * new stored entity.
 */
export interface RepeatDraft {
  threadId: string;
  projectId: string;
  name: string;
  prompt: string;
  provider: string;
  model: string | null;
}

/**
 * The first non-empty user message is the prompt that started the work; later
 * ones are follow-ups that only make sense mid-conversation.
 */
export function repeatDraftFromDetail(
  detail: ThreadDetail | null | undefined,
): RepeatDraft | null {
  if (!detail) return null;
  const first = detail.messages.find(
    (m) => m.role === "user" && m.text.trim() !== "",
  );
  if (!first) return null;
  return {
    threadId: detail.thread.id,
    projectId: detail.thread.projectId,
    name: detail.thread.title,
    prompt: first.text.trim(),
    provider: detail.thread.provider,
    model: detail.thread.model,
  };
}
