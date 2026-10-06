import {
  Fragment,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { isAbsolutePath } from "../pathLinks";
import { markdownChunks } from "./markdownChunks";
import { linkifyNode, PathLinkContext, useResolvedMap } from "./PathLinks";
import styles from "./Markdown.module.css";

const COPIED_MS = 1500;

/** Keep data/solenta-media/file; still drop javascript: via the default. */
function markdownUrlTransform(url: string): string {
  const u = String(url || "").trim();
  if (
    u.startsWith("data:") ||
    u.startsWith("solenta-media:") ||
    u.startsWith("file:")
  ) {
    return u;
  }
  return defaultUrlTransform(u);
}

/**
 * Relative / file / absolute image srcs are workspace or Grok session files,
 * not URLs on the renderer origin. Remote http(s)/data/solenta-media stay.
 */
function localPathFromImgSrc(src: string): string | null {
  const s = src.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return null;
  if (s.startsWith("data:") || s.startsWith("solenta-media:")) return null;
  if (s.startsWith("file:")) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return null;
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return null;
  return s;
}

const NO_PATHS: string[] = [];

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const api = useContext(PathLinkContext);
  const local = src ? localPathFromImgSrc(src) : null;
  const sessionAbs = local ? api?.sessionImages?.[local] : undefined;
  const absDirect = local && isAbsolutePath(local) ? local : null;
  const rel = local && !absDirect && !sessionAbs ? local : "";
  const relPaths = useMemo(() => (rel ? [rel] : NO_PATHS), [rel]);
  const resolved = useResolvedMap(relPaths);
  const abs = sessionAbs ?? absDirect ?? (rel ? resolved[rel] : null) ?? null;
  const remote = src && !local ? src : null;
  const [loaded, setLoaded] = useState<string | null>(remote || null);

  useEffect(() => {
    if (remote) {
      setLoaded(remote);
      return;
    }
    if (!abs || !api?.loadImage) {
      setLoaded(null);
      return;
    }
    let live = true;
    void api.loadImage(abs).then((url) => {
      if (live) setLoaded(url);
    });
    return () => {
      live = false;
    };
  }, [abs, api, remote]);

  if (!loaded) return null;
  return (
    <img
      className={styles.image}
      src={loaded}
      alt={alt ?? ""}
      title={alt || undefined}
      tabIndex={0}
    />
  );
}

/** Pull raw text out of a code element's children (string | array | nested). */
function flattenText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenText(node.props.children);
  }
  return "";
}

/**
 * Fenced code block with a header bar: language label + Copy.
 * Replaces react-markdown's <pre>; the inner <code> element is unwrapped so
 * the block renders one flat <pre> and the `code` override below only ever
 * sees inline code.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  let lang = "";
  let code = "";
  if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
    const match = /language-([\w-]+)/.exec(children.props.className ?? "");
    if (match) lang = match[1];
    code = flattenText(children.props.children);
  } else {
    code = flattenText(children);
  }
  code = code.replace(/\n$/, "");

  const [copied, setCopied] = useState(false);

  const copy = async () => {
    // jsdom and insecure contexts have no clipboard; keep the button inert.
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Permission denied; leave the label unchanged.
    }
  };

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang || "code"}</span>
        <button type="button" className={styles.codeCopy} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={styles.codePre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Hold `text` steady between parses.
 *
 * A streaming message pushes new text several times a second. A whole-text
 * parse of 50KB of markdown is ~35ms, which is what users feel as typing lag
 * while an agent writes. Waiting `lastCost * 6` in between caps that at
 * roughly a sixth of the main thread, and the trailing timer means the final
 * text always lands. Since #1475 the streaming message re-parses only its last
 * chunk, so lastCost stays small and this mostly sits at the 60ms floor; it
 * still guards a reply that falls back to one chunk (see markdownChunks).
 *
 * The first change after mount is not delayed, so a reply still starts drawing
 * the moment its first chunk arrives.
 */
