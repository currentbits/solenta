import type { ChatMessage, ThreadDetail } from "./shared/ipc";

/** Conversation text, excluding tool payloads, reasoning, and status events. */
export function conversationMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter(m => (m.role === "user" || m.role === "assistant") && !m.thinking);
}

export function conversationMarkdown(detail: ThreadDetail): string {
  const sections = conversationMessages(detail.messages).map(m => {
    const role = m.role === "assistant" ? "Assistant" : m.fromThread ? "From another thread" : m.fromNotice ? "Automatic follow-up" : "You";
    const attachments = m.attachments?.map(a => `- ${a.name}`).join("\n");
    return `## ${role}\n\n${m.text}${attachments ? `\n\nAttachments:\n${attachments}` : ""}`;
  });
  return [`# ${detail.thread.title.replace(/\s+/g, " ")}`, ...sections].join("\n\n");
}
