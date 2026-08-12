/**
 * Pure grouping / matching for the pull-requests list view.
 */
import type {
  ListPrsResult,
  PrListItem,
  ProjectInfo,
  ThreadInfo,
} from "./shared/ipc";

export interface PrGroupOk {
  project: ProjectInfo;
  ok: true;
  prs: PrListItem[];
}

export interface PrGroupErr {
  project: ProjectInfo;
  ok: false;
  reason: string;
}

export type PrGroup = PrGroupOk | PrGroupErr;

/** Match a listed PR to a thread in the same project by head branch. */
export function matchThreadForPr(
  pr: Pick<PrListItem, "headRefName">,
  threads: readonly ThreadInfo[],
  projectId: string,
): ThreadInfo | null {
  const branch = pr.headRefName;
  if (!branch) return null;
  return (
    threads.find((t) => t.projectId === projectId && t.branch === branch) ??
    null
  );
}

/** One section per project, in project list order. Missing results are errors. */
export function groupPrsByProject(
  projects: readonly ProjectInfo[],
  results: ReadonlyMap<string, ListPrsResult>,
): PrGroup[] {
  return projects.map((project) => {
    const result = results.get(project.id);
    if (!result) {
      return { project, ok: false, reason: "unknown" };
    }
    if (!result.ok) {
      return { project, ok: false, reason: result.reason };
    }
    return { project, ok: true, prs: result.prs };
  });
}

/** True when every project loaded and none has an open PR. */
export function allPrsEmpty(groups: readonly PrGroup[]): boolean {
  return groups.length > 0 && groups.every((g) => g.ok && g.prs.length === 0);
}

/** `+12 -3` when both counts are known; otherwise null. */
export function formatPrDiff(pr: PrListItem): string | null {
  if (pr.additions == null || pr.deletions == null) return null;
  if (!Number.isFinite(pr.additions) || !Number.isFinite(pr.deletions)) {
    return null;
  }
  return `+${pr.additions} -${pr.deletions}`;
}

/** Parse gh's ISO updatedAt; null when missing or malformed. */
export function prUpdatedMs(pr: PrListItem): number | null {
  if (!pr.updatedAt) return null;
  const ms = Date.parse(pr.updatedAt);
  return Number.isFinite(ms) ? ms : null;
}
