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

export function PathLinkProvider({
  children,
  resolvePaths,
  openPath,
  loadImage,
  sessionImages,
  threadId,
}: PathLinkHandlers & { children: ReactNode; threadId?: string }) {
  const cacheRef = useRef(new Map<string, string | null>());
  const resolveRef = useRef(resolvePaths);
  resolveRef.current = resolvePaths;
  const openRef = useRef(openPath);
  openRef.current = openPath;
  const loadRef = useRef(loadImage);
  loadRef.current = loadImage;

  useEffect(() => {
    cacheRef.current.clear();
  }, [threadId]);

  const value = useMemo<PathLinkHandlers>(
    () => ({
      resolvePaths: (paths) => {
        const missing = paths.filter((p) => !cacheRef.current.has(p));
        const finish = () =>
          Object.fromEntries(
            paths.map((p) => [p, cacheRef.current.get(p) ?? null]),
          );
        if (missing.length === 0) return finish();
        const result = resolveRef.current(missing);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return Promise.resolve(result).then((map) => {
            for (const [p, abs] of Object.entries(map)) {
              cacheRef.current.set(p, abs);
            }
            return finish();
          });
        }
        for (const [p, abs] of Object.entries(
          result as Record<string, string | null>,
        )) {
          cacheRef.current.set(p, abs);
        }
        return finish();
      },
      openPath: (abs, opts) => openRef.current(abs, opts),
      loadImage: (abs) =>
        loadRef.current ? loadRef.current(abs) : Promise.resolve(null),
      sessionImages,
    }),
    [sessionImages],
  );

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

/** Plain text with existing workspace paths turned into hover-underline links. */
export function PathText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const api = useContext(PathLinkContext);
  const hits = useMemo(() => findPathRefs(text), [text]);
  const paths = useMemo(
    () => [...new Set(hits.map((h) => h.path))],
    [hits],
  );
  const resolved = useResolvedMap(paths);

  if (!api || hits.length === 0) {
    return className ? <span className={className}>{text}</span> : text;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) nodes.push(text.slice(cursor, hit.start));
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
  if (cursor < text.length) nodes.push(text.slice(cursor));
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
