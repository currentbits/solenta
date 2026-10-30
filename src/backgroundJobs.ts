import type { ChatMessage, SubagentInfo, WorkflowView } from "./shared/ipc";

/**
 * Background jobs still running on a thread (#1775): the one-line working
 * label (src/workingLabel.ts) collapses all of this into "N agents working
 * in the background" or the current tool summary. This derives a named list
 * instead, so the thread view can show which shell / subagent / workflow
 * agent is actually running.
 *
 * Sources, cheapest first:
 *  - shell / monitor: derived purely from the transcript's tool-call
 *    messages (Bash run_in_background, BashOutput, KillShell) -- no new
 *    main-process tracking needed, the data is already in ChatMessage.tool.
 *  - subagent: thread.subagents (electron/runner-subagents.js) is already
 *    tracked server-side (issue #542); this only adds `startedAt` there.
 *  - workflow: detail.workflow.phases[].agents, same rows runningAgents
 *    already counts in src/components/thread/useTranscriptAnnotations.ts.
 */

export type BackgroundJobKind = "shell" | "subagent" | "monitor" | "workflow";

export interface BackgroundJob {
  id: string;
  kind: BackgroundJobKind;
  label: string;
  startedAt: number | null;
}

const SHELL_LABEL_MAX = 60;

function parseToolInput(input: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(input);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function shortCommand(cmd: unknown): string {
  const s = typeof cmd === "string" ? cmd.trim() : "";
  if (!s) return "background shell";
  return s.length > SHELL_LABEL_MAX
    ? `${s.slice(0, SHELL_LABEL_MAX - 1).trimEnd()}…`
    : s;
}

/**
 * Shell id a backgrounded Bash call reports back (e.g. "...running in the
 * background with ID: bash_1"), matched against the `bash_id`/`shell_id`
 * BashOutput and KillShell take as input.
 * ponytail: best-effort regex over free-text output; if a provider's
 * phrasing ever drifts the id just never matches, so the shell row falls
 * back to its own tool_use id as the key -- still correct, just never
 * recognized as killed by a later KillShell call.
 */
function extractShellId(output: string | null | undefined): string | null {
  if (!output) return null;
  const m = output.match(/\b(bash_[a-z0-9]+|shell_[a-z0-9]+)\b/i);
  return m ? m[1] : null;
}

function shellIdFromInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const v = input.bash_id ?? input.shell_id;
  return typeof v === "string" && v ? v : null;
}

/**
 * Background jobs still running right now. Pass `null`/`[]`/empty when the
 * thread is not working -- callers own that gate so a finished run's stale
 * (never-confirmed-killed) shell does not linger forever.
 */
export function deriveBackgroundJobs(
  messages: readonly ChatMessage[],
  subagents: readonly SubagentInfo[] | null | undefined,
  workflow: WorkflowView | null | undefined,
  runStartedAt: number | null | undefined,
): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];
  const finishedShellIds = new Set<string>();
  const shells = new Map<string, { label: string; startedAt: number }>();
  const monitors: BackgroundJob[] = [];

  for (const m of messages) {
    if (m.role !== "tool" || !m.tool) continue;
    const { tool } = m;
    const input = parseToolInput(tool.input);

    if (tool.name === "Bash" && input?.run_in_background === true) {
      const id = extractShellId(tool.output) ?? tool.id;
      shells.set(id, { label: shortCommand(input.command), startedAt: m.createdAt });
      continue;
    }

    if (tool.name === "KillShell") {
      const id = shellIdFromInput(input);
      if (id) finishedShellIds.add(id);
      continue;
    }

    if (tool.name === "BashOutput") {
      const id = shellIdFromInput(input);
      if (!tool.done) {
        // Still blocked waiting for output: its own visible wait, on top of
        // (not instead of) the shell row it is watching.
        monitors.push({
          id: `monitor:${tool.id}`,
          kind: "monitor",
          label: id ? `Watching ${id}` : "Watching background output",
          startedAt: m.createdAt,
        });
      } else if (id && /completed|killed|exited|finished/i.test(tool.output ?? "")) {
        finishedShellIds.add(id);
      }
    }
  }

  for (const [id, shell] of shells) {
    if (finishedShellIds.has(id)) continue;
    jobs.push({ id: `shell:${id}`, kind: "shell", label: shell.label, startedAt: shell.startedAt });
  }
  jobs.push(...monitors);

  for (const s of subagents ?? []) {
    if (s.status !== "running") continue;
    jobs.push({
      id: `subagent:${s.id}`,
      kind: "subagent",
      label: s.description,
      startedAt: s.startedAt ?? null,
    });
  }

  for (const phase of workflow?.phases ?? []) {
    for (const agent of phase.agents) {
      if (agent.status !== "running") continue;
      jobs.push({
        id: `workflow:${agent.id}`,
        kind: "workflow",
        label: `${phase.name} · ${agent.model}`,
        startedAt: runStartedAt ?? null,
      });
    }
  }

  return jobs;
}
