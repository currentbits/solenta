import type { ChatMessage } from "./shared/ipc";

/**
 * Estimated split of a measured prompt. The provider's contextTokens figure
 * is the truth; these segments only guess how it breaks down. Tokens are
 * chars/4 (no tokenizer). Memory and code-map are injected by the runner and
 * never appear as ChatMessages, so they land in the remainder rather than
 * a fake named slice.
 */
export interface ContextBreakdownSegment {
  key: "tools" | "transcript" | "system";
  label: string;
  tokens: number;
  /** tokens / measured, 0..1. */
  fraction: number;
}

/** ponytail: chars/4, not a tokenizer. */
function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

export function contextBreakdown(input: {
  messages: readonly ChatMessage[];
  measured: number;
}): ContextBreakdownSegment[] {
  const { messages, measured } = input;
  if (!(measured > 0) || !Number.isFinite(measured)) return [];

  let tools = 0;
  let transcript = 0;
  for (const m of messages) {
    if (m.role === "tool") {
      const t = m.tool;
      if (!t) continue;
      tools += estimateTokens(t.input);
      if (t.output) tools += estimateTokens(t.output);
    } else if (m.role === "user" || m.role === "assistant") {
      transcript += estimateTokens(m.text);
    }
  }

  const segs: {
    key: ContextBreakdownSegment["key"];
    label: string;
    tokens: number;
  }[] = [
    { key: "tools", label: "Tool output", tokens: tools },
    { key: "transcript", label: "Transcript", tokens: transcript },
  ];

  const attributed = tools + transcript;
  if (attributed > measured) {
    for (const seg of segs) {
      seg.tokens = Math.floor((seg.tokens * measured) / attributed);
    }
    // Floor leftover goes to the largest slice so the sum never exceeds
    // measured and we don't invent a tiny "system" sliver from rounding.
    let used = 0;
    for (const seg of segs) used += seg.tokens;
    let leftover = measured - used;
    if (leftover > 0) {
      let best = segs[0];
      for (const seg of segs) {
        if (seg.tokens > best.tokens) best = seg;
      }
      best.tokens += leftover;
    }
  } else {
    const rest = measured - attributed;
    if (rest > 0) {
      segs.push({
        key: "system",
        label: "System prompt + tool defs",
        tokens: rest,
      });
    }
  }

  return segs
    .filter((s) => s.tokens > 0)
    .map((s) => ({ ...s, fraction: s.tokens / measured }));
}
