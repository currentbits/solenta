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
 * ponytail: a worker STOPPED mid-run is indistinguishable from a fork that
 * never ran (both idle, runStartedAt cleared) — add a stopped flag on the
 * thread if that stall needs its own surface.
 */

/** Minimal row shape shared by ThreadInfo and ThreadSummaryInfo. */
export interface WaitRow {
  id: string;
  title: string;
  status: ThreadStatus;
  handoffFrom: string | null;
  runStartedAt?: number | null;
  awaitingInput?: boolean;
  subagents?: readonly SubagentInfo[];
}

export interface WaitChild {
  /** Thread id, or null for an in-agent subagent (nothing to navigate to). */
  id: string | null;
  title: string;
  /** "blocked" = stalled on a prompt only the user can answer. */
  state: "working" | "blocked";
}

export interface WaitState {
  children: WaitChild[];
  /** How many children are blocked on the user. */
  blocked: number;
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
    const state = out.get(parentId) ?? { children: [], blocked: 0, since: null };
    state.children.push(child);
    if (child.state === "blocked") state.blocked += 1;
    if (since != null && (state.since == null || since < state.since)) {
      state.since = since;
    }
    out.set(parentId, state);
  };

  for (const row of rows) {
    if (
      row.status === "working" &&
      row.handoffFrom != null &&
      row.handoffFrom !== row.id
    ) {
      add(
        row.handoffFrom,
        {
          id: row.id,
          title: row.title,
          state: row.awaitingInput ? "blocked" : "working",
        },
        row.runStartedAt,
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

/** "Waiting on 2 workers · 3m · 1 blocked". */
export function waitLabel(state: WaitState, now = Date.now()): string {
  const n = state.children.length;
  const parts = [`Waiting on ${n} ${n === 1 ? "worker" : "workers"}`];
  if (state.since != null) parts.push(formatElapsed(state.since, now));
  if (state.blocked > 0) parts.push(`${state.blocked} blocked`);
  return parts.join(" · ");
}

/** Hover detail: one line per child, blocked ones called out. */
export function waitTooltip(state: WaitState): string {
  const n = state.children.length;
  const head = `Waiting on ${n} ${n === 1 ? "worker" : "workers"}:`;
  return [
    head,
    ...state.children.map(
      (c) => `• ${c.title}${c.state === "blocked" ? " — blocked on you" : ""}`,
    ),
  ].join("\n");
}
