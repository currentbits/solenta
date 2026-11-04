import { parseToolJson } from "./automationCard";
import type { ChatMessage } from "./shared/ipc";

/** coder-threads show_user result (#293): the pane an agent points at. */
export type ShowUserAction = {
  target: "diff" | "file" | "terminal";
  path: string | null;
  line: number | null;
  reason: string | null;
};

/** Bare, `mcp__coder-threads__show_user`, or Codex `coder-threads/show_user`. */
export function isShowUserMessage(message: ChatMessage): boolean {
  return (
    message.role === "tool" &&
    /(?:^|__|\/)show_user$/i.test(message.tool?.name ?? "")
  );
}

function pick(value: unknown): ShowUserAction | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const target = o.target;
  if (target !== "diff" && target !== "file" && target !== "terminal") {
    return null;
  }
  const path = typeof o.path === "string" && o.path ? o.path : null;
  if (target === "file" && !path) return null;
  return {
    target,
    path,
    line: typeof o.line === "number" && o.line > 0 ? o.line : null,
    reason: typeof o.reason === "string" && o.reason ? o.reason : null,
  };
}

export function parseShowUserResult(output: string): ShowUserAction | null {
  return parseToolJson(output, pick);
}

/** Card title: what the agent is pointing at. */
export function showUserLabel(action: ShowUserAction): string {
  if (action.target === "terminal") return "Terminal";
  if (action.target === "diff") {
    return action.path ? `Changes · ${action.path}` : "Changes";
  }
  return action.line ? `${action.path}:${action.line}` : (action.path ?? "");
}
