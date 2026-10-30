import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { findPathRefs, type PathRef } from "../pathLinks";
import { findGithubRefs, githubRefUrl, type GithubRefHit } from "../githubRefs";
import { PrHoverTarget } from "./PrHoverCard";
import styles from "./PathLinks.module.css";

/** GitHub's mark, for github.com links (issue #1771). */
export function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/** `true` for any github.com link, so callers can prepend a GithubMark. */
export function isGithubUrl(href: string | null | undefined): boolean {
  return Boolean(href && /^https?:\/\/github\.com\//i.test(href.trim()));
}

export interface PathLinkOpenOpts {
  reveal?: boolean;
  line?: number;
  col?: number;
}

export interface PathLinkHandlers {
  resolvePaths: (
    paths: string[],
  ) =>
    | Record<string, string | null>
    | Promise<Record<string, string | null>>;
  openPath: (abs: string, opts?: PathLinkOpenOpts) => void;
  /** Load a local image as an img src (solenta-media / data URL). */
  loadImage?: (abs: string) => Promise<string | null>;
  /**
   * Grok image_gen files keyed as `images/N.jpg` → absolute session path.
   * Overlay on worktree resolve so markdown images render.
   */
  sessionImages?: Record<string, string>;
}

export const PathLinkContext = createContext<PathLinkHandlers | null>(null);

/** Paths per resolver call; electron/ipc-files.js caps files:resolve at the same size. */
const RESOLVE_BATCH_MAX = 500;

export function PathLinkProvider({
  children,
  resolvePaths,
  openPath,
  loadImage,
  sessionImages,
  threadId,
}: PathLinkHandlers & { children: ReactNode; threadId?: string }) {
  const cacheRef = useRef(new Map<string, string | null>());
  /** In-flight lookups, so a path asked for twice is fetched once. */
  const pendingRef = useRef(new Map<string, Promise<string | null>>());
  /** Paths queued for the next microtask flush → one resolver call (#1475). */
  const queueRef = useRef<Map<string, (abs: string | null) => void> | null>(
    null,
  );
  const genRef = useRef(0);
  const resolveRef = useRef(resolvePaths);
  resolveRef.current = resolvePaths;
  const openRef = useRef(openPath);
  openRef.current = openPath;
  const loadRef = useRef(loadImage);
  loadRef.current = loadImage;

  useEffect(() => {
    cacheRef.current.clear();
    pendingRef.current.clear();
    genRef.current += 1;
  }, [threadId]);

  const value = useMemo<PathLinkHandlers>(() => {
    const flush = (queue: Map<string, (abs: string | null) => void>) => {
      queueRef.current = null;
      const gen = genRef.current;
      const all = [...queue.keys()];
      for (let i = 0; i < all.length; i += RESOLVE_BATCH_MAX) {
        const chunk = all.slice(i, i + RESOLVE_BATCH_MAX);
        void Promise.resolve()
          .then(() => resolveRef.current(chunk))
          .catch(() => null)
          .then((map) => {
            for (const p of chunk) {
              const abs = map?.[p] ?? null;
              if (gen === genRef.current) {
                // A failed lookup is not cached, so a later render retries it.
                if (map) cacheRef.current.set(p, abs);
                pendingRef.current.delete(p);
              }
              queue.get(p)!(abs);
            }
          });
      }
    };
    const request = (p: string) => {
      let pending = pendingRef.current.get(p);
      if (pending) return pending;
      pending = new Promise<string | null>((resolve) => {
        let queue = queueRef.current;
        if (!queue) {
          const fresh = new Map<string, (abs: string | null) => void>();
          queueRef.current = queue = fresh;
          queueMicrotask(() => flush(fresh));
        }
        queue.set(p, resolve);
      });
      pendingRef.current.set(p, pending);
      return pending;
    };
    return {
      resolvePaths: (paths) => {
        const cache = cacheRef.current;
        if (paths.every((p) => cache.has(p))) {
          return Object.fromEntries(
            paths.map((p) => [p, cache.get(p) ?? null]),
          );
        }
        return Promise.all(
          paths.map((p) =>
            cache.has(p) ? (cache.get(p) ?? null) : request(p),
          ),
        ).then((abs) => Object.fromEntries(paths.map((p, i) => [p, abs[i]])));
      },
      openPath: (abs, opts) => openRef.current(abs, opts),
      loadImage: (abs) =>
        loadRef.current ? loadRef.current(abs) : Promise.resolve(null),
      sessionImages,
    };
  }, [sessionImages]);

  return (
    <PathLinkContext.Provider value={value}>{children}</PathLinkContext.Provider>
  );
}

export function useResolvedMap(paths: string[]): Record<string, string | null> {
  const api = useContext(PathLinkContext);
  const key = paths.join("\0");
  const [asyncMap, setAsyncMap] = useState<Record<string, string | null>>(
    {},
  );

  const syncMap = useMemo(() => {
    if (!api || paths.length === 0) return null;
    const result = api.resolvePaths(paths);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return null;
    }
    return result as Record<string, string | null>;
  }, [api, key, paths]);

  useEffect(() => {
    if (!api || paths.length === 0 || syncMap) return;
    let live = true;
    void Promise.resolve(api.resolvePaths(paths)).then((map) => {
      if (live) setAsyncMap(map);
    });
    return () => {
      live = false;
    };
  }, [api, key, syncMap, paths]);

  return syncMap ?? asyncMap;
}

