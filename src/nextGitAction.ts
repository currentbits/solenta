/**
 * Suggested next git step for a thread (issue #382).
 *
 * Pure so the header button and the suite share one decision table.
 * Procedural: what to do next, not what is broken.
 */
import type { GitSyncInfo, PrChecksResult } from "./shared/ipc";

export type NextGitActionKind =
  | "commit"
  | "push"
  | "create-pr"
  | "watch-checks"
  | "checks-failed"
  | "merge"
  | "idle";

export interface NextGitAction {
  kind: NextGitActionKind;
  label: string;
  title: string;
  actionable: boolean;
  primary: boolean;
  href?: string | null;
}

export interface NextGitActionInput {
  dirty: boolean;
  fileCount?: number;
  /** null while sync has not loaded (or is unwired). */
  sync: GitSyncInfo | null;
  hasWorktree: boolean;
  remoteProject?: boolean;
  prNumber: number | null;
  prUrl?: string | null;
  prState: "OPEN" | "CLOSED" | "MERGED" | null;
  /**
   * Live GitHub mergeability from `gh pr view --json mergeable`.
   * CONFLICTING means the header should say Update from main, not Merge.
   */
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  /** null until fetched, or when there is no open PR. */
  checks: PrChecksResult | null;
}

const IDLE: NextGitAction = {
  kind: "idle",
  label: "",
  title: "",
  actionable: false,
  primary: false,
};

export function summarizeChecks(checks: { bucket: string }[]): {
  pass: number;
  fail: number;
  pending: number;
  total: number;
} {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const check of checks) {
    if (check.bucket === "pass" || check.bucket === "skipping") pass += 1;
    else if (check.bucket === "fail" || check.bucket === "cancel") fail += 1;
    else pending += 1;
  }
  return { pass, fail, pending, total: checks.length };
}

function hrefOf(url: string | null | undefined): string | null {
  if (url == null) return null;
  const trimmed = url.trim();
  return trimmed === "" ? null : trimmed;
}

function pushAction(sync: GitSyncInfo): NextGitAction {
  if (sync.hasUpstream && sync.ahead > 0) {
    const ahead = sync.ahead;
    return {
      kind: "push",
      label: "Push",
      title:
        ahead === 1
          ? "Push 1 commit to origin"
          : `Push ${ahead} commits to origin`,
      actionable: true,
      primary: true,
    };
  }
  return {
    kind: "push",
    label: "Push",
    title: "Push this branch to origin",
    actionable: true,
    primary: true,
  };
}

function createPrAction(sync: GitSyncInfo | null): NextGitAction {
  const needsPush = sync == null || !sync.hasUpstream || sync.ahead > 0;
  return {
    kind: "create-pr",
    label: "Create PR",
    title: needsPush
      ? "Push this branch and open a pull request"
      : "Open a pull request for this branch",
    actionable: true,
    primary: true,
  };
}

/** Branch still needs a push before an existing PR can see new commits. */
function needsPushForOpenPr(
  sync: GitSyncInfo,
  hasWorktree: boolean,
): boolean {
  if (sync.hasUpstream) return sync.ahead > 0;
  return hasWorktree;
}

/**
 * Next git step for the thread header.
 *
 * Create PR is not gated on a prior Push or a loaded sync: `git.createPr`
 * already pushes (issue #503). Push stays only for an existing open PR
 * that is ahead of origin. `sync == null` on a worktree still offers
 * Create PR so a failed or pending sync does not blank the header.
 */
export function suggestNextGitAction(input: NextGitActionInput): NextGitAction {
  if (input.remoteProject) return IDLE;

  if (input.dirty) {
    const n = input.fileCount ?? 0;
    return {
      kind: "commit",
      label: n > 0 ? `Commit ${n} file${n === 1 ? "" : "s"}` : "Commit",
      title: "Review and commit uncommitted changes",
      actionable: true,
      primary: true,
    };
  }

  if (input.prState === "MERGED" || input.prState === "CLOSED") {
    return IDLE;
  }

  const openPr = input.prNumber != null;
  if (openPr) {
    if (input.sync && needsPushForOpenPr(input.sync, input.hasWorktree)) {
      return pushAction(input.sync);
    }
    const href = hrefOf(input.prUrl);
    if (input.checks == null) {
      return {
        kind: "watch-checks",
        label: "Checking…",
        title: "Loading CI checks",
        actionable: false,
        primary: false,
        href,
      };
    }
    if (!input.checks.ok) {
      return {
        kind: "watch-checks",
        label: "Retry checks",
        title: input.checks.reason,
        actionable: true,
        primary: false,
        href,
      };
    }
    const summary = summarizeChecks(input.checks.checks);
    if (summary.pending > 0) {
      return {
        kind: "watch-checks",
        label:
          summary.total > 0
            ? `Checks ${summary.pass}/${summary.total}`
            : "Watching checks",
        title: `${summary.pending} check${summary.pending === 1 ? "" : "s"} still running`,
        actionable: true,
        primary: false,
        href,
      };
    }
    if (summary.fail > 0) {
      return {
        kind: "checks-failed",
        label: "Checks failed",
        title: `${summary.fail} check${summary.fail === 1 ? "" : "s"} failed`,
        actionable: true,
        primary: false,
        href,
      };
    }
    if (input.mergeable === "CONFLICTING") {
      return {
        kind: "merge",
        label: "Update from main",
        title: "Merge the base branch into this PR, then squash-merge",
        actionable: true,
        primary: true,
      };
    }
    return {
      kind: "merge",
      label: `Merge PR #${input.prNumber}`,
      title: "Squash-merge this pull request",
      actionable: true,
      primary: true,
    };
  }

  // Typical Solenta worktree, or any published branch: ship it.
  // Main checkout with no upstream stays idle (do not invent a first push).
  if (input.hasWorktree || input.sync?.hasUpstream) {
    return createPrAction(input.sync);
  }

  return IDLE;
}
