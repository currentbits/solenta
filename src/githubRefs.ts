/**
 * Detect `owner/repo#123` and bare `#123` GitHub references in transcript
 * text, so the renderer can turn existing ones into links (issue #1771).
 *
 * Pure: no IPC. Bare refs need a repo slug injected by the caller (the
 * thread's project GitHub remote); with none, only qualified refs match.
 */
import { inRange, urlRanges } from "./pathLinks.ts";

export interface GithubRefHit {
  /** Matched text, e.g. "acme/demo#482" or "#482". */
  raw: string;
  owner: string;
  repo: string;
  number: number;
  start: number;
  end: number;
}

/** Same set pathLinks.ts scans path tokens with, so a ref glued to a longer path/URL token is never split out of it. */
const PATH_CHAR = /[A-Za-z0-9_./\\@+~:-]/;

function isPathChar(ch: string | undefined): boolean {
  return ch != null && PATH_CHAR.test(ch);
}

/** Trailing boundary: a following letter/digit means this is some other
 * token glued to the match, e.g. a CSS hex color `#123abc` or `#123def`. */
function isWordChar(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9_]/.test(ch);
}

/** A trailing `owner`/`repo` segment that ends in a file extension is a path (`src/app.ts`), not a repo. */
function looksLikeFilename(segment: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(segment);
}

const QUALIFIED_RE =
  /([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)#(\d+)/g;
const BARE_RE = /#(\d{2,})/g;

/**
 * `owner/repo#123` references anywhere in `text`. Skips URLs, and any
 * match embedded in a longer path-like run (so `a/b/c#123` and
 * `src/app.ts#123` are left alone).
 */
export function findQualifiedGithubRefs(text: string): GithubRefHit[] {
  const blocked = urlRanges(text);
  const hits: GithubRefHit[] = [];
  QUALIFIED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUALIFIED_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (inRange(blocked, start)) continue;
    if (isPathChar(text[start - 1])) continue;
    if (isWordChar(text[end])) continue;
    const [, owner, repo, numberStr] = m;
    if (looksLikeFilename(repo)) continue;
    hits.push({ raw: m[0], owner, repo, number: Number(numberStr), start, end });
  }
  return hits;
}

/**
 * Bare `#123` references (2+ digits, so "step #1" stays plain), resolved
 * against `repoSlug` ("owner/repo"). Returns [] when `repoSlug` is falsy —
 * the project has no known GitHub remote.
 */
export function findBareGithubRefs(
  text: string,
  repoSlug: string | null | undefined,
): GithubRefHit[] {
  if (!repoSlug || !repoSlug.includes("/")) return [];
  const slash = repoSlug.indexOf("/");
  const owner = repoSlug.slice(0, slash);
  const repo = repoSlug.slice(slash + 1);
  if (!owner || !repo) return [];
  const blocked = urlRanges(text);
  const hits: GithubRefHit[] = [];
  BARE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (inRange(blocked, start)) continue;
    if (isPathChar(text[start - 1])) continue;
    if (isWordChar(text[end])) continue;
    hits.push({ raw: m[0], owner, repo, number: Number(m[1]), start, end });
  }
  return hits;
}

/**
 * Qualified and bare refs together, sorted and de-overlapped (qualified
 * wins: "acme/demo#482" is never split into a bare "#482").
 */
export function findGithubRefs(
  text: string,
  repoSlug: string | null | undefined,
): GithubRefHit[] {
  const qualified = findQualifiedGithubRefs(text);
  const bare = findBareGithubRefs(text, repoSlug).filter(
    (b) => !qualified.some((q) => b.start < q.end && b.end > q.start),
  );
  return [...qualified, ...bare].sort((a, b) => a.start - b.start);
}

export function githubRefUrl(hit: Pick<GithubRefHit, "owner" | "repo" | "number">): string {
  return `https://github.com/${hit.owner}/${hit.repo}/issues/${hit.number}`;
}
