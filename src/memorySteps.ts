import type { ChatMessage } from "./shared/ipc";
import { formatRelativeAge } from "./format";

/**
 * Shared-memory tool calls rendered as "memory moments" (#1429 F5): a recall
 * shows how many entries came back and who wrote them; a store shows the
 * saved title. Parsing is best-effort: providers wrap MCP results
 * differently, so anything unreadable falls back to a count or a plain line.
 */

export interface MemoryRecall {
  title: string;
  agent: string | null;
  /** Compact age like "2d", or null when the result had no timestamp. */
  age: string | null;
}

export type MemoryStep =
  | { kind: "recall"; count: number | null; items: MemoryRecall[]; running: boolean }
  | { kind: "store"; title: string | null; running: boolean }
  | { kind: "other"; running: boolean };

const RECALL_OPS = new Set([
  "memory_search",
  "memory_get",
  "memory_recent",
  "memory_bootstrap",
]);

/** The memory op for a coder-memory tool name, or null for any other tool. */
export function memoryToolOp(name: string | undefined): string | null {
  if (!name || !/coder[-_]memory/i.test(name)) return null;
  const m = /((?:memory|session)_[a-z]+(?:_[a-z]+)*)$/i.exec(name);
  return m ? m[1]!.toLowerCase() : "memory";
}

export function isMemoryToolMessage(message: ChatMessage): boolean {
  return message.role === "tool" && memoryToolOp(message.tool?.name) != null;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every object carrying a string `title`, unwrapping MCP `{type:"text",text}` blocks. */
function collectEntries(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    const inner = tryJson(value);
    if (inner !== undefined) collectEntries(inner, out, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectEntries(v, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  if (typeof o.title === "string" && o.title) {
    out.push(o);
    return;
  }
  for (const v of Object.values(o)) collectEntries(v, out, depth + 1);
}

function ageOf(o: Record<string, unknown>, now: number): string | null {
  const raw = o.created_at ?? o.createdAt ?? o.updated_at ?? o.updatedAt;
  const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return null;
  const age = formatRelativeAge(ms, now);
  // "14d" reads long next to a title; weeks past a fortnight.
  const days = /^(\d+)d$/.exec(age);
  return days && Number(days[1]) >= 14 ? `${Math.floor(Number(days[1]) / 7)}w` : age;
}

export function parseMemoryStep(message: ChatMessage, now = Date.now()): MemoryStep | null {
  const op = memoryToolOp(message.tool?.name);
  if (!op || !message.tool) return null;
  const running = !message.tool.done;
  if (op === "memory_store") {
    const input = tryJson(message.tool.input) as { title?: unknown } | undefined;
    const title = typeof input?.title === "string" && input.title ? input.title : null;
    return { kind: "store", title, running };
  }
  if (!RECALL_OPS.has(op)) return { kind: "other", running };
  const output = message.tool.output ?? "";
  if (running || !output.trim() || message.tool.isError) {
    return { kind: "recall", count: null, items: [], running };
  }
  const found: Record<string, unknown>[] = [];
  const parsed = tryJson(output);
  if (parsed !== undefined) collectEntries(parsed, found);
  else {
    // Not JSON (a provider flattened it): count title keys at least.
    for (const m of output.matchAll(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      found.push({ title: m[1]! });
    }
  }
  const items = found.map((o) => ({
    title: String(o.title),
    agent: typeof o.agent === "string" && o.agent ? o.agent : null,
    age: ageOf(o, now),
  }));
  return { kind: "recall", count: items.length, items, running };
}

/** The one-line label minus the highlighted count (rendered separately). */
export function memoryStepText(step: MemoryStep): {
  before: string;
  mark: string | null;
  after: string;
} {
  if (step.kind === "store") {
    if (step.running) return { before: "Saving a memory…", mark: null, after: "" };
    return step.title
      ? { before: "Saved a memory: ", mark: null, after: step.title }
      : { before: "Saved a memory", mark: null, after: "" };
  }
  if (step.kind === "other") {
    return {
      before: step.running ? "Updating shared memory…" : "Updated shared memory",
      mark: null,
      after: "",
    };
  }
  if (step.running) return { before: "Searching shared memory…", mark: null, after: "" };
  if (!step.count) return { before: "Searched shared memory", mark: null, after: "" };
  return {
    before: "Recalled ",
    mark: `${step.count} ${step.count === 1 ? "memory" : "memories"}`,
    after: " from shared memory",
  };
}
