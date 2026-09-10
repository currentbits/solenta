import type { CrewIntegrationState } from "./shared/ipc";

/** Header path on the lead Integration section. */
export function integrationPathLabel(
  leadBranch: string | null,
  finalTarget: string,
): string {
  return `Workers → ${leadBranch || "lead worktree"} → ${finalTarget}`;
}

/** Worker-header Merge button: names the recorded base, never "Merge worktree". */
export function mergeOntoLabel(baseBranch: string | null | undefined): string {
  return `Merge onto ${baseBranch || "repo default"}`;
}

/** Per-row staging action. Always the lead branch, never the final target. */
export function integrateIntoLabel(leadBranch: string | null): string {
  return `Integrate into ${leadBranch || "lead worktree"}`;
}

/** Final landing on the combined lead commit. Separate click from Integrate. */
export function mergeIntoLabel(finalTarget: string): string {
  return `Merge into ${finalTarget}`;
}

export function crewIntegrationStateLabel(state: CrewIntegrationState): string {
  switch (state) {
    case "running":
      return "Running";
    case "ready":
      return "Ready for review";
    case "conflicted":
      return "Conflicted";
    case "integrated":
      return "Integrated";
    case "landed":
      return "Landed";
    case "missing":
      return "Missing";
  }
}

export function moveWorkerOrder(
  ids: string[],
  id: string,
  dir: -1 | 1,
): string[] {
  const i = ids.indexOf(id);
  if (i < 0) return ids;
  const j = i + dir;
  if (j < 0 || j >= ids.length) return ids;
  const next = ids.slice();
  const swap = next[i]!;
  next[i] = next[j]!;
  next[j] = swap;
  return next;
}

export function canIntegrateRow(
  row: { state: CrewIntegrationState; blocked: boolean },
  hasLeadWorktree: boolean,
): boolean {
  if (!hasLeadWorktree || row.blocked) return false;
  return row.state === "ready" || row.state === "integrated";
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
