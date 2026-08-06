import type { Workflow } from "./types.js";

export type PhaseProgressState = "pending" | "active" | "done" | "failed";

export interface PhaseProgressRow {
  name: string;
  total: number;
  running: number;
  settled: number;
  failed: number;
  state: PhaseProgressState;
}

/**
 * Per-phase progress snapshot.
 *
 * State rules:
 * - done: every agent is settled
 * - failed: any agent failed and none are running
 * - active: any running, or partially settled (some settled, others not all settled)
 * - pending: otherwise (all pending / no progress yet)
 */
export function phaseProgress(workflow: Workflow): PhaseProgressRow[] {
  return workflow.phases.map((phase) => {
    const total = phase.agents.length;
    let running = 0;
    let settled = 0;
    let failed = 0;
    let pending = 0;

    for (const agent of phase.agents) {
      switch (agent.status) {
        case "running":
          running += 1;
          break;
        case "settled":
          settled += 1;
          break;
        case "failed":
          failed += 1;
          break;
        default:
          pending += 1;
          break;
      }
    }

    const state = deriveState({ total, running, settled, failed, pending });
    return {
      name: phase.name,
      total,
      running,
      settled,
      failed,
      state,
    };
  });
}

function deriveState(counts: {
  total: number;
  running: number;
  settled: number;
  failed: number;
  pending: number;
}): PhaseProgressState {
  const { total, running, settled, failed } = counts;

  if (total > 0 && settled === total) {
    return "done";
  }

  if (running > 0) {
    return "active";
  }

  if (failed > 0) {
    return "failed";
  }

  // Partially settled (and no running / no failed): still in progress.
  if (settled > 0 && settled < total) {
    return "active";
  }

  return "pending";
}
