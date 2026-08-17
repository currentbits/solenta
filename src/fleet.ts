/**
 * Pure fleet rollup for the agent analytics view (issue #375). Evidence in,
 * rates out — no git, no gh, no clock beyond the `now` passed in.
 */
import type { FleetEvidence, FleetPr, FleetThread } from "./shared/ipc";

const DAY_MS = 24 * 60 * 60 * 1000;

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

function finiteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nonNeg(value: unknown): number {
  const n = finiteNumber(value);
  return n < 0 ? 0 : n;
}

function nullableNonNeg(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readThread(raw: unknown): FleetThread | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const threadId = readString(rec.threadId);
  const provider = readString(rec.provider);
  if (!threadId || !provider) return null;
  return {
    threadId,
    projectId: readString(rec.projectId),
    title: readString(rec.title),
    provider,
    model: rec.model == null ? null : readString(rec.model),
    createdAt: finiteNumber(rec.createdAt),
    endedAt: finiteNumber(rec.endedAt),
    activeMs: nonNeg(rec.activeMs),
    costUsd: nonNeg(rec.costUsd),
    inputTokens: nonNeg(rec.inputTokens),
    outputTokens: nonNeg(rec.outputTokens),
    turns: nonNeg(rec.turns),
    linesAdded: nullableNonNeg(rec.linesAdded),
    linesSurviving: nullableNonNeg(rec.linesSurviving),
    durabilityMeasurable: rec.durabilityMeasurable === true,
  };
}

function readPr(raw: unknown): FleetPr | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const state = rec.state;
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") return null;
  const threadRaw = rec.threadId;
  const threadId =
    threadRaw == null || threadRaw === "" ? null : readString(threadRaw);
  return {
    projectId: readString(rec.projectId),
    number: finiteNumber(rec.number),
    url: readString(rec.url),
    title: readString(rec.title),
    headRefName: readString(rec.headRefName),
    state,
    createdAt: finiteNumber(rec.createdAt),
    mergedAt: nullableNonNeg(rec.mergedAt),
    closedAt: nullableNonNeg(rec.closedAt),
    additions: nonNeg(rec.additions),
    deletions: nonNeg(rec.deletions),
    firstReviewAt: nullableNonNeg(rec.firstReviewAt),
    threadId,
  };
}

function inWindow(createdAt: number, start: number, now: number): boolean {
  return createdAt >= start && createdAt <= now;
}

