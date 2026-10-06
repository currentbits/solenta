/**
 * One-line live status while a turn is running (issue #751 / #752).
 *
 * The strip used to hardcode "Agent working…", so a long thinking window or a
 * running tool still looked idle. Prefer, in order: hung warning, workflow
 * fan-out, the current tool summary, "Thinking…", then the generic fallback.
 */

export interface LiveWorkingInput {
  /** Already-formatted stall elapsed, e.g. "12m". */
  stalledElapsed?: string | null;
  /** Running agents in a multi-phase workflow. */
  workflowRunning?: number | null;
  /** One-line tool summary, e.g. "Read: src/foo.ts". */
  toolSummary?: string | null;
  /** Reasoning is streaming and no later tool has started. */
  thinking?: boolean;
}

export function liveWorkingLabel(input: LiveWorkingInput = {}): string {
  if (input.stalledElapsed) {
    return `No output for ${input.stalledElapsed}. The agent may be hung`;
  }
  // Zero means every workflow agent finished while the turn is still live:
  // fall through to the tool / thinking label instead of "0 agents working".
  if (input.workflowRunning) {
    const n = input.workflowRunning;
    return `${n} agent${n === 1 ? "" : "s"} working in the background`;
  }
  const tool = input.toolSummary?.trim();
  if (tool) return tool;
  if (input.thinking) return "Thinking…";
  return "Agent working…";
}
