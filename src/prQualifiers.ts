/**
 * Query qualifiers for the PR list search box (issue #1795 feature 4):
 * `author:<login|@me>`, `label:<name>` (repeatable), `is:draft|open|merged|closed`,
 * `review:required|approved|changes_requested`, `head:<branch>`. Anything
 * else in the query stays free text for the existing number/title/branch
 * search (prMatchesQuery in prList.ts).
 */
import type { PrListItem } from "./shared/ipc";

export type PrQualifierKind = "author" | "label" | "is" | "review" | "head";

export interface PrQualifier {
  kind: PrQualifierKind;
  /** Value as typed (case preserved for author/label/head). */
  value: string;
  /** The exact `key:value` token consumed from the query, for chips. */
  token: string;
}

const IS_VALUES = new Set(["draft", "open", "merged", "closed"]);
const REVIEW_VALUES = new Set(["required", "approved", "changes_requested"]);

export interface ParsedPrQuery {
  qualifiers: PrQualifier[];
  /** Remaining words, still fed to prMatchesQuery. */
  text: string;
}

/** Split a query into recognized qualifiers and the leftover free text. */
export function parsePrQuery(raw: string): ParsedPrQuery {
  const qualifiers: PrQualifier[] = [];
  const words: string[] = [];
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = token.match(/^(author|label|is|review|head):(.+)$/i);
    if (!m) {
      words.push(token);
      continue;
    }
    const kind = m[1].toLowerCase() as PrQualifierKind;
    const value = m[2];
    const lower = value.toLowerCase();
    if (kind === "is" && !IS_VALUES.has(lower)) {
      words.push(token);
      continue;
    }
    if (kind === "review" && !REVIEW_VALUES.has(lower)) {
      words.push(token);
      continue;
    }
    qualifiers.push({ kind, value, token });
  }
  return { qualifiers, text: words.join(" ") };
}

/** Remove one chip's token from the raw query string, verbatim. */
export function removePrQualifier(raw: string, qualifier: PrQualifier): string {
  return raw
    .split(/\s+/)
    .filter((word) => word !== qualifier.token)
    .join(" ");
}

const REVIEW_DECISION_BY_VALUE: Record<string, PrListItem["reviewDecision"]> = {
  required: "REVIEW_REQUIRED",
  approved: "APPROVED",
  changes_requested: "CHANGES_REQUESTED",
};

/** Does one listed PR satisfy every parsed qualifier? */
export function prMatchesQualifiers(
  pr: Pick<PrListItem, "state" | "isDraft" | "reviewDecision" | "headRefName" | "author" | "labels">,
  qualifiers: readonly PrQualifier[],
  viewerLogin: string | null,
): boolean {
  for (const q of qualifiers) {
    if (q.kind === "author") {
      const want = q.value.toLowerCase() === "@me" ? viewerLogin : q.value;
      if (!want || !pr.author || pr.author.toLowerCase() !== want.toLowerCase()) return false;
    } else if (q.kind === "label") {
      const lower = q.value.toLowerCase();
      if (!(pr.labels || []).some((l) => l.toLowerCase() === lower)) return false;
    } else if (q.kind === "is") {
      const lower = q.value.toLowerCase();
      if (lower === "draft") {
        if (!pr.isDraft) return false;
      } else if (pr.state.toLowerCase() !== lower) {
        return false;
      }
    } else if (q.kind === "review") {
      if (pr.reviewDecision !== REVIEW_DECISION_BY_VALUE[q.value.toLowerCase()]) return false;
    } else if (q.kind === "head") {
      if (pr.headRefName.toLowerCase() !== q.value.toLowerCase()) return false;
    }
  }
  return true;
}
