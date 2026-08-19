import { useSyncExternalStore } from "react";
import { completedRunIds } from "./reviewBar";
import type {
  ChatMessage,
  ProviderInfo,
  ThreadInfo,
  ThreadStatus,
} from "./shared/ipc";

/** Fields agent-replay diffs per step. Order is the report order. */
export const DIVERGENCE_FIELDS = [
  "type",
  "name",
  "input",
  "output",
  "decision",
] as const;

export type DivergenceField = (typeof DIVERGENCE_FIELDS)[number];

/**
 * One comparable step of a run. Tool calls only: assistant prose always
 * differs across models, so including it would make every Claude-vs-Codex
 * pair "diverge at step 1".
 */
export interface RunStep {
  number: number;
  type: "tool";
  name: string;
  input: string;
  output: string;
  /** Tool outcome. Permission allow/deny is not persisted on the card. */
  decision: "ok" | "error" | "pending";
  runId: string | null;
  messageId: string;
}

export interface DivergenceHit {
  step: number;
  fields: DivergenceField[];
  left: RunStep | null;
  right: RunStep | null;
}

export interface DivergenceReport {
  matched: number;
  leftCount: number;
  rightCount: number;
  /**
   * Shorter side is still running, so a length gap is not a verdict yet.
   * A field mismatch on a paired step is always a verdict.
   */
  pending: boolean;
  first: DivergenceHit | null;
}

/** Slim row for the compare picker. Built in App so ThreadView stays memo-stable. */
export interface ComparePeer {
  id: string;
  label: string;
  status: ThreadStatus;
  provider: string;
}

export interface SameThreadRun {
  runId: string;
  label: string;
}

/** Tool messages in transcript order, numbered from 1. */
export function extractSteps(
  messages: readonly ChatMessage[],
  runId?: string | null,
): RunStep[] {
  const steps: RunStep[] = [];
  for (const m of messages) {
    if (m.role !== "tool" || !m.tool) continue;
    if (runId != null && m.runId !== runId) continue;
    const tool = m.tool;
    steps.push({
      number: steps.length + 1,
      type: "tool",
      name: tool.name,
      input: tool.input ?? "",
      output: tool.output ?? "",
      decision: !tool.done ? "pending" : tool.isError ? "error" : "ok",
      runId: m.runId ?? null,
      messageId: m.id,
    });
  }
  return steps;
}

export function differingFields(left: RunStep, right: RunStep): DivergenceField[] {
  const fields: DivergenceField[] = [];
  if (left.type !== right.type) fields.push("type");
  if (left.name !== right.name) fields.push("name");
  if (left.input !== right.input) fields.push("input");
  if (left.output !== right.output) fields.push("output");
  if (left.decision !== right.decision) fields.push("decision");
  return fields;
}

/**
 * Pair steps by number and report the first mismatch. A length gap after a
 * matching prefix is a divergence only when the shorter run has finished.
 */
export function compareSteps(
  left: readonly RunStep[],
  right: readonly RunStep[],
  opts?: { leftDone?: boolean; rightDone?: boolean },
): DivergenceReport {
  const leftDone = opts?.leftDone !== false;
  const rightDone = opts?.rightDone !== false;
  const n = Math.min(left.length, right.length);
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const a = left[i]!;
    const b = right[i]!;
    const fields = differingFields(a, b);
    if (fields.length > 0) {
      return {
        matched,
        leftCount: left.length,
        rightCount: right.length,
        pending: false,
        first: { step: i + 1, fields, left: a, right: b },
      };
    }
    matched += 1;
  }
  if (left.length === right.length) {
    return {
      matched,
      leftCount: left.length,
      rightCount: right.length,
      pending: false,
      first: null,
    };
  }
  const shorterDone = left.length < right.length ? leftDone : rightDone;
  if (!shorterDone) {
    return {
      matched,
      leftCount: left.length,
      rightCount: right.length,
      pending: true,
      first: null,
    };
  }
  return {
    matched,
    leftCount: left.length,
    rightCount: right.length,
    pending: false,
    first: {
      step: n + 1,
      fields: [...DIVERGENCE_FIELDS],
      left: left[n] ?? null,
      right: right[n] ?? null,
    },
  };
}

function stepNoun(n: number): string {
  return n === 1 ? "step" : "steps";
}

