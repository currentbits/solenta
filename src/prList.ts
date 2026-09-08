/**
 * Pure grouping / matching for the pull-requests list view.
 */

/** First-page size for the PR view; matches listPrsRaw's historic default. */
export const PR_LIST_PAGE_SIZE = 50;
/** Hard cap for bounded Load more. listPrsRaw callers (Fleet) are uncapped. */
export const PR_LIST_MAX_LIMIT = 200;
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
  /** False when gh returned a full page and more open PRs may exist. */
  complete: boolean;
  /** Requested `gh pr list --limit` for this page. */
  limit: number;
}

export interface PrGroupErr {
  project: ProjectInfo;
  ok: false;
  reason: string;
}

export type PrGroup = PrGroupOk | PrGroupErr;

/** Match a listed PR to a thread in the same project by number, then branch. */
export function matchThreadForPr(
  pr: Pick<PrListItem, "number" | "headRefName">,
  threads: readonly ThreadInfo[],
  projectId: string,
): ThreadInfo | null {
  const inProject = threads.filter((t) => t.projectId === projectId);
  const byNumber = inProject.find((t) => t.prNumber === pr.number);
  if (byNumber) return byNumber;
  const branch = pr.headRefName;
  if (!branch) return null;
  return inProject.find((t) => t.branch === branch) ?? null;
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
    return {
      project,
      ok: true,
      prs: result.prs,
      complete: result.complete ?? true,
      limit: result.limit ?? result.prs.length,
    };
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

/** Match a listed PR by number, title, or head branch. Blank query matches. */
export function prMatchesQuery(
  pr: Pick<PrListItem, "number" | "title" | "headRefName">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const numberText = String(pr.number);
  if (q === numberText || q === `#${numberText}`) return true;
  if (q.startsWith("#") && q.slice(1) === numberText) return true;
  if (pr.title.toLowerCase().includes(q)) return true;
  if (pr.headRefName.toLowerCase().includes(q)) return true;
  return false;
}

/** Narrow groups by project id and/or local query. Failed groups stay visible. */
export function filterPrGroups(
  groups: readonly PrGroup[],
  opts: { query?: string; projectId?: string | null },
): PrGroup[] {
  const projectId = opts.projectId || null;
  const query = opts.query ?? "";
  return groups
    .filter((group) => !projectId || group.project.id === projectId)
    .map((group) => {
      if (!group.ok) return group;
      return {
        ...group,
        prs: group.prs.filter((row) => prMatchesQuery(row, query)),
      };
    });
}
