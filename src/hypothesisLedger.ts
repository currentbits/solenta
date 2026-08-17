import { formatRelativeAge } from "./format";
import type { Hypothesis, HypothesisStatus } from "./shared/ipc";

/** Ruled out first: that list is the point of the ledger. */
const HYPOTHESIS_STATUS_ORDER: HypothesisStatus[] = [
  "invalidated",
  "validated",
  "inconclusive",
];

export interface HypothesisGroup {
  status: HypothesisStatus;
  label: string;
  entries: Hypothesis[];
}

/** Group heading / row chip. */
export function hypothesisStatusLabel(status: HypothesisStatus): string {
  if (status === "invalidated") return "Ruled out";
  if (status === "validated") return "Worked";
  return "Inconclusive";
}

/**
 * Age of one verdict. Same "3m ago" shape as the verify card so the two
 * cards do not invent different clocks.
 */
export function formatHypothesisAge(at: number, now = Date.now()): string {
  const age = formatRelativeAge(at, now);
  return age === "now" ? "now" : `${age} ago`;
}

/**
 * Display order puts ruled-out first. Within a status, newest-first so
 * the latest verdict is on top. Empty statuses are dropped.
 */
export function groupHypotheses(list: Hypothesis[]): HypothesisGroup[] {
  const buckets: Record<HypothesisStatus, Hypothesis[]> = {
    invalidated: [],
    validated: [],
    inconclusive: [],
  };
  // A status outside the three is dropped, not thrown on: main validates on
  // write, but a hand-edited store must not take the whole panel down.
  for (const h of list) buckets[h.status]?.push(h);
  // ponytail: n≤HYPOTHESES_MAX (50); sort per bucket, not a fancy partition.
  return HYPOTHESIS_STATUS_ORDER.flatMap((status) => {
    const entries = buckets[status];
    if (entries.length === 0) return [];
    return [
      {
        status,
        label: hypothesisStatusLabel(status),
        entries: [...entries].sort((a, b) => b.at - a.at),
      },
    ];
  });
}

/**
 * Collapsed header. Zero-count parts drop so a one-status ledger does
 * not read "0 worked".
 */
export function formatHypothesisSummary(list: Hypothesis[]): string {
  let invalidated = 0;
  let validated = 0;
  let inconclusive = 0;
  for (const h of list) {
    if (h.status === "invalidated") invalidated++;
    else if (h.status === "validated") validated++;
    else inconclusive++;
  }
  const parts: string[] = [];
  if (invalidated) parts.push(`${invalidated} ruled out`);
  if (validated) parts.push(`${validated} worked`);
  if (inconclusive) parts.push(`${inconclusive} inconclusive`);
  return parts.join(" · ");
}
