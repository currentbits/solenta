/**
 * Pull-request UI decisions. Pure so they can be tested without a DOM.
 *
 * Rules this encodes:
 * 1. Sidebar badge links only when prUrl is set; never invent a URL.
 * 2. The Git-tab form is hidden once a PR is known (live status or thread fields).
 * 3. Create is disabled without a branch, a non-empty title, or while busy.
 * 4. Live prStatus wins over stale thread.prNumber/prUrl when present.
 */
import type { PrInfo } from "./shared/ipc";

export type PrState = PrInfo["state"];

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

export interface ExistingPrView {
  number: number;
  url: string | null;
  state: PrState | null;
  branch: string;
  title?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface PrCardView {
  /** Resolved current PR, or null when none is known. */
  existing: ExistingPrView | null;
  /** Show the create form (no known PR). */
  showForm: boolean;
  /** Create button may be clicked. */
  canCreate: boolean;
}

/**
 * Git-tab PR card presentation from thread fields + optional live prStatus.
 * Pass live as undefined when status has not been loaded yet; null means
 * "loaded, no PR"; a PrInfo means a known PR.
 */
export function prCardView(input: {
  branch: string | null;
  threadPrNumber: number | null;
  threadPrUrl: string | null;
  /** undefined = not loaded; null = loaded empty; PrInfo = known. */
  live: PrInfo | null | undefined;
  titleDraft: string;
  busy: boolean;
}): PrCardView {
  let existing: ExistingPrView | null = null;

  if (input.live !== undefined && input.live !== null) {
    existing = {
      number: input.live.number,
      url: input.live.url,
      state: input.live.state,
      branch: input.live.branch,
    };
    if (input.live.title != null) existing.title = input.live.title;
    if (input.live.additions != null) existing.additions = input.live.additions;
    if (input.live.deletions != null) existing.deletions = input.live.deletions;
    if (input.live.changedFiles != null) {
      existing.changedFiles = input.live.changedFiles;
    }
  } else if (input.live === undefined && input.threadPrNumber != null) {
    // Prefer thread fields only until live status has been fetched.
    existing = {
      number: input.threadPrNumber,
      url: input.threadPrUrl,
      state: null,
      branch: input.branch ?? "",
    };
  }
  // live === null: confirmed absent, even if thread still carries stale fields.

  // A CLOSED or MERGED PR is history, not the current one: createPr will open a
  // follow-up, so the form must stay available or the backend fix is
  // unreachable. state === null means status has not loaded yet, and that is
  // NOT a reason to offer a second PR.
  const showForm = existing == null || existing.state === "CLOSED" || existing.state === "MERGED";
  const canCreate =
    showForm &&
    !input.busy &&
    Boolean(input.branch && input.branch.length > 0) &&
    input.titleDraft.trim().length > 0;

  return { existing, showForm, canCreate };
}