/** One-line verdict. Names the first differing field and, for name, both tools. */
export function formatDivergenceHeadline(
  report: DivergenceReport,
  leftLabel: string,
  rightLabel: string,
): string {
  if (report.leftCount === 0 && report.rightCount === 0) {
    return "No steps to compare";
  }
  if (!report.first) {
    return report.pending
      ? `No divergence yet · ${report.matched} matching ${stepNoun(report.matched)}`
      : `No divergence · ${report.matched} matching ${stepNoun(report.matched)}`;
  }
  const hit = report.first;
  if (!hit.left || !hit.right) {
    const present = hit.left ?? hit.right!;
    const presentLabel = hit.left ? leftLabel : rightLabel;
    const missingLabel = hit.left ? rightLabel : leftLabel;
    return `Diverged at step ${hit.step}: ${presentLabel} ${present.name}, ${missingLabel} has no step`;
  }
  if (hit.fields.includes("name") && hit.left.name !== hit.right.name) {
    return `Diverged at step ${hit.step} · name · ${hit.left.name} vs ${hit.right.name}`;
  }
  if (hit.fields.length === 1) {
    return `Diverged at step ${hit.step} · ${hit.fields[0]}`;
  }
  return `Diverged at step ${hit.step} · ${hit.fields.join(", ")}`;
}

/**
 * Other attempts at the same task. A fork compares with its source and
 * sibling forks (same handoffFrom). A source compares with its children.
 * Descendants of a fork are a later job, not a parallel attempt.
 */
export function sameTaskPeers<
  T extends { id: string; projectId: string; handoffFrom: string | null },
>(current: T, all: readonly T[]): T[] {
  const parent = current.handoffFrom;
  const out: T[] = [];
  const seen = new Set<string>();
  const push = (row: T | undefined) => {
    if (!row || row.id === current.id || seen.has(row.id)) return;
    if (row.projectId !== current.projectId) return;
    seen.add(row.id);
    out.push(row);
  };
  if (parent) {
    // Siblings first: "Claude vs Codex" is the default pick, not the source.
    for (const t of all) {
      if (t.handoffFrom === parent) push(t);
    }
    push(all.find((t) => t.id === parent));
    return out;
  }
  for (const t of all) {
    if (t.handoffFrom === current.id) push(t);
  }
  return out;
}

export function comparePeerLabel(
  t: { id: string; provider: string; title: string },
  peers: readonly { id: string; provider: string }[],
  providers: readonly Pick<ProviderInfo, "id" | "name">[] = [],
): string {
  const name = providers.find((p) => p.id === t.provider)?.name ?? t.provider;
  const clash = peers.some((p) => p.id !== t.id && p.provider === t.provider);
  if (!clash) return name;
  const title = t.title.trim();
  return title ? `${name} · ${title}` : name;
}

/** Completed runs that actually called a tool, oldest first, labeled Run 1… */
export function sameThreadRuns(
  messages: readonly ChatMessage[],
  threadStatus: ThreadStatus,
): SameThreadRun[] {
  const ids = completedRunIds(messages, threadStatus);
  const out: SameThreadRun[] = [];
  let n = 0;
  for (const runId of ids) {
    if (extractSteps(messages, runId).length === 0) continue;
    n += 1;
    out.push({ runId, label: `Run ${n}` });
  }
  return out;
}

export function isThreadDone(status: ThreadStatus): boolean {
  return status !== "working";
}

export function toComparePeer(
  t: Pick<ThreadInfo, "id" | "provider" | "title" | "status">,
  peers: readonly Pick<ThreadInfo, "id" | "provider">[],
  providers: readonly Pick<ProviderInfo, "id" | "name">[] = [],
): ComparePeer {
  return {
    id: t.id,
    label: comparePeerLabel(t, peers, providers),
    status: t.status,
    provider: t.provider,
  };
}

export function truncateStepValue(value: string, max = 160): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Whether the thread-header divergence card is shown at all, toggled from
 * the Environment tab. Module state is the source of truth (so the toggle
 * works even when localStorage does not persist); localStorage carries it
 * across launches. Default on.
 */
const DIVERGENCE_CARD_KEY = "coder.divergenceCard";
let divergenceCardOn: boolean | null = null;
const divergenceCardListeners = new Set<() => void>();

export function getDivergenceCardEnabled(): boolean {
  if (divergenceCardOn == null) {
    try {
      divergenceCardOn = window.localStorage.getItem(DIVERGENCE_CARD_KEY) !== "off";
    } catch {
      divergenceCardOn = true;
    }
  }
  return divergenceCardOn;
}

export function setDivergenceCardEnabled(on: boolean): void {
  divergenceCardOn = on;
  try {
    window.localStorage.setItem(DIVERGENCE_CARD_KEY, on ? "on" : "off");
  } catch {
    // Private mode / quota: the toggle just stops persisting.
  }
  for (const l of divergenceCardListeners) l();
}

export function useDivergenceCardEnabled(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      divergenceCardListeners.add(onChange);
      return () => divergenceCardListeners.delete(onChange);
    },
    getDivergenceCardEnabled,
    () => true,
  );
}
