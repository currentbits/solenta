/**
 * Pull-request UI decisions. Pure so they can be tested without a DOM.
 *
 * Rules this encodes:
 * 1. Sidebar badge links only when prUrl is set; never invent a URL.
 * 2. PR creation is delegated to the thread's agent via createPrPrompt.
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
