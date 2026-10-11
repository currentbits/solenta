import type {
  AutomationPreset,
  AutomationTrigger,
  ChatMessage,
} from "./shared/ipc";
import { isTriggerEvent } from "./automations";

export type AutomationCreateResult = {
  id: string;
  name: string;
  preset?: AutomationPreset;
  hour?: number | null;
  nextRunAt?: number;
  trigger?: AutomationTrigger | null;
};

/** MCP names look like mcp__coder-threads__automation_create. */
export function isAutomationCreateName(name: string | undefined): boolean {
  if (!name) return false;
  return /(?:^|__)automation_create$/i.test(name);
}

export function isAutomationCreateMessage(message: ChatMessage): boolean {
  return message.role === "tool" && isAutomationCreateName(message.tool?.name);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asTrigger(raw: unknown): AutomationTrigger | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const event = typeof t.event === "string" ? t.event : "";
  if (!isTriggerEvent(event)) return null;
  const str = (v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    return s || null;
  };
  return {
    type: "github",
    event,
    branch: str(t.branch),
    label: str(t.label),
    conclusion:
      t.conclusion === "success" ||
      t.conclusion === "failure" ||
      t.conclusion === "cancelled" ||
      t.conclusion === "timed_out"
        ? t.conclusion
        : null,
  };
}

function asPreset(raw: unknown): AutomationPreset | undefined {
  return raw === "hourly" || raw === "daily" || raw === "weekly"
    ? raw
    : undefined;
}

function fromObject(value: unknown): AutomationCreateResult | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!id || !name) return null;
  const hour =
    typeof o.hour === "number" && Number.isInteger(o.hour) ? o.hour : null;
  const nextRunAt =
    typeof o.nextRunAt === "number" && Number.isFinite(o.nextRunAt)
      ? o.nextRunAt
      : undefined;
  return {
    id,
    name,
    preset: asPreset(o.preset),
    hour,
    nextRunAt,
    trigger: asTrigger(o.trigger),
  };
}

/** Best-effort parse of the MCP JSON result (providers wrap it). */
export function parseAutomationCreateResult(
  output: string,
): AutomationCreateResult | null {
  const parsed = tryJson(output);
  const direct = fromObject(parsed);
  if (direct) return direct;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (typeof o.text === "string") {
      const inner = fromObject(tryJson(o.text));
      if (inner) return inner;
    }
    if (Array.isArray(o.content)) {
      for (const block of o.content) {
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          const inner = fromObject(tryJson((block as { text: string }).text));
          if (inner) return inner;
        }
      }
    }
  }
  return null;
}
