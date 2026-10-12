/**
 * Typed composer context chips (#1526). Stored on the draft; expanded at send.
 * Files stay `@path` text. Review comments stay their own list.
 */

/** Same cap as replyContext.REPLY_QUOTE_CAP — keep in sync. */
const QUOTE_CAP = 8_000;

export const CONTEXT_BODY_CAP = 8_000;
export const DIGEST_MESSAGES = 12;
export const DIGEST_TURN_CHARS = 1_200;
export const MENTION_EMPTY_CAP = 8;

export type ContextChipKind = "thread" | "pr" | "skill" | "terminal" | "quote";

interface ChipBase {
  id: string;
}

export interface ThreadChip extends ChipBase {
  kind: "thread";
  threadId: string;
  title: string;
}

export interface PrChip extends ChipBase {
  kind: "pr";
  number: number;
  title: string;
}

export interface SkillChip extends ChipBase {
  kind: "skill";
  name: string;
  description: string;
}

export interface TerminalChip extends ChipBase {
  kind: "terminal";
  text: string;
  command?: string;
  startLine?: number;
  endLine?: number;
}

export interface QuoteChip extends ChipBase {
  kind: "quote";
  messageId: string;
  threadId: string;
  text: string;
  comment: string;
  truncated?: boolean;
  sourceText?: string;
  quoteKind?: "message" | "selection";
}

export type ContextChip =
  | ThreadChip
  | PrChip
  | SkillChip
  | TerminalChip
  | QuoteChip;

export type MentionExtra =
  | { kind: "thread"; id: string; title: string }
  | { kind: "pr"; number: number; title: string }
  | { kind: "skill"; name: string; description: string };

export type PrDetailLoad =
  | { title: string; body: string; additions?: number; deletions?: number }
  | { error: string };

export type SkillBodyLoad = string | { error: string };

export interface ContextChipLoader {
  threadDigest?: (threadId: string) => Promise<string>;
  prDetail?: (number: number) => Promise<PrDetailLoad>;
  skillBody?: (name: string) => Promise<SkillBodyLoad>;
}

export function quoteChipAsReply(chip: QuoteChip): {
  messageId: string;
  threadId: string;
  text: string;
  kind?: "message" | "selection";
  sourceText?: string;
  truncated?: boolean;
} {
  return {
    messageId: chip.messageId,
    threadId: chip.threadId,
    text: chip.text,
    kind: chip.quoteKind,
    sourceText: chip.sourceText,
    truncated: chip.truncated,
  };
}

export function contextChipLabel(chip: ContextChip): string {
  if (chip.kind === "thread") return chip.title || chip.threadId;
  if (chip.kind === "pr") return `#${chip.number} ${chip.title}`.trim();
  if (chip.kind === "skill") return chip.name;
  if (chip.kind === "quote") {
    return chip.quoteKind === "selection" ? "Cite" : "Reply";
  }
  const cmd = chip.command?.trim();
  const range = terminalRange(chip);
  const lines = chip.text.split("\n").length;
  const tail = range ?? `${lines} line${lines === 1 ? "" : "s"}`;
  return cmd ? `term · ${cmd} · ${tail}` : `term · ${tail}`;
}

function terminalRange(chip: TerminalChip): string | null {
  if (chip.startLine == null) return null;
  if (chip.endLine != null && chip.endLine !== chip.startLine) {
    return `L${chip.startLine}-${chip.endLine}`;
  }
  return `L${chip.startLine}`;
}

function capBody(text: string): string {
  if (text.length <= CONTEXT_BODY_CAP) return text;
  return `${text.slice(0, CONTEXT_BODY_CAP)}\n[… truncated …]`;
}

/** Same shape as electron/ask.js formatThreadDigest. */
export function formatThreadDigest(
  messages: ReadonlyArray<{ role?: string; text?: string }>,
): string {
  const kept = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = String(m.text || "").trim();
    if (!text) continue;
    kept.push(m);
  }
  const slice = kept.slice(-DIGEST_MESSAGES);
  if (slice.length === 0) return "";
  const lines = ["[Conversation]"];
  for (const m of slice) {
    const who = m.role === "user" ? "User" : "Assistant";
    const text = String(m.text || "").trim().slice(0, DIGEST_TURN_CHARS);
    lines.push(`${who}: ${text}`);
  }
  return lines.join("\n");
}

function loadError(label: string, reason: string): string {
  return `Could not load ${label}: ${reason}`;
}

