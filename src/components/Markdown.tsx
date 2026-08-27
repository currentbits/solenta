import {
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isAbsolutePath } from "../pathLinks";
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
 * A streaming message pushes new text several times a second and ReactMarkdown
 * re-parses ALL of it every time, so a run costs O(n^2) parse work on the
 * renderer's main thread: 50KB of markdown is ~35ms per parse, which is what
 * users feel as typing lag while an agent writes. Waiting `lastCost * 6` in
 * between caps that at roughly a sixth of the main thread whatever the message
 * length, and the trailing timer means the final text always lands.
 *
 * The first change after mount is not delayed, so a reply still starts drawing
 * the moment its first chunk arrives.
 *
 * ponytail: the streaming tail lags by up to one interval. Parse only the
 * settled prefix incrementally if that ever reads as stutter.
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

/**
 * Assistant-message markdown. react-markdown renders to React elements (no
 * dangerouslySetInnerHTML), so raw HTML in agent output is dropped, not
 * executed.
 *
 * memo: parsing is the expensive part of a streamed update, and only the
 * message being written has new text.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Measured across this subtree's render + commit, i.e. the parse we are
  // pacing. Declared before the throttle so its effect runs first.
  const lastCost = useRef(0);
  const started = performance.now();
  useEffect(() => {
    lastCost.current = performance.now() - started;
  });
  const shown = useThrottledText(text, lastCost);

  return (
    <div className={styles.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={markdownUrlTransform}
        components={{
          pre: (props) => <CodeBlock>{props.children}</CodeBlock>,
          code: (props) => (
            <code className={styles.inlineCode}>
              {linkifyNode(props.children)}
            </code>
          ),
          p: (props) => <p>{linkifyNode(props.children)}</p>,
          li: (props) => <li>{linkifyNode(props.children)}</li>,
          td: (props) => <td>{linkifyNode(props.children)}</td>,
          th: (props) => <th>{linkifyNode(props.children)}</th>,
          h1: (props) => <h1>{linkifyNode(props.children)}</h1>,
          h2: (props) => <h2>{linkifyNode(props.children)}</h2>,
          h3: (props) => <h3>{linkifyNode(props.children)}</h3>,
          h4: (props) => <h4>{linkifyNode(props.children)}</h4>,
          blockquote: (props) => (
            <blockquote>{linkifyNode(props.children)}</blockquote>
          ),
          a: (props) => (
            <a href={props.href} target="_blank" rel="noreferrer">
              {props.children}
            </a>
          ),
          img: (props) => <MarkdownImage src={props.src} alt={props.alt} />,
        }}
      >
        {shown}
      </ReactMarkdown>
    </div>
  );
});
