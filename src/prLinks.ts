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

// Older parseRepoSlug stored the last two URL segments, e.g. "pull/1838" (#1842).
const MALFORMED_REPO = /^(pull|merge_requests)\/\d+$/i;

function repoFromPath(pathname: string): string | null {
  const p = pathname
    .replace(/\/-\/.*$/, "")
    .replace(/\/(?:pull|issues)\/\d+(?:\/.*)?$/, "")
    .replace(/\.git$/i, "");
  const parts = p.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.join("/") : null;
}

/**
 * owner/repo from a slug, remote URL, or PR/MR URL. GitLab subgroups keep
 * the full path (group/sub/repo). Mirrors electron/prLinks.js.
 */
export function parseRepoSlug(value: unknown): string | null {
  const raw = String(value || "").trim().replace(/\.git$/i, "");
  if (!raw) return null;
  const ssh = raw.match(/^git@[^:]+:(.+)$/);
  if (ssh) return repoFromPath(ssh[1]!);
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
  try {
    const withProto = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    return repoFromPath(new URL(withProto).pathname);
  } catch {
    return null;
  }
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
  if (link.repo && MALFORMED_REPO.test(link.repo)) {
    const healed = parseRepoSlug(link.url);
    if (healed) link.repo = healed;
    else delete link.repo;
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

/** Same PR: same repo+number, or same number+url where one side lacks a repo. */
function samePrLink(a: PrLink, b: PrLink): boolean {
  if (prLinkKey(a) === prLinkKey(b)) return true;
  return a.number === b.number && !!a.url && a.url === b.url && (!a.repo || !b.repo);
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
  for (const row of raw) {
    const link = normalizePrLink(row);
    if (!link) continue;
    const i = out.findIndex((l) => samePrLink(l, link));
    if (i < 0) out.push(link);
    else if (!out[i]!.repo && link.repo) out[i] = { ...out[i]!, repo: link.repo };
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
  const out = links.filter((l) => !samePrLink(l, next));
  const existing = links.find((l) => samePrLink(l, next));
  const merged: PrLink = { ...existing, ...next, number: next.number };
  const repo = next.repo || existing?.repo;
  if (repo) merged.repo = repo;
  else delete merged.repo;
  out.push(merged);
  return out;
}
