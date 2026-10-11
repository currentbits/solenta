/** Linked PRs on a thread (#1527). `repo` is owner/name when not this project. */
export interface PrLink {
  number: number;
  repo?: string | null;
  url?: string | null;
  state?: "OPEN" | "CLOSED" | "MERGED" | null;
  title?: string | null;
}

export function prLinkKey(link: Pick<PrLink, "number" | "repo">): string {
  return `${String(link.repo || "").trim().toLowerCase()}#${link.number}`;
}

/** True when every linked PR is CLOSED, or MERGED with settle-on-merge on. */
export function allLinkedPrsSettled(
  links: PrLink[],
  autoSettleOnMerge = true,
): boolean {
  if (links.length === 0) return false;
  return links.every((link) => {
    if (link.state === "CLOSED") return true;
    return link.state === "MERGED" && autoSettleOnMerge;
  });
}

/** True when any linked PR is still OPEN (blocks inactivity settle). */
export function anyLinkedPrOpen(links: PrLink[]): boolean {
  return links.some((link) => link.state === "OPEN");
}

export function normalizePrLink(raw: unknown): PrLink | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const number = Number(row.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const link: PrLink = { number };
  if (row.repo != null && String(row.repo).trim()) {
    link.repo = String(row.repo).trim();
  }
  if (row.url != null && String(row.url).trim()) {
    link.url = String(row.url).trim();
  }
  const state = String(row.state || "").toUpperCase();
  if (state === "OPEN" || state === "CLOSED" || state === "MERGED") {
    link.state = state;
  }
  if (row.title != null && String(row.title).trim()) {
    link.title = String(row.title).trim();
  }
  return link;
}

/**
 * Linked PRs for a thread. Falls back to the legacy `prNumber` row so
 * older threads keep working without a store rewrite.
 */
export function normalizePrLinks(thread: {
  prNumber?: number | null;
  prUrl?: string | null;
  prState?: "OPEN" | "CLOSED" | "MERGED" | null;
  prLinks?: unknown;
}): PrLink[] {
  const raw = Array.isArray(thread.prLinks) ? thread.prLinks : [];
  const out: PrLink[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const link = normalizePrLink(row);
    if (!link) continue;
    const key = prLinkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  const primary = Number(thread.prNumber);
  if (Number.isInteger(primary) && primary > 0) {
    const key = prLinkKey({ number: primary });
    const sameRepo = out.find((l) => prLinkKey({ number: l.number, repo: l.repo }) === key);
    if (!sameRepo) {
      const fromOtherRepo = out.find((l) => l.number === primary && l.repo);
      if (!fromOtherRepo) {
        out.unshift(
          normalizePrLink({
            number: primary,
            url: thread.prUrl,
            state: thread.prState,
          })!,
        );
      }
    }
  }
  return out;
}

export function upsertPrLink(links: PrLink[], next: PrLink): PrLink[] {
  const key = prLinkKey(next);
  const out = links.filter((l) => prLinkKey(l) !== key);
  const existing = links.find((l) => prLinkKey(l) === key);
  out.push({ ...existing, ...next, number: next.number });
  return out;
}