async function expandOne(
  chip: ContextChip,
  load?: ContextChipLoader,
): Promise<string> {
  const label = contextChipLabel(chip);
  if (chip.kind === "quote") {
    // Same block as wrapReplyContext; kept local so node tests need no resolver.
    const truncated = chip.truncated === true || chip.text.length > QUOTE_CAP;
    const body = truncated
      ? `${chip.text.slice(0, QUOTE_CAP)}\n[… quoted message truncated …]`
      : chip.text;
    const block = `<reply-context message="${chip.messageId}">\n${body}\n</reply-context>`;
    const note = chip.comment.trim();
    return note ? `${block}\n\n${note}` : block;
  }
  if (chip.kind === "terminal") {
    const range = terminalRange(chip);
    const head = ["Terminal", chip.command?.trim(), range].filter(Boolean).join(" ");
    return `${head}\n\n${capBody(chip.text)}`;
  }
  if (chip.kind === "thread") {
    if (!load?.threadDigest) return loadError(label, "unavailable");
    try {
      const digest = (await load.threadDigest(chip.threadId)).trim();
      if (!digest) return loadError(label, "empty");
      return `${label}\n\n${digest}`;
    } catch (err) {
      return loadError(label, err instanceof Error ? err.message : "failed");
    }
  }
  if (chip.kind === "pr") {
    if (!load?.prDetail) return loadError(label, "unavailable");
    try {
      const detail = await load.prDetail(chip.number);
      if ("error" in detail) return loadError(label, detail.error);
      const stat =
        detail.additions != null || detail.deletions != null
          ? `\n+${detail.additions ?? 0} / −${detail.deletions ?? 0}`
          : "";
      const body = capBody((detail.body || "").trim());
      return `${label}${stat}${body ? `\n\n${body}` : ""}`;
    } catch (err) {
      return loadError(label, err instanceof Error ? err.message : "failed");
    }
  }
  if (!load?.skillBody) return loadError(label, "unavailable");
  try {
    const body = await load.skillBody(chip.name);
    if (typeof body !== "string") return loadError(label, body.error);
    const text = capBody(body.trim());
    if (!text) return loadError(label, "empty");
    return `${label}\n\n${text}`;
  } catch (err) {
    return loadError(label, err instanceof Error ? err.message : "failed");
  }
}

export async function formatContextChipsPrompt(
  chips: ContextChip[],
  load?: ContextChipLoader,
): Promise<string> {
  if (!chips.length) return "";
  const blocks = [];
  for (const chip of chips) {
    const block = (await expandOne(chip, load)).trim();
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function parseContextChips(raw: unknown): ContextChip[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextChip[] = [];
  for (const row of raw) {
    const chip = parseOneChip(row);
    if (chip) out.push(chip);
  }
  return out;
}

function parseOneChip(row: unknown): ContextChip | null {
  if (!isRecord(row)) return null;
  const id = asString(row.id);
  if (!id) return null;
  const kind = row.kind;
  if (kind === "thread") {
    const threadId = asString(row.threadId);
    const title = asString(row.title);
    if (!threadId || title == null) return null;
    return { id, kind, threadId, title };
  }
  if (kind === "pr") {
    const number = row.number;
    const title = asString(row.title);
    if (typeof number !== "number" || !Number.isFinite(number) || title == null) {
      return null;
    }
    return { id, kind, number, title };
  }
  if (kind === "skill") {
    const name = asString(row.name);
    const description = asString(row.description);
    if (!name || description == null) return null;
    return { id, kind, name, description };
  }
  if (kind === "terminal") {
    const text = asString(row.text);
    if (text == null) return null;
    const chip: TerminalChip = { id, kind, text };
    const command = asString(row.command);
    if (command) chip.command = command;
    if (typeof row.startLine === "number") chip.startLine = row.startLine;
    if (typeof row.endLine === "number") chip.endLine = row.endLine;
    return chip;
  }
  if (kind === "quote") {
    const messageId = asString(row.messageId);
    const threadId = asString(row.threadId);
    const text = asString(row.text);
    if (!messageId || !threadId || text == null) return null;
    const chip: QuoteChip = {
      id,
      kind,
      messageId,
      threadId,
      text,
      comment: asString(row.comment) ?? "",
    };
    if (row.truncated === true) chip.truncated = true;
    const sourceText = asString(row.sourceText);
    if (sourceText != null) chip.sourceText = sourceText;
    if (row.quoteKind === "message" || row.quoteKind === "selection") {
      chip.quoteKind = row.quoteKind;
    }
    return chip;
  }
  return null;
}

export function filterMentionExtras(
  extras: MentionExtra[],
  query: string,
  emptyCap = MENTION_EMPTY_CAP,
): MentionExtra[] {
  const q = query.trim().toLowerCase();
  const matched = extras.filter((e) => mentionExtraHits(e, q));
  if (q) return matched;
  const seen: Record<string, number> = {};
  return matched.filter((e) => {
    const n = (seen[e.kind] ?? 0) + 1;
    seen[e.kind] = n;
    return n <= emptyCap;
  });
}

function mentionExtraHits(e: MentionExtra, q: string): boolean {
  if (!q) return true;
  if (e.kind === "thread") return e.title.toLowerCase().includes(q);
  if (e.kind === "pr") {
    return (
      e.title.toLowerCase().includes(q) ||
      String(e.number).includes(q) ||
      `pr#${e.number}`.includes(q)
    );
  }
  return (
    e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
  );
}