function PathAnchor({
  hit,
  abs,
  openPath,
}: {
  hit: PathRef;
  abs: string;
  openPath: PathLinkHandlers["openPath"];
}) {
  const go = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const reveal =
      "metaKey" in e && (Boolean(e.metaKey) || Boolean(e.ctrlKey));
    openPath(abs, { reveal, line: hit.line, col: hit.col });
  };
  return (
    <span
      role="link"
      tabIndex={0}
      className={styles.pathLink}
      data-path-link={hit.path}
      data-path-line={hit.line != null ? String(hit.line) : undefined}
      title={abs}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") go(e);
      }}
    >
      {hit.raw}
    </span>
  );
}

/**
 * Thread ids agents mention in replies (#1531): known ids in the open
 * thread's project, mapped to their titles, plus how to open one.
 */
export interface ThreadLinkHandlers {
  titles: Record<string, string>;
  open: (threadId: string) => void;
  /**
   * The thread's project GitHub remote, as "owner/repo" (issue #1771). Gates
   * bare `#123` auto-linking; absent/null means no known GitHub remote, so
   * only qualified `owner/repo#123` refs are linked.
   */
  repoSlug?: string | null;
  /** Project checkout path, so a linked PR's hover card can call gh (#1771). */
  projectPath?: string | null;
}

export const ThreadLinkContext = createContext<ThreadLinkHandlers | null>(null);

