import type {
  AutomationPreset,
  AutomationTrigger,
  AutomationTriggerEvent,
  ThreadStatus,
} from "./shared/ipc";

export const TRIGGER_EVENT_LABELS: Record<AutomationTriggerEvent, string> = {
  pr_opened: "PR opened",
  pr_merged: "PR merged",
  pr_labeled: "Label added",
  review_submitted: "Review submitted",
  push: "Push",
  ci_completed: "CI completed",
  linear_issue_created: "Linear issue created",
  linear_status_changed: "Linear status changed",
  sentry_issue: "Sentry issue",
};

export function isTriggerEvent(value: string): value is AutomationTriggerEvent {
  return Object.prototype.hasOwnProperty.call(TRIGGER_EVENT_LABELS, value);
}

export function triggerLabel(trigger: AutomationTrigger): string {
  let label = `on ${TRIGGER_EVENT_LABELS[trigger.event]}`;
  if (trigger.event === "linear_issue_created" && trigger.team) {
    return `${label} in ${trigger.team}`;
  }
  if (trigger.event === "linear_status_changed") {
    if (trigger.status) label += ` to ${trigger.status}`;
    if (trigger.team) label += ` in ${trigger.team}`;
    return label;
  }
  if (trigger.event === "sentry_issue" && trigger.org && trigger.project) {
    label += ` ${trigger.org}/${trigger.project}`;
    if (trigger.environment) label += ` (${trigger.environment})`;
    return label;
  }
  if (trigger.label) label += ` "${trigger.label}"`;
  if (trigger.conclusion) label += ` (${trigger.conclusion})`;
  if (trigger.branch) label += ` on ${trigger.branch}`;
  return label;
}

export type AutomationRunDisplayStatus =
  | "working"
  | "failed"
  | "paused"
  | "completed";

/** Map actual thread status for the automation run list (issue #938). */
export function automationRunDisplayStatus(
  status: ThreadStatus,
): AutomationRunDisplayStatus {
  if (status === "working") return "working";
  if (status === "failed") return "failed";
  if (status === "quota-wait") return "paused";
  return "completed";
}

export function automationRunStatusLabel(status: ThreadStatus): string {
  const display = automationRunDisplayStatus(status);
  if (display === "working") return "Working";
  if (display === "failed") return "Failed";
  if (display === "paused") return "Paused";
  return "Completed";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatHourLabel(hour: number): string {
  return `${hour}:00`;
}

export function scheduleLabel(
  preset: AutomationPreset,
  hour: number | null,
  nextRunAt: number,
): string {
  if (preset === "hourly") return "hourly";
  const h = hour ?? new Date(nextRunAt).getHours();
  if (preset === "daily") return `daily at ${formatHourLabel(h)}`;
  const day = WEEKDAYS[new Date(nextRunAt).getDay()] ?? "";
  return `weekly ${day} ${formatHourLabel(h)}`;
}

/** Future-aware relative label: "now", "in 5m", "in 2h", "in 3d". */
export function formatNextRun(nextRunAt: number, now = Date.now()): string {
  const diff = nextRunAt - now;
  if (diff <= 0) return "now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export function createFormError(input: {
  name: string;
  projectId: string;
  prompt: string;
  provider: string;
  preset: AutomationPreset;
  hour: string;
  event?: string;
  org?: string;
  project?: string;
}): string | null {
  if (!input.name.trim()) return "Name is required";
  if (!input.projectId) return "Project is required";
  if (!input.prompt.trim()) return "Prompt is required";
  if (!input.provider) return "Provider is required";
  if (input.event === "sentry_issue") {
    if (!String(input.org || "").trim()) return "Sentry org is required";
    if (!String(input.project || "").trim()) return "Sentry project is required";
  }
  if (input.preset === "daily" || input.preset === "weekly") {
    if (input.hour === "") return "Hour is required";
    const n = Number(input.hour);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      return "Hour must be an integer from 0 to 23";
    }
  }
  return null;
}

/** Bare or `mcp__coder-threads__automation_create` (#1589). */
export function isAutomationCreateTool(name?: string): boolean {
  return Boolean(name && /(?:^|__)automation_create$/i.test(name));
}

export type AutomationCreateResult = {
  id: string;
  name: string;
  provider?: string;
  preset?: AutomationPreset;
  hour?: number | null;
  trigger?: AutomationTrigger | null;
  nextRunAt?: number;
};

/** Best-effort parse of an automation_create tool result. */
export function parseAutomationCreateResult(
  output?: string | null,
): AutomationCreateResult | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const id = parsed.id != null ? String(parsed.id) : "";
    const name = parsed.name != null ? String(parsed.name) : "";
    if (!id || !name) return null;
    const trigger =
      parsed.trigger && typeof parsed.trigger === "object"
        ? (parsed.trigger as AutomationTrigger)
        : null;
    return {
      id,
      name,
      provider: parsed.provider != null ? String(parsed.provider) : undefined,
      preset:
        typeof parsed.preset === "string"
          ? (parsed.preset as AutomationPreset)
          : undefined,
      hour: typeof parsed.hour === "number" ? parsed.hour : null,
      trigger,
      nextRunAt:
        typeof parsed.nextRunAt === "number" ? parsed.nextRunAt : undefined,
    };
  } catch {
    return null;
  }
}
