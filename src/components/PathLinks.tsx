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
import styles from "./PathLinks.module.css";

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

/** Plain text with existing workspace paths turned into hover-underline links. */
export function PathText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const api = useContext(PathLinkContext);
  const links = useContext(ThreadLinkContext);
  const hits = useMemo(() => findPathRefs(text), [text]);
  const paths = useMemo(
    () => [...new Set(hits.map((h) => h.path))],
    [hits],
  );
  const resolved = useResolvedMap(paths);

  if (!api || hits.length === 0) {
    const plain = threadLinked(text, links, "");
    return className ? <span className={className}>{plain}</span> : plain;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) {
      nodes.push(threadLinked(text.slice(cursor, hit.start), links, `${cursor}:`));
    }
    const abs = resolved[hit.path];
    if (abs) {
      nodes.push(
        <PathAnchor
          key={`${hit.start}:${hit.path}`}
          hit={hit}
          abs={abs}
          openPath={api.openPath}
        />,
      );
    } else {
      nodes.push(hit.raw);
    }
    cursor = hit.end;
  }
  if (cursor < text.length) {
    nodes.push(threadLinked(text.slice(cursor), links, `${cursor}:`));
  }
  return className ? <span className={className}>{nodes}</span> : nodes;
}

/** Walk markdown children and linkify string nodes only (leave <a> alone). */
export function linkifyNode(node: ReactNode): ReactNode {
  if (typeof node === "string") return <PathText text={node} />;
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <Fragment key={i}>{linkifyNode(child)}</Fragment>
    ));
  }
  return node;
}
