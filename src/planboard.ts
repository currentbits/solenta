/**
 * Planboard columns derived from GitHub issue plan:* labels. Read-only:
 * agents move issues by editing labels / closing on GitHub, never from here.
 */
import type { PlanIssue, PrListItem } from "./shared/ipc";

export type PlanColumnId = "todo" | "doing" | "done";

export interface PlanColumn {
  id: PlanColumnId;
  title: string;
  issues: PlanIssue[];
}

const COLUMN_ORDER: { id: PlanColumnId; title: string }[] = [
  { id: "todo", title: "Todo" },
  { id: "doing", title: "In progress" },
  { id: "done", title: "Done" },
];

/** plan:done label or closed state → done; plan:doing → doing; else todo. */
export function planColumnFor(issue: PlanIssue): PlanColumnId {
  if (issue.state === "CLOSED" || issue.labels.includes("plan:done")) {
    return "done";
  }
  if (issue.labels.includes("plan:doing")) return "doing";
  return "todo";
}

/** Labels worth badging on a card: everything except the plan:* status. */
export function badgeLabels(issue: PlanIssue): string[] {
  return issue.labels.filter((l) => !l.startsWith("plan:"));
}

/** Parse gh's ISO updatedAt; null when missing or malformed. */
export function issueUpdatedMs(issue: PlanIssue): number | null {
  if (!issue.updatedAt) return null;
  const ms = Date.parse(issue.updatedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse gh's ISO createdAt; null when missing or malformed. */
export function issueCreatedMs(issue: PlanIssue): number | null {
  if (!issue.createdAt) return null;
  const ms = Date.parse(issue.createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Board ordering inside each column. "updated" is the default; the others
 * answer "what is oldest/what did I add recently" without leaving the board.
 */
export type PlanSort = "updated" | "number-asc" | "created-desc" | "created-asc";

/** Issues without a date sort last, whichever direction was picked. */
function compareIssues(sort: PlanSort) {
  return (a: PlanIssue, b: PlanIssue): number => {
    switch (sort) {
      case "number-asc":
        return a.number - b.number;
      case "created-desc":
        return (issueCreatedMs(b) ?? 0) - (issueCreatedMs(a) ?? 0);
      case "created-asc":
        return (issueCreatedMs(a) ?? Infinity) - (issueCreatedMs(b) ?? Infinity);
      default:
        return (issueUpdatedMs(b) ?? 0) - (issueUpdatedMs(a) ?? 0);
    }
  };
}

/**
 * Done is every issue ever closed, so it is capped to the most recent few.
 * Todo and In progress are the live backlog and are never truncated.
 */
const DONE_COLUMN_CAP = 25;

/** Todo / In progress / Done, each ordered by the chosen sort. */
export function planColumns(
  issues: readonly PlanIssue[],
  sort: PlanSort = "updated",
): PlanColumn[] {
  const buckets: Record<PlanColumnId, PlanIssue[]> = {
    todo: [],
    doing: [],
    done: [],
  };
  for (const issue of issues) {
    buckets[planColumnFor(issue)].push(issue);
  }
  const compare = compareIssues(sort);
  return COLUMN_ORDER.map(({ id, title }) => {
    const sorted = buckets[id].slice().sort(compare);
    return {
      id,
      title,
      issues: id === "done" ? sorted.slice(0, DONE_COLUMN_CAP) : sorted,
    };
  });
}

export function isPlanEmpty(columns: readonly PlanColumn[]): boolean {
  return columns.every((c) => c.issues.length === 0);
}

/**
 * Review-load meter (issue #402): an orchestrator that parallelizes agents
 * manufactures review bottleneck, so the planboard shows how much human
 * review capacity the open PR queue already consumes.
 */
export type ReviewLoadLevel = "ok" | "busy" | "overloaded";

export interface ReviewLoad {
  /** Open, non-draft PRs awaiting review. */
  openPrs: number;
  /** Combined additions + deletions across those PRs. */
  totalLines: number;
  level: ReviewLoadLevel;
}

/**
 * Thresholds tied to the 400-line PR cap: three cap-sized PRs (~1200 lines)
 * are a comfortable queue; past that the human reviewer is the bottleneck.
 */
export const REVIEW_LOAD_BUSY_PRS = 4;
export const REVIEW_LOAD_BUSY_LINES = 1200;
export const REVIEW_LOAD_OVERLOADED_PRS = 7;
export const REVIEW_LOAD_OVERLOADED_LINES = 2400;

/** Aggregate open, non-draft PRs into a review-load reading. */
export function reviewLoad(prs: readonly PrListItem[]): ReviewLoad {
  let openPrs = 0;
  let totalLines = 0;
  for (const pr of prs) {
    // Drafts are still being built by the agent; they do not consume
    // reviewer attention yet.
    if (pr.state !== "OPEN" || pr.isDraft) continue;
    openPrs += 1;
    totalLines += (pr.additions ?? 0) + (pr.deletions ?? 0);
  }
  const level: ReviewLoadLevel =
    openPrs >= REVIEW_LOAD_OVERLOADED_PRS ||
    totalLines > REVIEW_LOAD_OVERLOADED_LINES
      ? "overloaded"
      : openPrs >= REVIEW_LOAD_BUSY_PRS || totalLines > REVIEW_LOAD_BUSY_LINES
        ? "busy"
        : "ok";
  return { openPrs, totalLines, level };
}

/** Compact line count for the meter label: 950 → "950", 1600 → "1.6k". */
export function formatLineCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? String(Math.round(k)) : k.toFixed(1)}k`;
}