const THREAD_ID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** `text` with known thread ids as links; unknown UUIDs stay plain. */
function threadLinked(
  text: string,
  links: ThreadLinkHandlers | null,
  keyPrefix: string,
): ReactNode {
  if (!links || !text.includes("-")) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const m of text.matchAll(THREAD_ID_RE)) {
    const id = m[0].toLowerCase();
    const title = links.titles[id];
    if (title === undefined) continue;
    if (m.index > cursor) nodes.push(text.slice(cursor, m.index));
    const go = (e: MouseEvent | KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      links.open(id);
    };
    nodes.push(
      <span
        key={`${keyPrefix}t${m.index}`}
        role="link"
        tabIndex={0}
        className={styles.pathLink}
        data-thread-link={id}
        title={title || id}
        onClick={go}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") go(e);
        }}
      >
        {m[0]}
      </span>,
    );
    cursor = m.index + m[0].length;
  }
  if (nodes.length === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** `owner/repo#123` / bare `#123` as a link, with the PR hover card (#1771). */
function GithubRefAnchor({ hit, links }: { hit: GithubRefHit; links: ThreadLinkHandlers | null }) {
  return (
    <PrHoverTarget
      projectPath={links?.projectPath}
      repo={`${hit.owner}/${hit.repo}`}
      number={hit.number}
    >
      <a
        href={githubRefUrl(hit)}
        target="_blank"
        rel="noreferrer"
        className={styles.pathLink}
        data-github-ref={`${hit.owner}/${hit.repo}#${hit.number}`}
      >
        <GithubMark />
        {hit.raw}
      </a>
    </PrHoverTarget>
  );
}

type MergedHit =
  | { kind: "path"; start: number; end: number; ref: PathRef }
  | { kind: "gh"; start: number; end: number; ref: GithubRefHit };

/** Path refs and GitHub refs over the same text, gh refs winning any overlap (so `owner/repo` is never rendered as an unresolved path once `owner/repo#123` claims it). */
function mergeHits(pathHits: PathRef[], ghHits: GithubRefHit[]): MergedHit[] {
  const gh: MergedHit[] = ghHits.map((ref) => ({
    kind: "gh",
    start: ref.start,
    end: ref.end,
    ref,
  }));
  const path: MergedHit[] = pathHits
    .filter((p) => !ghHits.some((g) => p.start < g.end && p.end > g.start))
    .map((ref) => ({ kind: "path", start: ref.start, end: ref.end, ref }));
  return [...gh, ...path].sort((a, b) => a.start - b.start);
}

/**
 * Plain text with existing workspace paths, known thread ids, and GitHub
 * refs (`owner/repo#123`, bare `#123`) turned into links. `githubRefs=false`
 * for inline code (#1771): file-path and thread-id links still apply there,
 * but a GitHub ref inside backticks stays plain text.
 */
export function PathText({
  text,
  className,
  githubRefs = true,
}: {
  text: string;
  className?: string;
  githubRefs?: boolean;
}) {
  const api = useContext(PathLinkContext);
  const links = useContext(ThreadLinkContext);
  const pathHits = useMemo(() => findPathRefs(text), [text]);
  const ghHits = useMemo(
    () => (githubRefs ? findGithubRefs(text, links?.repoSlug ?? null) : []),
    [text, githubRefs, links],
  );
  const paths = useMemo(
    () => [...new Set(pathHits.map((h) => h.path))],
    [pathHits],
  );
  const resolved = useResolvedMap(paths);

  if (pathHits.length === 0 && ghHits.length === 0) {
    const plain = threadLinked(text, links, "");
    return className ? <span className={className}>{plain}</span> : plain;
  }

  const merged = mergeHits(pathHits, ghHits);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const hit of merged) {
    if (hit.start > cursor) {
      nodes.push(threadLinked(text.slice(cursor, hit.start), links, `${cursor}:`));
    }
    if (hit.kind === "gh") {
      nodes.push(<GithubRefAnchor key={`gh:${hit.start}`} hit={hit.ref} links={links} />);
    } else {
      const abs = api ? resolved[hit.ref.path] : null;
      if (abs) {
        nodes.push(
          <PathAnchor
            key={`${hit.start}:${hit.ref.path}`}
            hit={hit.ref}
            abs={abs}
            openPath={api!.openPath}
          />,
        );
      } else {
        nodes.push(hit.ref.raw);
      }
    }
    cursor = hit.end;
  }
  if (cursor < text.length) {
    nodes.push(threadLinked(text.slice(cursor), links, `${cursor}:`));
  }
  return className ? <span className={className}>{nodes}</span> : nodes;
}

/**
 * Walk markdown children and linkify string nodes only (leave <a> alone).
 * `githubRefs=false` for inline code (#1771): used by the `code` component
 * so a `#123`/`owner/repo#123` inside backticks is never turned into a link.
 */
export function linkifyNode(node: ReactNode, opts?: { githubRefs?: boolean }): ReactNode {
  if (typeof node === "string") {
    return <PathText text={node} githubRefs={opts?.githubRefs ?? true} />;
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <Fragment key={i}>{linkifyNode(child, opts)}</Fragment>
    ));
  }
  return node;
}