function wallClockMs(thread: FleetThread): number {
  const ms = thread.endedAt - thread.createdAt;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function reviewLatencyMs(pr: FleetPr): number | null {
  if (pr.firstReviewAt == null) return null;
  const ms = pr.firstReviewAt - pr.createdAt;
  // Negative means the timestamps are untrustworthy; drop rather than
  // invent a 0ms review.
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function durableShareOf(
  measurable: boolean,
  added: number | null,
  surviving: number | null,
): number | null {
  if (!measurable || added == null || surviving == null || added <= 0) return null;
  return surviving / added;
}

// When a thread has several PRs, prefer the merged one, then the open one,
// then the newest closed one. One thread can retry; the surviving decision
// is what the fleet view should show.
function pickThreadPr(prs: FleetPr[]): FleetPr | null {
  if (prs.length === 0) return null;
  const newer = (a: FleetPr, b: FleetPr) =>
    b.createdAt - a.createdAt || b.number - a.number;
  const merged = prs.filter((p) => p.state === "MERGED").sort(newer);
  if (merged[0]) return merged[0];
  const open = prs.filter((p) => p.state === "OPEN").sort(newer);
  if (open[0]) return open[0];
  const closed = prs.filter((p) => p.state === "CLOSED").sort(newer);
  return closed[0] ?? null;
}

function outcomeOf(pr: FleetPr): FleetOutcome {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "OPEN") return "open";
  return "closed";
}

function finishRow(row: FleetProviderRow, latencies: number[]): FleetProviderRow {
  const decided = row.prsMerged + row.prsClosedUnmerged;
  row.mergeRate = decided > 0 ? row.prsMerged / decided : 0;
  row.closeWithoutMergeRate = decided > 0 ? row.prsClosedUnmerged / decided : 0;
  // null, never Infinity / 0, when this bucket merged nothing.
  row.costPerMergedPrUsd = row.prsMerged > 0 ? row.costUsd / row.prsMerged : null;
  // Parallel runs can make activeMs > wallClockMs; do not clamp.
  row.activeShare = row.wallClockMs > 0 ? row.activeMs / row.wallClockMs : 0;
  if (row.linesAdded > 0) {
    row.durableShare = row.linesSurviving / row.linesAdded;
    row.reworkShare = 1 - row.durableShare;
  } else {
    row.durableShare = null;
    row.reworkShare = null;
  }
  row.reviewLatencyMs = median(latencies);
  return row;
}

interface ProviderBucket {
  row: FleetProviderRow;
  latencies: number[];
}

function notesOf(raw: Record<string, unknown> | null): string[] {
  if (!raw || !Array.isArray(raw.notes)) return [];
  return raw.notes.filter((n): n is string => typeof n === "string");
}

/**
 * Roll `evidence` up over the last `range` days ending at `now` (epoch ms).
 * Threads are in range by createdAt, PRs by createdAt.
 */
export function summarizeFleet(
  evidence: FleetEvidence,
  range: FleetRange,
  now: number,
): FleetSummary {
  const raw = asRecord(evidence);
  const notes = notesOf(raw);
  const windowDays = raw ? finiteNumber(raw.durabilityWindowDays) : 0;
  const durabilityWindowDays = windowDays > 0 ? windowDays : 14;
  const empty = (): FleetSummary => ({
    providers: [],
    totals: emptyProviderRow("all"),
    threads: [],
    humanReviewLatencyMs: null,
    reviewTax: null,
    durabilityWindowDays,
    notes,
  });

  if (!raw || !Number.isFinite(now) || !Number.isFinite(Number(range)) || Number(range) <= 0) {
    return empty();
  }

  // Inclusive on both ends: created exactly `range` days ago still counts.
  const start = now - Number(range) * DAY_MS;
  const threadsRaw = Array.isArray(raw.threads) ? raw.threads : [];
  const prsRaw = Array.isArray(raw.prs) ? raw.prs : [];

  const byId = new Map<string, FleetThread>();
  const inRangeThreads: FleetThread[] = [];
  for (const item of threadsRaw) {
    const thread = readThread(item);
    if (!thread || byId.has(thread.threadId)) continue;
    byId.set(thread.threadId, thread);
    if (inWindow(thread.createdAt, start, now)) inRangeThreads.push(thread);
  }

  const providers = new Map<string, ProviderBucket>();
  const bucket = (provider: string): ProviderBucket => {
    let found = providers.get(provider);
    if (!found) {
      found = { row: emptyProviderRow(provider), latencies: [] };
      providers.set(provider, found);
    }
    return found;
  };

  for (const thread of inRangeThreads) {
    const b = bucket(thread.provider);
    b.row.threads += 1;
    b.row.costUsd += thread.costUsd;
    b.row.tokens += thread.inputTokens + thread.outputTokens;
    b.row.wallClockMs += wallClockMs(thread);
    b.row.activeMs += thread.activeMs;
    if (
      thread.durabilityMeasurable &&
      thread.linesAdded != null &&
      thread.linesSurviving != null
    ) {
      b.row.linesAdded += thread.linesAdded;
      b.row.linesSurviving += thread.linesSurviving;
    }
  }

  const prsByThread = new Map<string, FleetPr[]>();
  const agentReview: number[] = [];
  const humanReview: number[] = [];
  for (const item of prsRaw) {
    const pr = readPr(item);
    if (!pr) continue;
    if (pr.threadId) {
      const list = prsByThread.get(pr.threadId);
      if (list) list.push(pr);
      else prsByThread.set(pr.threadId, [pr]);
    }
    if (!inWindow(pr.createdAt, start, now)) continue;
    const latency = reviewLatencyMs(pr);
    if (latency != null) {
      if (pr.threadId == null) humanReview.push(latency);
      else agentReview.push(latency);
    }
    if (!pr.threadId) continue;
    const owner = byId.get(pr.threadId);
    if (!owner) continue;
    const b = bucket(owner.provider);
    b.row.prsOpened += 1;
    if (pr.state === "MERGED") b.row.prsMerged += 1;
    else if (pr.state === "CLOSED") b.row.prsClosedUnmerged += 1;
    else b.row.prsOpen += 1;
    if (latency != null) b.latencies.push(latency);
  }

  inRangeThreads.sort(
    (a, b) => b.createdAt - a.createdAt || a.threadId.localeCompare(b.threadId),
  );
  const threads: FleetThreadRow[] = inRangeThreads.map((thread) => {
    const chosen = pickThreadPr(prsByThread.get(thread.threadId) ?? []);
    return {
      threadId: thread.threadId,
      title: thread.title,
      provider: thread.provider,
      costUsd: thread.costUsd,
      activeMs: thread.activeMs,
      wallClockMs: wallClockMs(thread),
      linesAdded: thread.linesAdded,
      durableShare: durableShareOf(
        thread.durabilityMeasurable,
        thread.linesAdded,
        thread.linesSurviving,
      ),
      outcome: chosen ? outcomeOf(chosen) : "none",
      prNumber: chosen ? chosen.number : null,
      prUrl: chosen ? chosen.url : null,
    };
  });

  const totals = emptyProviderRow("all");
  const allLatencies: number[] = [];
  const providerRows = [...providers.values()]
    .map(({ row, latencies }) => {
      totals.threads += row.threads;
      totals.costUsd += row.costUsd;
      totals.tokens += row.tokens;
      totals.wallClockMs += row.wallClockMs;
      totals.activeMs += row.activeMs;
      totals.prsOpened += row.prsOpened;
      totals.prsMerged += row.prsMerged;
      totals.prsClosedUnmerged += row.prsClosedUnmerged;
      totals.prsOpen += row.prsOpen;
      totals.linesAdded += row.linesAdded;
      totals.linesSurviving += row.linesSurviving;
      allLatencies.push(...latencies);
      return finishRow(row, latencies);
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.provider.localeCompare(b.provider));
  finishRow(totals, allLatencies);

  const humanReviewLatencyMs = median(humanReview);
  const agentMedian = median(agentReview);
  // Agent side is every in-range PR with a threadId, including ones we
  // could not attribute to a provider. 0/0 and x/0 are not a tax.
  const tax =
    agentMedian == null || humanReviewLatencyMs == null
      ? null
      : agentMedian / humanReviewLatencyMs;
  const reviewTax = tax != null && Number.isFinite(tax) ? tax : null;

  return {
    providers: providerRows,
    totals,
    threads,
    humanReviewLatencyMs,
    reviewTax,
    durabilityWindowDays,
    notes,
  };
}
