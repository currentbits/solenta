/**
 * Renderer helpers for provider quota-wait (#462).
 * Parsing and park/wake live in electron/quotaWait.js; the card only needs
 * the wake label and "is this thread parked?" checks.
 */

export function isQuotaWaitStatus(
  status: string | null | undefined,
): boolean {
  return status === "quota-wait";
}

/**
 * Sidebar / banner clock. Same local calendar rules as snooze labels.
 * Examples: "3pm", "tomorrow 3pm", "Mon 9:30am".
 */
export function formatQuotaWaitLabel(until: number, now: number): string {
  if (!Number.isFinite(until) || !Number.isFinite(now)) return "—";
  const d = new Date(until);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  const tomorrow = new Date(n);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  const time = timeOfDayLabel(until);
  if (sameDay) return time;
  if (isTomorrow) return `tomorrow ${time}`;
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${time}`;
}

function timeOfDayLabel(ms: number): string {
  const d = new Date(ms);
  const hours = d.getHours();
  const mins = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return mins === 0
    ? `${h12}${ampm}`
    : `${h12}:${String(mins).padStart(2, "0")}${ampm}`;
}
