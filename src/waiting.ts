import { formatElapsed } from "./format";
import type { SubagentInfo, ThreadStatus } from "./shared/ipc";

/**
 * Live wait state for a thread that handed work off (issue #42).
 *
 * A thread that forks workers (thread_fork) or spawns Agent-tool subagents
 * ends its own turn and reads idle/done/working like any other thread, so a
 * healthy wait and a hung fan-out look identical. This derives "waiting on
 * N" from the parent/child link that already exists (handoffFrom) plus the
 * runner's subagent rows — no new state, no new IPC.
 *
 * Only LIVE children count: a worker still running, or one stalled on a
 * permission prompt (awaitingInput). Finished / failed children are visible
 * on their own card and in the Team roster; counting them here would keep an
 * old failure pinned to the parent forever.
 * The exception is a worker STOPPED mid-run (issue #183): it is idle with
 * runStartedAt cleared, indistinguishable from a fork that never ran, so the
 * stall it leaves behind would be invisible. Its `stoppedAt` stamp counts it
 * here under its own label until the thread runs again.
 */

/** Minimal row shape shared by ThreadInfo and ThreadSummaryInfo. */
export interface WaitRow {
  id: string;
  title: string;
  status: ThreadStatus;
  handoffFrom: string | null;
  runStartedAt?: number | null;
  stoppedAt?: number | null;
  awaitingInput?: boolean;
  subagents?: readonly SubagentInfo[];
}

export interface WaitChild {
  /** Thread id, or null for an in-agent subagent (nothing to navigate to). */
  id: string | null;
  title: string;
  /**
   * "blocked" = stalled on a prompt only the user can answer.
   * "stopped" = run killed mid-flight; it will never finish on its own.
   */
  state: "working" | "blocked" | "stopped";
}

export interface WaitState {
  children: WaitChild[];
  /** How many children are blocked on the user. */
  blocked: number;
  /** How many children were stopped mid-run (issue #183). */
  stopped: number;
  /** Earliest runStartedAt among live children; null when unknown. */
  since: number | null;
}

/**
 * Wait state per parent thread id, in one pass over the rows.
 * Threads with no live delegated work are absent from the map.
 */
export function buildWaitStates(
  rows: readonly WaitRow[],
): Map<string, WaitState> {
  const out = new Map<string, WaitState>();
  const add = (parentId: string, child: WaitChild, since?: number | null) => {
    const state =
      out.get(parentId) ?? { children: [], blocked: 0, stopped: 0, since: null };
    state.children.push(child);
    if (child.state === "blocked") state.blocked += 1;
    if (child.state === "stopped") state.stopped += 1;
    if (since != null && (state.since == null || since < state.since)) {
      state.since = since;
    }
    out.set(parentId, state);
  };

  for (const row of rows) {
    if (row.handoffFrom == null || row.handoffFrom === row.id) {
      // Not a fork (or a corrupt self-reference): no parent to report to.
    } else if (row.status === "working") {
      add(
        row.handoffFrom,
        {
          id: row.id,
          title: row.title,
          state: row.awaitingInput ? "blocked" : "working",
        },
        row.runStartedAt,
      );
    } else if (row.stoppedAt != null) {
      // Stopped mid-run and never restarted: the parent is still owed this
      // work, so surface the stall instead of reading it as a fork that
      // never ran (issue #183).
      add(
        row.handoffFrom,
        { id: row.id, title: row.title, state: "stopped" },
        row.stoppedAt,
      );
    }
    for (const sub of row.subagents ?? []) {
      // No spawn timestamp on a subagent row: the thread's own Working badge
      // already carries the turn's elapsed, so leave `since` to the workers.
      if (sub.status !== "running") continue;
      add(row.id, { id: null, title: sub.description, state: "working" });
    }
  }
  return out;
}

/**
 * A parent whose own turn ended while its workers run reads "done" (or
 * "idle") from the runner, which tells the wrong story: it is delegating,
 * not finished. Failure stays failure — that is the news, workers or not.
 */
export function isDelegating(
  status: ThreadStatus,
  wait: WaitState | null | undefined,
): boolean {
  return wait != null && (status === "done" || status === "idle");
}

/**
 * Descriptions of the running in-agent subagents (issue #542). A WaitChild
 * with no thread id is an Agent-tool subagent: nothing to navigate to, and
 * the only place its description is visible.
 */
export function subagentNames(state: WaitState): string[] {
  return state.children.filter((c) => c.id == null).map((c) => c.title);
}

/** "2 workers", "1 subagent", or "2 workers · 1 subagent". */
function childPhrase(children: readonly WaitChild[]): string {
  const subs = children.filter((c) => c.id == null).length;
  const workers = children.length - subs;
  const parts: string[] = [];
  if (workers > 0) {
    parts.push(`${workers} ${workers === 1 ? "worker" : "workers"}`);
  }
  if (subs > 0) parts.push(`${subs} ${subs === 1 ? "subagent" : "subagents"}`);
  return parts.join(" · ");
}

/** "Waiting on 2 workers · 3m · 1 blocked · 1 stopped". */
export function waitLabel(state: WaitState, now = Date.now()): string {
  const parts = [`Waiting on ${childPhrase(state.children)}`];
  if (state.since != null) parts.push(formatElapsed(state.since, now));
  if (state.blocked > 0) parts.push(`${state.blocked} blocked`);
  if (state.stopped > 0) parts.push(`${state.stopped} stopped`);
  return parts.join(" · ");
}

/** Hover detail: one line per child, blocked/stopped ones called out. */
export function waitTooltip(state: WaitState): string {
  const head = `Waiting on ${childPhrase(state.children)}:`;
  return [
    head,
    ...state.children.map((c) => {
      const note =
        c.state === "blocked"
          ? " — blocked on you"
          : c.state === "stopped"
            ? " — stopped mid-run"
            : "";
      return `• ${c.title}${note}`;
    }),
  ].join("\n");
}
