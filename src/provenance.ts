import type { ChatMessage, ToolCallInfo } from "./shared/ipc";

/**
 * Provenance tier labels on agent claims (issue #404).
 *
 * Every assistant message gets classified by where its content could have come
 * from: the repo (files read/edited in the turn, paths cited in the text),
 * shared memory (memory-server tool calls), or a GitHub issue/PR (`#404`
 * refs, `gh issue` commands). Those three tiers are addressable — a reviewer
 * can open the file, memory entry, or issue and check the claim.
 *
 * A substantive message with NO addressable source is the case the feature
 * exists for: it came from the model's prior knowledge, not from your repo,
 * and the transcript should say so. Short chatter ("On it, looking now") is
 * never tagged — it makes no claims worth auditing.
 */

export interface MessageProvenance {
  /** Repo paths the turn touched (Read/Edit/Grep/...) or the message cites. */
  repo: string[];
  /** Shared-memory tools the turn used (memory_search, memory_get, ...). */
  memory: string[];
  /** GitHub issue/PR refs ("#404") the message cites or the turn fetched. */
  issues: string[];
  /** True when at least one addressable source backs the message. */
  grounded: boolean;
}

/**
 * Minimum trimmed length before an ungrounded assistant message earns the
 * "model prior knowledge" tag. Below this a message is chatter, not a claim.
 */
export const PRIOR_MIN_CHARS = 240;

/** Cap per tier so a citation-heavy message cannot flood the strip. */
const MAX_REFS = 6;

const REPO_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookRead",
  "NotebookEdit",
]);

/** MCP names arrive both bare and prefixed (mcp__coder-memory__memory_get). */
const MEMORY_TOOL_RE =
  /(?:memory_(?:search|get|store|recent|bootstrap|feedback|supersede|delete|resolve|maintenance|distill)|session_(?:search|record))/i;

const GH_ISSUE_RE =
  /\bgh\s+(?:issue|pr)\b|github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\//i;
const GH_NUMBER_RE = /\bgh\s+(?:issue|pr)(?:\s+[a-z]+)*\s+(\d{1,7})\b/i;
const GIT_READ_RE = /\bgit\s+(?:show|log|diff|blame)\b/;

/** Backticked spans are where agents cite paths; prose mentions are too noisy. */
const BACKTICK_RE = /`([^`\n]{1,160})`/g;
const PATH_WITH_DIR_RE =
  /^(?:[\w@.-]+\/)+[\w.@+-]+\.[a-z0-9]{1,6}(?::\d+(?:-\d+)?)?$/i;
const BARE_FILE_RE =
  /^[\w.@+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|json|md|py|go|rs|java|rb|sh|yml|yaml|toml|html|sql)(?::\d+)?$/i;
const ISSUE_REF_RE = /(?<![\w#])#(\d{1,7})\b/g;

function pushcapped<T>(list: T[], value: T): void {
  if (list.length < MAX_REFS && !list.includes(value)) list.push(value);
}

/** Tool input is pretty-printed JSON truncated to ~2000 chars — parse can fail. */
function toolInputField(tool: ToolCallInfo, field: string): string | null {
  try {
    const parsed = JSON.parse(tool.input) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    const m = tool.input.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
    return m ? m[1] : null;
  }
}

function classifyTool(tool: ToolCallInfo, prov: MessageProvenance): void {
  if (MEMORY_TOOL_RE.test(tool.name)) {
    pushcapped(prov.memory, tool.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, ""));
    return;
  }
  if (REPO_TOOLS.has(tool.name)) {
    const p =
      toolInputField(tool, "file_path") ??
      toolInputField(tool, "path") ??
      toolInputField(tool, "pattern");
    pushcapped(prov.repo, p ?? tool.name);
    return;
  }
  if (tool.name === "Bash") {
    const cmd = toolInputField(tool, "command") ?? tool.input;
    if (GH_ISSUE_RE.test(cmd)) {
      const n = cmd.match(GH_NUMBER_RE);
      pushcapped(prov.issues, n ? `#${n[1]}` : "gh");
      return;
    }
    if (GIT_READ_RE.test(cmd)) pushcapped(prov.repo, "git");
    return;
  }
  if (tool.name === "WebFetch" || tool.name === "FetchURL") {
    const url = toolInputField(tool, "url") ?? "";
    if (GH_ISSUE_RE.test(url)) pushcapped(prov.issues, url);
  }
}

function classifyText(text: string, prov: MessageProvenance): void {
  for (const m of text.matchAll(BACKTICK_RE)) {
    const span = m[1].trim();
    if (PATH_WITH_DIR_RE.test(span) || BARE_FILE_RE.test(span)) {
      pushcapped(prov.repo, span);
    }
  }
  for (const m of text.matchAll(ISSUE_REF_RE)) {
    pushcapped(prov.issues, `#${m[1]}`);
  }
}

function emptyProvenance(): MessageProvenance {
  return { repo: [], memory: [], issues: [], grounded: false };
}

/**
 * Classify the assistant message at `index`. Grounding evidence comes from
 * the tool calls in its own turn (everything back to the previous user
 * message) plus the paths and issue refs the message itself cites.
 * Returns null for non-assistant messages.
 */
export function messageProvenance(
  messages: ChatMessage[],
  index: number,
): MessageProvenance | null {
  const message = messages[index];
  if (!message || message.role !== "assistant") return null;
  const prov = emptyProvenance();
  // Scan back to the previous user message, then classify chronologically so
  // chip tooltips read in the order the tools ran.
  const tools: ToolCallInfo[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i];
    if (prev.role === "user") break;
    if (prev.role !== "tool" || !prev.tool) continue;
    tools.push(prev.tool);
  }
  for (let i = tools.length - 1; i >= 0; i--) {
    classifyTool(tools[i], prov);
  }
  classifyText(message.text, prov);
  prov.grounded =
    prov.repo.length + prov.memory.length + prov.issues.length > 0;
  return prov;
}

/**
 * Whether the strip renders at all: always when grounded, otherwise only when
 * the message is long enough to carry auditable claims (the "model prior
 * knowledge" case).
 */
export function provenanceVisible(
  prov: MessageProvenance,
  text: string,
): boolean {
  return prov.grounded || text.trim().length >= PRIOR_MIN_CHARS;
}
