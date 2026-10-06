import type { ThreadInfo } from "../../shared/ipc";
import {
  formatElapsed,
  formatWorkingLabel,
} from "../../format";
import { formatQuotaWaitLabel } from "../../quotaWait";
import { showWokePill } from "../../threadSnooze";
import { isUnread } from "../../threadUnread";
import {
  isDelegating,
  waitTooltip,
  type WaitState,
} from "../../waiting";

/**
 * t3 flatten (#566): the row's whole status vocabulary is one label.
 * Precedence lives in statusDotFor; the card maps that onto colored text.
 */
export type StatusDotInfo = {
  tone: "working" | "attention" | "failed" | "queued";
  /** Tooltip: full phrase, e.g. "Stalled 4m" or "Waiting on 2 workers · 3m". */
  label: string;
  /** Spoken triage word appended to the row's aria-label. */
  spoken: string;
  /** Legacy data hooks (tests, e2e selectors). */
  flags: Record<string, string>;
};

export type StatusLabelInfo = {
  text: string;
  tone:
    | "working"
    | "delegating"
    | "attention"
    | "stalled"
    | "failed"
    | "done"
    | "queued";
  title: string;
  spoken: string;
  flags: Record<string, string>;
};

export function statusDotFor(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusDotInfo | null {
  const base = baseStatusDot(thread, now, wait, active);
  // Queued follow-up (#92) rides along on whatever status is showing; it only
  // owns the row when the thread is otherwise idle.
  if (!thread.queued) return base;
  if (base == null) {
    return {
      tone: "queued",
      label: `Queued: ${thread.queued.prompt}`,
      spoken: "queued follow-up",
      flags: { "data-queued-dot": thread.id },
    };
  }
  return {
    ...base,
    label: `${base.label}. Queued: ${thread.queued.prompt}`,
    flags: { ...base.flags, "data-queued-dot": thread.id },
  };
}

function baseStatusDot(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusDotInfo | null {
  const waitSuffix = wait ? `. ${waitTooltip(wait)}` : "";
  const waitFlags: Record<string, string> = wait
    ? {
        "data-wait-badge": thread.id,
        ...(wait.blocked > 0 ? { "data-attention": "true" } : {}),
      }
    : {};
  if (thread.status === "failed") {
    return {
      tone: "failed",
      label: thread.lastError ?? "Failed",
      spoken: "failed",
      flags: { "data-failed": thread.id },
    };
  }
  if (thread.status === "quota-wait") {
    const until = thread.quotaWaitUntil;
    const clock =
      until != null && Number.isFinite(until)
        ? formatQuotaWaitLabel(until, now)
        : "—";
    return {
      tone: "attention",
      label: thread.lastError ?? `Usage limit reached. Resuming at ${clock}.`,
      spoken: "needs attention",
      flags: { "data-quota-wait": "" },
    };
  }
  if (thread.status === "working" && thread.awaitingInput) {
    return {
      tone: "attention",
      label: `Waiting for input${waitSuffix}`,
      spoken: "needs attention",
      flags: { "data-waiting": "", ...waitFlags },
    };
  }
  if (thread.status === "working" && thread.stalledAt != null) {
    return {
      tone: "attention",
      label: `Stalled ${formatElapsed(thread.stalledAt, now)}${waitSuffix}`,
      spoken: "needs attention",
      flags: { "data-stalled": "", ...waitFlags },
    };
  }
  if (wait && wait.blocked > 0) {
    return {
      tone: "attention",
      label: waitTooltip(wait),
      spoken: "needs attention",
      flags: waitFlags,
    };
  }
  if (thread.status === "working") {
    const label =
      thread.runStartedAt != null
        ? formatWorkingLabel(thread.runStartedAt, now)
        : "Working";
    return {
      tone: "working",
      label: `${label}${waitSuffix}`,
      spoken: "working",
      flags: waitFlags,
    };
  }
  if (isDelegating(thread.status, wait)) {
    return {
      tone: "working",
      label: wait ? waitTooltip(wait) : "Delegating",
      spoken: "delegating",
      flags: { "data-delegating": thread.id, ...waitFlags },
    };
  }
  if (!active && showWokePill(thread, now)) {
    return {
      tone: "attention",
      label: "Woke from snooze",
      spoken: "needs attention",
      flags: { "data-woke": "" },
    };
  }
  return null;
}

/**
 * Card status slot: colored TEXT. Precedence matches statusDotFor; unread
 * done is the extra idle case the spec adds. Live / unread-done also get a
 * title-adjacent pulse via statusPulseFor.
 */
export function statusLabelFor(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusLabelInfo | null {
  const dot = statusDotFor(thread, now, wait, active);
  if (thread.status === "failed") {
    return {
      text: "Failed",
      tone: "failed",
      title: dot?.label ?? "Failed",
      spoken: "failed",
      flags: dot?.flags ?? { "data-failed": thread.id },
    };
  }
  if (thread.status === "quota-wait") {
    return {
      text: "Quota",
      tone: "attention",
      title: dot?.label ?? "Quota",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-quota-wait": "" },
    };
  }
  if (thread.status === "working" && thread.awaitingInput) {
    return {
      text: "Waiting",
      tone: "attention",
      title: dot?.label ?? "Waiting for input",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-waiting": "" },
    };
  }
  if (thread.status === "working" && thread.stalledAt != null) {
    return {
      text: "Stalled",
      tone: "stalled",
      title: dot?.label ?? "Stalled",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-stalled": "" },
    };
  }
  if (wait && wait.blocked > 0) {
    return {
      text: "Waiting",
      tone: "attention",
      title: dot?.label ?? waitTooltip(wait),
      spoken: "needs attention",
      flags: dot?.flags ?? {},
    };
  }
  if (thread.status === "working") {
    const elapsed =
      thread.runStartedAt != null
        ? formatElapsed(thread.runStartedAt, now)
        : "";
    return {
      text: elapsed ? `Working ${elapsed}` : "Working",
      tone: "working",
      title: dot?.label ?? "Working",
      spoken: "working",
      flags: dot?.flags ?? {},
    };
  }
  if (isDelegating(thread.status, wait)) {
    return {
      text: "Delegating",
      tone: "delegating",
      title: dot?.label ?? "Delegating",
      spoken: "delegating",
      flags: dot?.flags ?? { "data-delegating": thread.id },
    };
  }
  if (!active && showWokePill(thread, now)) {
    return {
      text: "Woke",
      tone: "attention",
      title: dot?.label ?? "Woke from snooze",
      spoken: "needs attention",
      flags: dot?.flags ?? { "data-woke": "" },
    };
  }
  // Queued follow-up (#92) owns the slot only when nothing louder does;
  // on a busy card it rides along in the tooltip via statusDotFor.
  if (thread.queued) {
    return {
      text: "Queued",
      tone: "queued",
      title: dot?.label ?? `Queued: ${thread.queued.prompt}`,
      spoken: "queued follow-up",
      flags: dot?.flags ?? { "data-queued-dot": thread.id },
    };
  }
  if (
    !active &&
    isUnread(thread) &&
    (thread.status === "done" || thread.status === "idle")
  ) {
    return {
      text: "Done",
      tone: "done",
      title: "Done",
      spoken: "unread",
      flags: {},
    };
  }
  return null;
}

export type StatusPulseTone = "working" | "waiting" | "delegating" | "done";

/**
 * Title-adjacent pulse (#763). Live / unread-done states only — failed,
 * stalled, quota, queued, and woke stay text-only so the motion means
 * "this thread is in flight or just finished."
 */
/**
 * Display-only: collapse generated `Fork:` prefixes on compact worker
 * rows. Does not rewrite stored titles (rename still edits the raw value).
 */
export function displayWorkerTitle(title: string): string {
  let s = title.trim();
  while (/^fork:\s*/i.test(s)) s = s.replace(/^fork:\s*/i, "").trim();
  return s || title;
}

export function statusPulseFor(
  thread: ThreadInfo,
  now: number,
  wait: WaitState | null,
  active: boolean,
): StatusPulseTone | null {
  if (thread.status !== "working") return null;
  if (thread.awaitingInput || thread.stalledAt != null) return null;
  const label = statusLabelFor(thread, now, wait, active);
  if (!label || label.tone !== "working") return null;
  if (!label.text.startsWith("Working")) return null;
  return "working";
}
