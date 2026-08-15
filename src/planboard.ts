/**
 * Planboard columns derived from GitHub issue plan:* labels. Read-only:
 * agents move issues by editing labels / closing on GitHub, never from here.
 */
import type { PlanIssue } from "./shared/ipc";

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

/** Todo / In progress / Done, each newest-updated first. */
export function planColumns(issues: readonly PlanIssue[]): PlanColumn[] {
  const buckets: Record<PlanColumnId, PlanIssue[]> = {
    todo: [],
    doing: [],
    done: [],
  };
  for (const issue of issues) {
    buckets[planColumnFor(issue)].push(issue);
  }
  return COLUMN_ORDER.map(({ id, title }) => ({
    id,
    title,
    issues: buckets[id]
      .slice()
      .sort((a, b) => (issueUpdatedMs(b) ?? 0) - (issueUpdatedMs(a) ?? 0)),
  }));
}

export function isPlanEmpty(columns: readonly PlanColumn[]): boolean {
  return columns.every((c) => c.issues.length === 0);
}
