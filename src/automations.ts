import type { AutomationPreset } from "./shared/ipc";

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
}): string | null {
  if (!input.name.trim()) return "Name is required";
  if (!input.projectId) return "Project is required";
  if (!input.prompt.trim()) return "Prompt is required";
  if (!input.provider) return "Provider is required";
  if (input.preset === "daily" || input.preset === "weekly") {
    if (input.hour === "") return "Hour is required";
    const n = Number(input.hour);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      return "Hour must be an integer from 0 to 23";
    }
  }
  return null;
}
