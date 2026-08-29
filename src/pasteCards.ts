/**
 * Composer paste-cards (issue #381). Large pastes collapse into labeled
 * cards instead of flooding the textarea. T3-shaped: 120k hard cap, huge
 * pastes compress, collapse is the default but expandable and disable-able.
 */

export const PASTE_HARD_CAP = 120_000;
/** Collapse when the paste is at least this many characters. */
export const PASTE_CARD_CHARS = 400;
/** Or at least this many lines (a stack trace / log dump). */
export const PASTE_CARD_LINES = 8;
/** Keep this many leading characters when compressing a huge paste. */
export const PASTE_KEEP_HEAD = 80_000;
/** Keep this many trailing characters when compressing a huge paste. */
export const PASTE_KEEP_TAIL = 20_000;

export interface PasteCard {
  id: string;
  /** Original (or compressed) payload sent with the prompt. */
  text: string;
  lines: number;
  chars: number;
  /** True when the stored text is a compressed slice of a larger paste. */
  compressed: boolean;
  /** Characters dropped by compression; 0 when uncompressed. */
  omitted: number;
}

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

export function shouldCollapsePaste(text: string): boolean {
  if (text.length >= PASTE_CARD_CHARS) return true;
  return countLines(text) >= PASTE_CARD_LINES;
}

export function compressHugePaste(text: string): {
  text: string;
  compressed: boolean;
  omitted: number;
} {
  if (text.length <= PASTE_HARD_CAP) {
    return { text, compressed: false, omitted: 0 };
  }
  const omitted = text.length - PASTE_KEEP_HEAD - PASTE_KEEP_TAIL;
  const marker = `\n\n[… ${omitted.toLocaleString("en-US")} characters omitted …]\n\n`;
  return {
    text: text.slice(0, PASTE_KEEP_HEAD) + marker + text.slice(-PASTE_KEEP_TAIL),
    compressed: true,
    omitted,
  };
}

export function makePasteCard(text: string, now = Date.now()): PasteCard {
  const packed = compressHugePaste(text);
  return {
    id: `paste-${now}`,
    text: packed.text,
    lines: countLines(packed.text),
    chars: packed.text.length,
    compressed: packed.compressed,
    omitted: packed.omitted,
  };
}

export function pasteCardLabel(card: PasteCard): string {
  const unit = card.lines === 1 ? "line" : "lines";
  const base = `Pasted ${card.lines} ${unit}`;
  return card.compressed ? `${base} (compressed)` : base;
}

export function payloadChars(draft: string, cards: readonly PasteCard[]): number {
  let n = draft.length;
  for (const card of cards) n += card.text.length;
  return n;
}

export function formatOverflow(used: number, cap = PASTE_HARD_CAP): string {
  return `${used.toLocaleString("en-US")} / ${cap.toLocaleString("en-US")}`;
}

export function overflowWarn(used: number, cap = PASTE_HARD_CAP): boolean {
  return used >= cap * 0.85;
}

/**
 * Expand cards into fenced blocks ahead of the typed draft so the agent sees
 * labeled, bounded context rather than a blob in the textarea.
 */
export function composePastePrompt(
  draft: string,
  cards: readonly PasteCard[],
): string {
  if (cards.length === 0) return draft;
  const blocks = cards.map((card) => {
    const label = pasteCardLabel(card);
    return `<pasted-context label="${label}">\n${card.text}\n</pasted-context>`;
  });
  const head = blocks.join("\n\n");
  return draft.trim() ? `${head}\n\n${draft}` : head;
}
