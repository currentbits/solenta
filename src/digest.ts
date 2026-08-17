/**
 * Morning digest ranking (issue #323). Pure: raw evidence in (DigestRun[]),
 * one ranked receipt out. Autonomy should come with a receipt — so the
 * discard pile, and what it cost, is a first-class number here rather than
 * something the reader has to infer from a green dashboard.
 */
import type { DigestRun } from "./shared/ipc";

export type { DigestRun };

export type DigestBucket = "merge-ready" | "needs-you" | "discard";

/** Reading order of the receipt: act, then unblock, then write off. */
export const DIGEST_BUCKETS: DigestBucket[] = [
  "merge-ready",
  "needs-you",
  "discard",
];

const BUCKET_LABEL: Record<DigestBucket, string> = {
  "merge-ready": "Merge-ready",
  "needs-you": "Needs you",
  discard: "Discard",
};

/** A diff this big is a review job, not a glance. */
export const RISK_LINES = 500;
/** Touching this many files is a blast radius worth naming. */
export const RISK_FILES = 20;

export interface DigestEntry {
  run: DigestRun;
  bucket: DigestBucket;
  /** One line: why this landed in this bucket. */
  reason: string;
  /** Risk flags, worst first; empty when nothing stands out. */
  risks: string[];
}

export interface DigestGroup {
  bucket: DigestBucket;
  label: string;
  entries: DigestEntry[];
  costUsd: number;
}

export interface DigestSummary {
  /** All three buckets, always, in DIGEST_BUCKETS order (may be empty). */
  groups: DigestGroup[];
  runs: number;
  costUsd: number;
  /** What the discard pile cost — the "burned for nothing" number. */
  wastedUsd: number;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function produced(run: DigestRun): boolean {
  return (
    num(run.filesChanged) > 0 ||
    num(run.commits) > 0 ||
    run.prNumber != null
  );
}

function classify(run: DigestRun): { bucket: DigestBucket; reason: string } {
  if (run.awaitingInput) {
    return { bucket: "needs-you", reason: "stalled on a prompt nobody answered" };
  }
  if (run.status === "failed" || run.lastError) {
    return { bucket: "needs-you", reason: run.lastError || "run failed" };
  }
  if (run.checks.failed) {
    return {
      bucket: "needs-you",
      reason: `${run.checks.label || "checks"} failed`,
    };
  }
  if (!produced(run)) {
    return { bucket: "discard", reason: "no changes, no commits, no PR" };
  }
  if (run.prState === "MERGED") {
    return { bucket: "merge-ready", reason: "PR merged" };
  }
  if (run.prNumber != null) {
    return { bucket: "merge-ready", reason: `PR #${run.prNumber} open` };
  }
  const lines = num(run.additions) + num(run.deletions);
  const files = num(run.filesChanged);
  if (files > 0) {
    return {
      bucket: "merge-ready",
      reason: `${files} file${files === 1 ? "" : "s"} changed, ${lines} line${lines === 1 ? "" : "s"}`,
    };
  }
  const commits = num(run.commits);
  return {
    bucket: "merge-ready",
    reason: `${commits} commit${commits === 1 ? "" : "s"} on the branch`,
  };
}

function risksOf(run: DigestRun, bucket: DigestBucket): string[] {
  const risks: string[] = [];
  if (run.checks.failed) risks.push(`${run.checks.label || "checks"} failed`);
  if (run.awaitingInput) risks.push("waited on input, work may be half-done");
  if (bucket === "discard") {
    if (num(run.costUsd) > 0) risks.push("spent, produced nothing");
  } else if (!run.checks.ran) {
    // The #296 wound: "done" without a command that proves it.
    risks.push("no test evidence");
  }
  const lines = num(run.additions) + num(run.deletions);
  if (lines > RISK_LINES) risks.push(`large diff (${lines} lines)`);
  if (num(run.filesChanged) > RISK_FILES) {
    risks.push(`touches ${num(run.filesChanged)} files`);
  }
  if (num(run.filesChanged) > 0 && num(run.commits) === 0) {
    risks.push("uncommitted");
  }
  return risks;
}

/** Costliest first, then newest — the expensive surprise reads first. */
function compare(a: DigestEntry, b: DigestEntry): number {
  const cost = num(b.run.costUsd) - num(a.run.costUsd);
  if (cost !== 0) return cost;
  const ended = num(b.run.endedAt) - num(a.run.endedAt);
  if (ended !== 0) return ended;
  return a.run.threadId < b.run.threadId ? -1 : 1;
}

/** Rank one unattended window's runs into the three-bucket receipt. */
export function summarizeDigest(runs: readonly DigestRun[]): DigestSummary {
  const list = Array.isArray(runs) ? runs : [];
  const groups: DigestGroup[] = DIGEST_BUCKETS.map((bucket) => ({
    bucket,
    label: BUCKET_LABEL[bucket],
    entries: [],
    costUsd: 0,
  }));
  const byBucket = new Map(groups.map((group) => [group.bucket, group]));
  const summary: DigestSummary = { groups, runs: 0, costUsd: 0, wastedUsd: 0 };

  for (const run of list) {
    if (!run || typeof run !== "object") continue;
    const checks = run.checks ?? { ran: false, failed: false, label: null };
    const safe: DigestRun = { ...run, checks };
    const { bucket, reason } = classify(safe);
    const group = byBucket.get(bucket)!;
    group.entries.push({ run: safe, bucket, reason, risks: risksOf(safe, bucket) });
    const cost = num(safe.costUsd);
    group.costUsd += cost;
    summary.costUsd += cost;
    summary.runs += 1;
    if (bucket === "discard") summary.wastedUsd += cost;
  }

  for (const group of groups) group.entries.sort(compare);
  return summary;
}

/** "$1.23", "$0.04", "$0" — receipts round to cents, never to nothing. */
export function formatUsd(value: number): string {
  const n = num(value);
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Headline for the window: "6 runs · $4.12 · $1.80 wasted". */
export function digestHeadline(summary: DigestSummary): string {
  const parts = [
    `${summary.runs} run${summary.runs === 1 ? "" : "s"}`,
    formatUsd(summary.costUsd),
  ];
  if (summary.wastedUsd > 0) parts.push(`${formatUsd(summary.wastedUsd)} wasted`);
  return parts.join(" · ");
}
