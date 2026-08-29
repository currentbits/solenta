import type { ChatMessage } from "./shared/ipc";

export const TRANSCRIPT_VIEW_MODES = ["summary", "normal", "verbose"] as const;
export type TranscriptViewMode = (typeof TRANSCRIPT_VIEW_MODES)[number];

export const TRANSCRIPT_VIEW_LABELS: Record<TranscriptViewMode, string> = {
  summary: "Summary",
  normal: "Normal",
  verbose: "Verbose",
};

export const TRANSCRIPT_VIEW_HINTS: Record<TranscriptViewMode, string> = {
  summary: "Replies plus one expandable tool line per turn",
  normal: "Tool cards stay collapsed to a one-line summary",
  verbose: "Every tool card shows its input and output",
};

const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "search",
  "read_file",
  "glob_file_search",
  "grep_search",
]);
const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "strreplace",
  "multiedit",
  "notebookedit",
  "applypatch",
]);
const COMMAND_TOOLS = new Set(["bash", "shell", "run_terminal_command"]);

export interface FocusTurnSummary {
  key: string;
  firstActivityId: string;
  activityIds: string[];
  label: string;
  live: boolean;
  runningToolName: string | null;
}

export function cycleTranscriptViewMode(
  mode: TranscriptViewMode,
): TranscriptViewMode {
  const i = TRANSCRIPT_VIEW_MODES.indexOf(mode);
  return TRANSCRIPT_VIEW_MODES[(i + 1) % TRANSCRIPT_VIEW_MODES.length]!;
}

export function isActivityMessage(message: ChatMessage): boolean {
  return message.role === "tool" || Boolean(message.thinking);
}

export function turnKey(messages: ChatMessage[], index: number): string {
  for (let i = index; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.id;
  }
  return "lead-in";
}

export function latestTurnKey(messages: ChatMessage[]): string | null {
  if (messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.id;
  }
  return "lead-in";
}

export function turnKeyForRun(
  messages: ChatMessage[],
  runId: string,
): string | null {
  const index = messages.findIndex((m) => m.runId === runId);
  if (index < 0) return null;
  return turnKey(messages, index);
}

function classifyTool(name: string): "read" | "command" | "write" | "other" {
  const n = name.toLowerCase();
  if (READ_TOOLS.has(n)) return "read";
  if (COMMAND_TOOLS.has(n)) return "command";
  if (WRITE_TOOLS.has(n)) return "write";
  return "other";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function summarizeActivity(messages: ChatMessage[]): string {
  const activity = messages.filter(isActivityMessage);
  if (activity.length === 0) return "";

  const tools = activity.filter((m) => m.role === "tool" && m.tool);
  if (tools.length === 0) {
    const times = activity.map((m) => m.createdAt);
    const span = Math.max(0, Math.max(...times) - Math.min(...times));
    const secs = Math.floor(span / 1000);
    if (secs < 1) return "Thought for <1s";
    return `Thought for ${secs}s`;
  }

  let reads = 0;
  let commands = 0;
  let writes = 0;
  let others = 0;
  let runningName: string | null = null;
  for (const m of tools) {
    const tool = m.tool!;
    const kind = classifyTool(tool.name);
    if (kind === "read") reads += 1;
    else if (kind === "command") commands += 1;
    else if (kind === "write") writes += 1;
    else others += 1;
    if (!tool.done) runningName = tool.name;
  }

  const parts: string[] = [];
  if (reads > 0) {
    parts.push(`Read ${reads} ${plural(reads, "file", "files")}`);
  }
  if (commands > 0) {
    parts.push(`Ran ${commands} ${plural(commands, "command", "commands")}`);
  }
  if (writes > 0) {
    parts.push(`Changed ${writes} ${plural(writes, "file", "files")}`);
  }
  if (others > 0) {
    const names = [
      ...new Set(
        tools
          .filter((m) => classifyTool(m.tool!.name) === "other")
          .map((m) => m.tool!.name),
      ),
    ];
    parts.push(
      others === 1 && names.length === 1 ? names[0]! : `${others} tools`,
    );
  }
  if (runningName) parts.push(`Running ${runningName}`);
  return parts.join(" · ");
}

export function mapFocusTurns(
  messages: ChatMessage[],
  opts: { liveTurnKey?: string | null } = {},
): FocusTurnSummary[] {
  const groups = new Map<string, ChatMessage[]>();
  const order: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (!isActivityMessage(message)) continue;
    const key = turnKey(messages, i);
    const list = groups.get(key);
    if (list) list.push(message);
    else {
      groups.set(key, [message]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const activity = groups.get(key)!;
    const running = [...activity]
      .reverse()
      .find((m) => m.tool && !m.tool.done);
    return {
      key,
      firstActivityId: activity[0]!.id,
      activityIds: activity.map((m) => m.id),
      label: summarizeActivity(activity),
      live: opts.liveTurnKey != null && opts.liveTurnKey === key,
      runningToolName: running?.tool?.name ?? null,
    };
  });
}
