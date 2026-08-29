import type { ChatMessage } from "./shared/ipc";
import type { TimelineEntry } from "./timeline";

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "other";

export type ToolGroup = {
  id: string;
  runId: string | null;
  messages: ChatMessage[];
  hasError: boolean;
};

export type DisplayEntry =
  | { kind: "message"; message: ChatMessage; timestamp: number }
  | { kind: "group"; group: ToolGroup; timestamp: number }
  | Extract<TimelineEntry, { kind: "artifacts" }>;

export function isGroupable(message: ChatMessage): boolean {
  return message.role === "tool" || message.thinking === true;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

export function toolAction(name: string): ToolGroupAction {
  const n = normalizeName(name);
  if (n === "read" || n === "readfile" || n === "imageview") return "read";
  if (n === "edit" || n === "write" || n === "strreplace" || n === "filechange") {
    return "edit";
  }
  if (
    n === "bash" ||
    n === "shell" ||
    n === "command" ||
    n === "runterminalcommand" ||
    n === "commandexecution"
  ) {
    return "command";
  }
  if (n === "grep" || n === "glob" || n === "ripgrep") return "code-search";
  if (n === "websearch" || n === "webfetch") return "search";
  return "other";
}

function actionLabel(action: ToolGroupAction, count: number): string {
  const n = count;
  switch (action) {
    case "read":
      return `Read ${n} ${n === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${n} ${n === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${n} ${n === 1 ? "command" : "commands"}`;
    case "code-search":
      return `Searched code ${n} ${n === 1 ? "time" : "times"}`;
    case "search":
      return `Searched the web ${n} ${n === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${n} ${n === 1 ? "tool" : "tools"}`;
  }
}

function lowerFirst(label: string): string {
  return label.length === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

export function summarizeToolGroup(messages: ChatMessage[]): string {
  const counts = new Map<ToolGroupAction, number>();
  const order: ToolGroupAction[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const action = toolAction(message.tool?.name ?? "tool");
    if (!counts.has(action)) order.push(action);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const labels = order.map((action) => actionLabel(action, counts.get(action) ?? 0));
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${lowerFirst(labels[1]!)}`;
  return `${labels
    .slice(0, -1)
    .map((label, i) => (i === 0 ? label : lowerFirst(label)))
    .join(", ")}, and ${lowerFirst(labels.at(-1)!)}`;
}

function firstTokenAfterColon(text: string): string | null {
  const idx = text.indexOf(": ");
  if (idx < 0) return null;
  const token = text.slice(idx + 2).trim().split(/\s+/)[0];
  return token || null;
}

export function liveGroupLabel(messages: ChatMessage[]): string | null {
  const inProgress = [...messages]
    .reverse()
    .find((m) => m.role === "tool" && m.tool && !m.tool.done);
  if (inProgress) {
    const label =
      firstTokenAfterColon(inProgress.text) ?? inProgress.tool?.name ?? "tool";
    return `Running ${label}`;
  }
  const tools = messages.filter((m) => m.role === "tool");
  if (tools.length === 0 && messages.some((m) => m.thinking)) return "Thinking";
  return null;
}

function sameRun(a: ChatMessage, b: ChatMessage): boolean {
  if (a.runId == null || b.runId == null) return false;
  return a.runId === b.runId;
}

function makeGroup(messages: ChatMessage[]): ToolGroup {
  const first = messages[0]!;
  return {
    id: `${first.runId ?? "norun"}:${first.id}`,
    runId: first.runId ?? null,
    messages,
    hasError: messages.some((m) => m.tool?.isError === true),
  };
}

function groupHasTools(group: ToolGroup): boolean {
  return group.messages.some((m) => m.role === "tool");
}

export function collapseTimeline(
  entries: TimelineEntry[],
  opts: { working: boolean },
): DisplayEntry[] {
  const raw: DisplayEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.kind === "worklog") continue;
    if (entry.kind === "artifacts") {
      raw.push(entry);
      continue;
    }
    if (!isGroupable(entry.message)) {
      raw.push({
        kind: "message",
        message: entry.message,
        timestamp: entry.timestamp,
      });
      continue;
    }
    const messages = [entry.message];
    let j = i + 1;
    while (j < entries.length) {
      const next = entries[j]!;
      if (next.kind !== "message" || !isGroupable(next.message)) break;
      if (!sameRun(messages[0]!, next.message)) break;
      messages.push(next.message);
      j += 1;
    }
    raw.push({
      kind: "group",
      group: makeGroup(messages),
      timestamp: entry.timestamp,
    });
    i = j - 1;
  }

  let latestGroupIndex = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]!.kind === "group") latestGroupIndex = i;
  }

  return raw.filter((row, index) => {
    if (row.kind !== "group") return true;
    if (groupHasTools(row.group)) return true;
    return opts.working && index === latestGroupIndex;
  });
}
