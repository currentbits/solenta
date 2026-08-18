/**
 * Pull-request UI decisions. Pure so they can be tested without a DOM.
 *
 * Rules this encodes:
 * 1. Sidebar badge links only when prUrl is set; never invent a URL.
 * 2. PR creation is delegated to the thread's agent via createPrPrompt.
 * 3. The PR-size-cap refusal (issue #402) is recognized by message prefix so
 *    the header can offer the split-into-stack prompt instead of a bare error.
 */

export interface SidebarPrBadge {
  label: string;
  /** null when the thread has a number but no outbound URL yet. */
  href: string | null;
}

/** PR chip for the sidebar thread card. Null when there is no PR number. */
export function sidebarPrBadge(input: {
  prNumber: number | null;
  prUrl: string | null;
}): SidebarPrBadge | null {
  if (input.prNumber == null) return null;
  const href =
    input.prUrl != null && input.prUrl.trim() !== "" ? input.prUrl : null;
  return { label: `PR #${input.prNumber}`, href };
}

/** Prompt sent to the agent when the user clicks Create PR. */
export function createPrPrompt(agentName: string): string {
  return [
    "Push the current branch and open a pull request for the work in this thread.",
    "Write a clear, specific PR title and a description that summarizes what changed and why.",
    `End the description with this exact bullet on its own line: "- PR created by the ${agentName} agent".`,
    "Use the gh CLI (gh pr create). If this branch already has an open PR, update its title and description instead (gh pr edit).",
  ].join("\n");
}

/**
 * Stable prefix of the main-process oversize error (issue #402). Must match
 * PR_TOO_LARGE_PREFIX in electron/worktrees.js — the two processes share no
 * module, so the contract is the string itself.
 */
export const PR_TOO_LARGE_PREFIX = "PR too large";

/** True when a createPr rejection is the PR-size-cap refusal, not a failure. */
export function isPrTooLargeMessage(message: string): boolean {
  return message.startsWith(`${PR_TOO_LARGE_PREFIX}:`);
}

/**
 * Prompt sent to the agent when a PR is refused for exceeding the size cap:
 * the auto-split path of issue #402. The agent restacks the branch into a
 * stack of smaller PRs (stacked PRs land properly with #240).
 */
export function splitPrPrompt(agentName: string): string {
  return [
    "Opening a pull request for this branch was refused: the diff exceeds the configured PR size cap (default 400 changed lines).",
    "Split the work into a stack of smaller, independently reviewable PRs:",
    "1. Group the changes into coherent slices by concern (not by file), each comfortably under the cap.",
    "2. Restack the branch into one branch per slice, each based on the previous slice's branch (a stacked-PR chain back to the base branch).",
    "3. Push each branch and open its PR with the gh CLI, oldest slice first (gh pr create --base <previous-slice-branch>).",
    "Write a clear, specific title and description per PR, noting its position in the stack (e.g. \"stack 2/3, based on #123\").",
    `End each PR description with this exact bullet on its own line: "- PR created by the ${agentName} agent".`,
  ].join("\n");
}
