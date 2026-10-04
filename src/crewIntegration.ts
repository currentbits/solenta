/** Crew worker flag. Missing on a legacy summary is unknown, not a worker. */
export function isOrchWorker(
  row: { orchWorker?: boolean } | null | undefined,
): boolean {
  return row?.orchWorker === true;
}

/** False only when both sides name a project and they differ. */
export function sameCrewProject(
  a: { projectId?: string } | null | undefined,
  b: { projectId?: string } | null | undefined,
): boolean {
  if (a?.projectId && b?.projectId && a.projectId !== b.projectId) return false;
  return true;
}

/**
 * Direct crew child of parent. Requires orchWorker === true and matching
 * handoffFrom. A known projectId that differs is malformed and excluded;
 * a missing projectId is not treated as cross-project. Archived rows stay
 * eligible: list and summaries both keep them.
 */
export function isDirectCrewChild(
  child: {
    orchWorker?: boolean;
    handoffFrom?: string | null;
    projectId?: string;
  },
  parent: { id: string; projectId?: string },
): boolean {
  if (!isOrchWorker(child) || child.handoffFrom !== parent.id) return false;
  return sameCrewProject(child, parent);
}

/** Worker-header Merge button: names the recorded base, never "Merge worktree". */
export function mergeOntoLabel(baseBranch: string | null | undefined): string {
  return `Merge onto ${baseBranch || "repo default"}`;
}

export function formatSourceSha(sha: string | null | undefined): string {
  if (!sha) return "unknown";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** Source branch plus short SHA for worker details and the lead list (#948). */
export function sourceSnapshotLabel(
  branch: string | null | undefined,
  sha: string | null | undefined,
): string {
  const short = formatSourceSha(sha);
  const name = typeof branch === "string" ? branch.trim() : "";
  return name ? `${name} ${short}` : short;
}
