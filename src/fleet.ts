/**
 * Pure fleet rollup for the agent analytics view (issue #375). Evidence in,
 * rates out — no git, no gh, no clock beyond the `now` passed in.
 */
import type { FleetEvidence } from "./shared/ipc";

export type FleetRange = 7 | 30 | 90;

export const FLEET_RANGES: FleetRange[] = [7, 30, 90];

/** What happened to a thread's work, once. */
export type FleetOutcome = "merged" | "closed" | "open" | "none";

export interface FleetProviderRow {
  provider: string;
  threads: number;
  costUsd: number;
  tokens: number;
  /** Sum of per-thread (endedAt - createdAt). */
  wallClockMs: number;
  /** Sum of per-thread activeMs. */
  activeMs: number;
  /** activeMs / wallClockMs; 0 when there is no wall clock. */
  activeShare: number;
  prsOpened: number;
  prsMerged: number;
  prsClosedUnmerged: number;
  prsOpen: number;
  /**
   * merged / (merged + closed-unmerged). Open PRs are excluded: they are not
   * a decision yet, and counting them as failures would make a fast fleet
   * look worse the more it ships. 0 when nothing has been decided.
   */
  mergeRate: number;
  /**
   * closed-unmerged / decided. NOT the inverse of failure — a superseded or
   * duplicate fix closing unmerged is the system working (Sentry's read).
   */
  closeWithoutMergeRate: number;
  /** Provider cost over merged PRs; null when this provider merged nothing. */
  costPerMergedPrUsd: number | null;
  /** Lines added by merged work, over threads past the durability window. */
  linesAdded: number;
  /** Of those, still present at HEAD. */
  linesSurviving: number;
  /** linesSurviving / linesAdded; null when nothing is measurable yet. */
  durableShare: number | null;
  /** 1 - durableShare; null when nothing is measurable yet. */
  reworkShare: number | null;
  /** Median open -> first review for this provider's PRs; null when none. */
  reviewLatencyMs: number | null;
}

export interface FleetThreadRow {
  threadId: string;
  title: string;
  provider: string;
  costUsd: number;
  activeMs: number;
  wallClockMs: number;
  linesAdded: number | null;
  durableShare: number | null;
  outcome: FleetOutcome;
  prNumber: number | null;
  prUrl: string | null;
}

export interface FleetSummary {
  /** Per provider, most expensive first. */
  providers: FleetProviderRow[];
  /** Every provider folded into one row; `provider` is "all". */
  totals: FleetProviderRow;
  /** Per thread, newest first. */
  threads: FleetThreadRow[];
  /** Median open -> first review for HUMAN PRs; the review-tax baseline. */
  humanReviewLatencyMs: number | null;
  /**
   * Agent median / human median review latency ("review tax", Swarmia's
   * metric). >1 means agent PRs wait longer than human ones. null when
   * either side has no reviewed PR in range.
   */
  reviewTax: number | null;
  durabilityWindowDays: number;
  notes: string[];
}

export function emptyProviderRow(provider: string): FleetProviderRow {
  return {
    provider,
    threads: 0,
    costUsd: 0,
    tokens: 0,
    wallClockMs: 0,
    activeMs: 0,
    activeShare: 0,
    prsOpened: 0,
    prsMerged: 0,
    prsClosedUnmerged: 0,
    prsOpen: 0,
    mergeRate: 0,
    closeWithoutMergeRate: 0,
    costPerMergedPrUsd: null,
    linesAdded: 0,
    linesSurviving: 0,
    durableShare: null,
    reworkShare: null,
    reviewLatencyMs: null,
  };
}

/**
 * Roll `evidence` up over the last `range` days ending at `now` (epoch ms).
 * Threads are in range by createdAt, PRs by createdAt.
 */
export function summarizeFleet(
  evidence: FleetEvidence,
  _range: FleetRange,
  _now: number,
): FleetSummary {
  // TODO(#375 worker B): real rollup. Empty shape keeps the view honest
  // until then — no data reads as no data, never as zero merge rate.
  return {
    providers: [],
    totals: emptyProviderRow("all"),
    threads: [],
    humanReviewLatencyMs: null,
    reviewTax: null,
    durabilityWindowDays: evidence?.durabilityWindowDays ?? 14,
    notes: evidence?.notes ?? [],
  };
}
