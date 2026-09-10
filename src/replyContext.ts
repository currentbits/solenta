/**
 * Reply-as-context (issue #381) and cite-selection (#1218). Quote one agent
 * message — or a bounded snapshot of selected visible text — as context so
 * the next send is about that passage, not the whole transcript.
 */

export const REPLY_QUOTE_CAP = 8_000;
export const REPLY_EXCERPT_CHARS = 140;

export type ReplyKind = "message" | "selection";

export interface ReplyTarget {
  messageId: string;
  text: string;
  /** Thread that owns the source message; quotes stay on that draft. */
  threadId?: string;
  kind?: ReplyKind;
  truncated?: boolean;
  /** Full assistant body at capture time; mismatch or missing → unavailable. */
  sourceText?: string;
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
  opts?: { truncated?: boolean },
): string {
  const truncated = opts?.truncated === true || quoted.length > REPLY_QUOTE_CAP;
  const body = truncated
    ? `${quoted.slice(0, REPLY_QUOTE_CAP)}\n[… quoted message truncated …]`
    : quoted;
  const block = `<reply-context message="${messageId}">\n${body}\n</reply-context>`;
  return userPrompt.trim() ? `${block}\n\n${userPrompt}` : block;
}

export function makeReplyTarget(input: {
  messageId: string;
  threadId: string;
  text: string;
  kind: ReplyKind;
  sourceText: string;
}): ReplyTarget | null {
  if (!input.text.trim()) return null;
  const truncated = input.text.length > REPLY_QUOTE_CAP;
  return {
    messageId: input.messageId,
    threadId: input.threadId,
    text: truncated ? input.text.slice(0, REPLY_QUOTE_CAP) : input.text,
    kind: input.kind,
    truncated,
    sourceText: input.sourceText,
  };
}

export function replySourceUnavailable(
  target: ReplyTarget,
  message: { id: string; role: string; text: string } | null | undefined,
): boolean {
  if (!message || message.id !== target.messageId) return true;
  if (message.role !== "assistant") return true;
  if (target.sourceText != null && message.text !== target.sourceText) {
    return true;
  }
  return false;
}

/** True when both ends of the range sit inside `root` (not collapsed). */
export function selectionInside(
  root: Node,
  selection: Selection | null,
): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  const range = selection.getRangeAt(0);
  return (
    root.contains(range.startContainer) && root.contains(range.endContainer)
  );
}

/**
 * The `[data-cite-body]` that wholly contains the selection, or null when
 * the range is empty, spans cards, or includes chrome outside one body.
 */
export function citeBodyFromSelection(
  selection: Selection | null,
): Element | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  const body = el?.closest("[data-cite-body]") ?? null;
  if (!body || !selectionInside(body, selection)) return null;
  return body;
}

export function captureCiteFromSelection(input: {
  selection: Selection | null;
  messageId: string;
  threadId: string;
  sourceText: string;
  citeBody: Element;
}): ReplyTarget | null {
  if (!selectionInside(input.citeBody, input.selection)) return null;
  return makeReplyTarget({
    messageId: input.messageId,
    threadId: input.threadId,
    text: input.selection!.toString(),
    kind: "selection",
    sourceText: input.sourceText,
  });
}
