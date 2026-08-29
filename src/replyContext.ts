/**
 * Reply-as-context (issue #381). Quote one agent message as bounded context
 * so the next send is about that turn, not the whole transcript.
 */

export const REPLY_QUOTE_CAP = 8_000;
export const REPLY_EXCERPT_CHARS = 140;

export interface ReplyTarget {
  messageId: string;
  text: string;
}

export function excerptReply(
  text: string,
  max = REPLY_EXCERPT_CHARS,
): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

export function wrapReplyContext(
  quoted: string,
  userPrompt: string,
  messageId: string,
): string {
  const body =
    quoted.length > REPLY_QUOTE_CAP
      ? `${quoted.slice(0, REPLY_QUOTE_CAP)}\n[… quoted message truncated …]`
      : quoted;
  const block = `<reply-context message="${messageId}">\n${body}\n</reply-context>`;
  return userPrompt.trim() ? `${block}\n\n${userPrompt}` : block;
}
