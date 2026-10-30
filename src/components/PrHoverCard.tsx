import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { PrDetailResult } from "../shared/ipc";
import styles from "./PrHoverCard.module.css";

export type PrDetailFetcher = (input: {
  projectPath: string;
  prNumber: number;
  repo?: string;
}) => Promise<PrDetailResult>;

/** Provided once near the app root; PR links/pills/refs read it so they do not each need the fetcher threaded through props (#1771). */
export const PrHoverFetchContext = createContext<PrDetailFetcher | null>(null);

const HOVER_DELAY_MS = 400;
const CACHE_MS = 60_000;

type CacheEntry = { at: number; promise: Promise<PrDetailResult> };
/** Module-level: every hover target for the same PR shares one cache/dedupe, like useResolvedMap's path cache. */
const cache = new Map<string, CacheEntry>();

function cacheKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/**
 * Cached, deduped PR fetch for hover cards. Entries live ~60s; concurrent
 * hovers over the same PR share one in-flight request. A rejected fetch is
 * cached too (as an in-band failure), so a dead PR link does not retry on
 * every hover within the window.
 */
export function fetchPrHoverDetail(
  fetchDetail: PrDetailFetcher,
  projectPath: string,
  repo: string,
  number: number,
): Promise<PrDetailResult> {
  const key = cacheKey(repo, number);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = fetchDetail({ projectPath, prNumber: number, repo }).catch(
    (err) =>
      ({
        ok: false,
        reason: err instanceof Error ? err.message : "failed",
      }) as PrDetailResult,
  );
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Test hook: drop the hover-card cache between tests. */
export function clearPrHoverCache(): void {
  cache.clear();
}

/** `owner/repo` parsed out of a github.com PR or issue URL, or null. */
export function repoFromGithubUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/\d+/i.exec(
    url.trim(),
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `{ repo, number }` out of a github.com PR/issue URL, or null (issue #1771). */
export function prRefFromGithubUrl(
  url: string | null | undefined,
): { repo: string; number: number } | null {
  if (!url) return null;
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/i.exec(
    url.trim(),
  );
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

function formatChecks(
  checks: { passing: number; failing: number; pending: number } | undefined,
): { text: string; tone: "checksFailing" | "checksPending" | "checksPassing" } | null {
  if (!checks) return null;
  if (checks.failing > 0) {
    return { text: `${checks.failing} failing`, tone: "checksFailing" };
  }
  if (checks.pending > 0) {
    return { text: `${checks.pending} pending`, tone: "checksPending" };
  }
  if (checks.passing > 0) {
    return { text: `${checks.passing} passing`, tone: "checksPassing" };
  }
  return null;
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

const CARD_WIDTH = 260;
const CARD_GAP = 6;
/** Below this much room above the target, the card drops underneath instead. */
const MIN_ROOM_ABOVE = 140;

/** Fixed-position placement off the target's rect, clamped to the viewport. */
function cardPosition(rect: DOMRect): CSSProperties {
  const left = Math.max(
    8,
    Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8),
  );
  return rect.top >= MIN_ROOM_ABOVE
    ? { left, bottom: window.innerHeight - rect.top + CARD_GAP }
    : { left, top: rect.bottom + CARD_GAP };
}

function PrHoverCardBody({
  pr,
  style,
}: {
  pr: Extract<PrDetailResult, { ok: true }>["pr"];
  style: CSSProperties;
}) {
  const state = pr.isDraft ? "draft" : pr.state.toLowerCase();
  const checks = formatChecks(pr.checks);
  const stat =
    pr.additions != null || pr.deletions != null
      ? `+${pr.additions ?? 0} / -${pr.deletions ?? 0}`
      : null;
  return (
    <div
      className={styles.card}
      style={style}
      role="tooltip"
      data-pr-hover-card=""
    >
      <div className={styles.head}>
        <span>#{pr.number}</span>
        <span className={styles.state} data-pr-hover-state={state}>
          {state}
        </span>
      </div>
      <div className={styles.title}>{pr.title}</div>
      <div className={styles.meta}>
        {checks ? (
          <span className={styles[checks.tone]} data-pr-hover-checks="">
            {checks.text}
          </span>
        ) : null}
        {pr.reviewDecision ? (
          <span data-pr-hover-review="">
            {REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}
          </span>
        ) : null}
        {stat ? <span data-pr-hover-stat="">{stat}</span> : null}
        {pr.author ? <span data-pr-hover-author="">{pr.author}</span> : null}
      </div>
    </div>
  );
}

/**
 * Wraps a PR link/pill/ref with a hover-delayed detail card (issue #1771):
 * title, #number, state, checks summary, review decision, +/- lines, author.
 * No fetch until hover; ~400ms delay, then a ~60s cache + de-dupe via
 * fetchPrHoverDetail. Escape or mouse-out closes it; keyboard focus on the
 * child opens it too. A failed fetch renders nothing (quiet failure).
 */
export function PrHoverTarget({
  projectPath,
  repo,
  number,
  className,
  children,
}: {
  projectPath: string | null | undefined;
  repo: string | null | undefined;
  number: number | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  const fetchDetail = useContext(PrHoverFetchContext);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<PrDetailResult | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetRef = useRef<HTMLSpanElement | null>(null);

  const canHover = Boolean(fetchDetail && projectPath && repo && number && number > 0);

  const cancelTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const schedule = () => {
    if (!canHover) return;
    cancelTimer();
    timerRef.current = setTimeout(() => {
      if (targetRef.current) {
        setPos(cardPosition(targetRef.current.getBoundingClientRect()));
      }
      setOpen(true);
    }, HOVER_DELAY_MS);
  };

  const close = () => {
    cancelTimer();
    setOpen(false);
  };

  useEffect(() => cancelTimer, []);

  useEffect(() => {
    if (!open || !fetchDetail || !projectPath || !repo || !number) return;
    let live = true;
    void fetchPrHoverDetail(fetchDetail, projectPath, repo, number).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [open, fetchDetail, projectPath, repo, number]);

  if (!canHover) return <>{children}</>;

  return (
    <span
      ref={targetRef}
      className={className ? `${styles.target} ${className}` : styles.target}
      data-pr-hover-target=""
      onMouseEnter={schedule}
      onMouseLeave={close}
      onFocus={schedule}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      {children}
      {/* Portaled: an absolute card inside the sidebar was clipped and painted under the next pane. */}
      {open && result && result.ok
        ? createPortal(<PrHoverCardBody pr={result.pr} style={pos} />, document.body)
        : null}
    </span>
  );
}