function useThrottledText(text: string, lastCost: { current: number }): string {
  const [shown, setShown] = useState(text);
  const shownAt = useRef(0);
  useEffect(() => {
    if (text === shown) return;
    const gap = Math.min(1000, Math.max(60, lastCost.current * 6));
    const wait = Math.max(0, gap - (performance.now() - shownAt.current));
    const timer = setTimeout(() => {
      shownAt.current = performance.now();
      setShown(text);
    }, wait);
    return () => clearTimeout(timer);
  }, [text, shown, lastCost]);
  return shown;
}

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  pre: (props) => <CodeBlock>{props.children}</CodeBlock>,
  code: (props) => (
    <code className={styles.inlineCode}>{linkifyNode(props.children)}</code>
  ),
  p: (props) => <p>{linkifyNode(props.children)}</p>,
  li: (props) => <li>{linkifyNode(props.children)}</li>,
  td: (props) => <td>{linkifyNode(props.children)}</td>,
  th: (props) => <th>{linkifyNode(props.children)}</th>,
  h1: (props) => <h1>{linkifyNode(props.children)}</h1>,
  h2: (props) => <h2>{linkifyNode(props.children)}</h2>,
  h3: (props) => <h3>{linkifyNode(props.children)}</h3>,
  h4: (props) => <h4>{linkifyNode(props.children)}</h4>,
  blockquote: (props) => <blockquote>{linkifyNode(props.children)}</blockquote>,
  a: (props) => (
    <a href={props.href} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  ),
  img: (props) => <MarkdownImage src={props.src} alt={props.alt} />,
};

/** Test hook: how many times a markdown chunk has been parsed. */
export const markdownParses = { count: 0 };

/**
 * Parsed markdown by text, most recently used last (#1475). The parse is a
 * pure function of the text, and a React element tree can be mounted again,
 * so switching back to a recently viewed thread skips micromark/mdast/hast,
 * which was ~45% of the big-thread switch frame. Bounded by text length:
 * a mounted tail window holds at most TRANSCRIPT_CHAR_BUDGET (100k) chars,
 * so this covers the last few threads viewed.
 */
const PARSED_CHAR_BUDGET = 400_000;
const parsed = new Map<string, ReactElement>();
let parsedChars = 0;

function parseMarkdown(text: string): ReactElement {
  markdownParses.count++;
  return ReactMarkdown({
    children: text,
    remarkPlugins: REMARK_PLUGINS,
    urlTransform: markdownUrlTransform,
    components: COMPONENTS,
  });
}

/** Test hook: drop every cached parse. */
export function clearParsedMarkdown() {
  parsed.clear();
  parsedChars = 0;
}

function cachedParse(text: string): ReactElement {
  const hit = parsed.get(text);
  if (hit) {
    parsed.delete(text);
    parsed.set(text, hit);
    return hit;
  }
  const el = parseMarkdown(text);
  if (text.length > PARSED_CHAR_BUDGET) return el;
  parsed.set(text, el);
  parsedChars += text.length;
  for (const key of parsed.keys()) {
    if (parsedChars <= PARSED_CHAR_BUDGET) break;
    parsed.delete(key);
    parsedChars -= key.length;
  }
  return el;
}

/** Whether `text` is in the parse cache. */
export function isParsed(text: string): boolean {
  return parsed.has(text);
}

/** Parse `text` into the cache ahead of its mount (tail-first switch). */
export function preparseMarkdown(text: string): void {
  cachedParse(text);
}

/**
 * One parse. memo: a settled chunk of a streaming reply keeps its text.
 * `live` marks the growing tail of a streaming reply: its text changes on
 * every push, so caching it would only evict settled parses.
 */
const MarkdownChunk = memo(function MarkdownChunk({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}) {
  return live ? parseMarkdown(text) : cachedParse(text);
});

/**
 * The parse, unthrottled. A streaming reply is split at settled block
 * boundaries (see markdownChunks) so each push re-parses only the last chunk
 * instead of the whole reply. Every other message is one parse, as before.
 *
 * The "\n" between chunks is the text node react-markdown puts between
 * top-level blocks, so the DOM matches a one-shot parse exactly.
 */
export function MarkdownBody({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const chunks = streaming ? markdownChunks(text) : [text];
  return (
    <div className={styles.md}>
      {chunks.map((chunk, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <MarkdownChunk
            text={chunk}
            live={streaming && i === chunks.length - 1}
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Assistant-message markdown. react-markdown renders to React elements (no
 * dangerouslySetInnerHTML), so raw HTML in agent output is dropped, not
 * executed.
 *
 * memo: parsing is the expensive part of a streamed update, and only the
 * message being written has new text. `streaming` marks that message.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  // Measured across this subtree's render + commit, i.e. the parse we are
  // pacing. Declared before the throttle so its effect runs first.
  const lastCost = useRef(0);
  const started = performance.now();
  useEffect(() => {
    lastCost.current = performance.now() - started;
  });
  const shown = useThrottledText(text, lastCost);
  return <MarkdownBody text={shown} streaming={streaming} />;
});
