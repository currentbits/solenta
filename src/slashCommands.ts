/**
 * Composer `/` palette (issue #472).
 *
 * Orchestration verbs stay insert-only: the runner intercepts the sent text
 * (#338). `/btw` stays insert-only so the send path can intercept it as a
 * side question (#471) without occupying the live turn, and `/feedback` the
 * same way so the text reaches us and not the model (#681). CLI verbs that map
 * to existing UI run immediately and never reach the model. Unknown `/foo`
 * is not in this list, so a send still goes through.
 */

/** Immediate actions the palette can fire. Insert verbs have no action. */
export type SlashAction =
  | "compact"
  | "rewind"
  | "usage"
  | "context"
  | "model"
  | "effort"
  | "permissions"
  | "fork"
  | "new"
  | "clear"
  | "review";

export interface SlashCommand {
  name: string;
  hint: string;
  /**
   * insert — put `/name ` in the draft (needs a tail, or a later interceptor).
   * run — fire `action` and clear the token.
   */
  kind: "insert" | "run";
  action?: SlashAction;
}

/**
 * Single palette, issue-table order. `/undo` is an alias of `/rewind`.
 * `/usage` shows provider account quotas; `/context` opens the thread
 * context ring. Both stay listed so muscle memory still finds them.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "/compact",
    hint: "Fork to fresh context with recent history",
    kind: "run",
    action: "compact",
  },
  {
    name: "/rewind",
    hint: "Rewind the last turn",
    kind: "run",
    action: "rewind",
  },
  {
    name: "/review",
    hint: "Open the review itinerary for this diff",
    kind: "run",
    action: "review",
  },
  {
    name: "/undo",
    hint: "Undo the last turn",
    kind: "run",
    action: "rewind",
  },
  {
    name: "/usage",
    hint: "Show provider usage limits",
    kind: "run",
    action: "usage",
  },
  {
    name: "/context",
    hint: "Open the context breakdown",
    kind: "run",
    action: "context",
  },
  {
    name: "/model",
    hint: "Pick provider and model",
    kind: "run",
    action: "model",
  },
  {
    name: "/effort",
    hint: "Set reasoning effort",
    kind: "run",
    action: "effort",
  },
  {
    name: "/permissions",
    hint: "Set permission mode",
    kind: "run",
    action: "permissions",
  },
  {
    name: "/goal",
    hint: "Set a persistent thread goal",
    kind: "insert",
  },
  {
    name: "/fork",
    hint: "Fork this thread onto a fresh session",
    kind: "run",
    action: "fork",
  },
  {
    name: "/new",
    hint: "Start a new thread",
    kind: "run",
    action: "new",
  },
  {
    name: "/handoff",
    hint: "Plan here, implement on a fresh model",
    kind: "insert",
  },
  {
    name: "/advisor",
    hint: "One second opinion on a contrasting model",
    kind: "insert",
  },
  {
    name: "/committee",
    hint: "Two contrasting models converge on a root cause",
    kind: "insert",
  },
  {
    name: "/btw",
    hint: "Ask a side question without interrupting",
    kind: "insert",
  },
  {
    name: "/clear",
    hint: "Settle this thread and start a new draft",
    kind: "run",
    action: "clear",
  },
  {
    name: "/feedback",
    hint: "Send feedback to the Solenta team",
    kind: "insert",
  },
];

/**
 * The `/` token being typed, or null. Only at the very start of the draft,
 * and only while it is still one token — the first space ends the command
 * and everything after it belongs to the task.
 */
export function commandQuery(text: string): string | null {
  return text.startsWith("/") && !/\s/.test(text) ? text : null;
}

/**
 * Commands whose name starts with the live token. `extras` are CLI skills
 * and custom commands (#606); a name Solenta already owns stays ours.
 */
export function matchSlashCommands(
  query: string,
  extras: readonly SlashCommand[] = [],
): SlashCommand[] {
  const reserved = new Set(SLASH_COMMANDS.map((c) => c.name));
  const extra = extras.filter((c) => !reserved.has(c.name));
  return [...SLASH_COMMANDS, ...extra].filter((c) => c.name.startsWith(query));
}
