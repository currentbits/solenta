import {
  cloneElement,
  Children,
  createContext,
  Fragment,
  isValidElement,
  lazy,
  memo,
  Suspense,
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
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { lazyNamed } from "../lazyNamed";
import { isAbsolutePath } from "../pathLinks";
import { languageForFence, useHighlightedBlock } from "../syntaxHighlight";
import { markdownChunks } from "./markdownChunks";
import {
  setWrapCodeBlocksEnabled,
  useWrapCodeBlocksEnabled,
} from "../uiPrefs";
import {
  GithubMark,
  isGithubUrl,
  linkifyNode,
  PathAnchor,
  PathLinkContext,
  ThreadLinkContext,
  useResolvedMap,
} from "./PathLinks";
import { prRefFromGithubUrl, PrHoverTarget } from "./PrHoverCard";
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
 * Relative / file / absolute image srcs and link hrefs are workspace or Grok
 * session files, not URLs on the renderer origin. Remote
 * http(s)/data/solenta-media and in-page #anchors stay.
 */
function localPathFromUrl(src: string): string | null {
  const s = src.trim();
  if (!s || s.startsWith("#") || s.startsWith("//")) return null;
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
  // micromark percent-encodes `<path with spaces.png>`.
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const NO_PATHS: string[] = [];

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const api = useContext(PathLinkContext);
  const local = src ? localPathFromUrl(src) : null;
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

/**
 * `[mockup](/abs/design/01.png)` names a workspace file: a target=_blank
 * anchor to it opened nothing (#1844), so it opens like a path link instead.
 */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const api = useContext(PathLinkContext);
  const links = useContext(ThreadLinkContext);
  const local = href ? localPathFromUrl(href) : null;
  const paths = useMemo(() => (local ? [local] : NO_PATHS), [local]);
  const abs = useResolvedMap(paths)[local ?? ""];
  if (!local) {
    const github = isGithubUrl(href);
    const anchor = (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        // A bare URL is technical text; a labelled link reads with its prose.
        dir={flattenText(children) === href ? "ltr" : undefined}
      >
        {github ? <GithubMark className={styles.githubMark} /> : null}
        {children}
      </a>
    );
    const ref = github ? prRefFromGithubUrl(href) : null;
    if (!ref) return anchor;
    return (
      <PrHoverTarget projectPath={links?.projectPath} repo={ref.repo} number={ref.number}>
        {anchor}
      </PrHoverTarget>
    );
  }
  if (!api || !abs) return <>{children}</>;
  return (
    <PathAnchor
      hit={{ raw: local, path: local, start: 0, end: 0 }}
      abs={abs}
      openPath={api.openPath}
    >
      {children}
    </PathAnchor>
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

/** True inside the growing tail chunk of a streaming reply. */
const LiveChunkContext = createContext(false);

/**
 * ```mermaid fences draw as diagrams (#1506). The component, mermaid and
 * DOMPurify are all one lazy chunk; the code block is the Suspense fallback.
 */
const MermaidDiagram = lazy(() => import("./MermaidDiagram"));
const HtmlPage = lazyNamed(() => import("./HtmlPage").then((m) => m.default));

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
  const html = useHighlightedBlock(languageForFence(lang), code);
  // ponytail: the whole live chunk counts as unclosed, so a closed fence
  // stays code until the next block settles it or the reply ends.
  const live = useContext(LiveChunkContext);
  const wrap = useWrapCodeBlocksEnabled();

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

  const pre = (
    <pre className={styles.codePre}>
      {html != null ? (
        <code dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code>{code}</code>
      )}
    </pre>
  );

  return (
    <div className={styles.codeBlock} dir="ltr">
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang || "code"}</span>
        <button
          type="button"
          className={styles.codeCopy}
          aria-pressed={wrap}
          title={wrap ? "Don't wrap long lines" : "Wrap long lines"}
          onClick={() => setWrapCodeBlocksEnabled(!wrap)}
        >
          Wrap
        </button>
        <button type="button" className={styles.codeCopy} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {lang === "mermaid" && !live ? (
        <Suspense fallback={pre}>
          <MermaidDiagram code={code} fallback={pre} />
        </Suspense>
      ) : (lang === "html" || lang === "htm") && !live ? (
        <Suspense fallback={pre}>
          <HtmlPage html={code} fallback={pre} />
        </Suspense>
      ) : (
        pre
      )}
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

export interface MarkdownTask { start: number; end: number }
const TaskContext = createContext<{ onToggle: (task: MarkdownTask) => void; disabled: boolean } | null>(null);

function TaskListItem(props: { children?: ReactNode } & ExtraProps) {
  const tasks = useContext(TaskContext);
  const start = props.node?.position?.start.offset;
  const end = props.node?.position?.end.offset;
  type ChildProps = { children?: ReactNode; node?: { tagName?: string }; type?: string; disabled?: boolean; onChange?: () => void; "aria-label"?: string };
  const ownChildren = Children.toArray(props.children).filter((child) =>
    !isValidElement<ChildProps>(child) || !["ul", "ol"].includes(child.props.node?.tagName ?? String(child.type)));
  const label = flattenText(ownChildren).trim() || "Checklist item";
  function editable(children: ReactNode): ReactNode {
    return Children.map(children, (child) => {
      if (!isValidElement<ChildProps>(child)) return child;
      if (child.props.type === "checkbox" && tasks && start != null && end != null) {
        return cloneElement(child, { disabled: tasks.disabled, onChange: () => tasks.onToggle({ start, end }), "aria-label": `Toggle ${label}` });
      }
      // Loose task items wrap their own input in a paragraph. Nested lists
      // have their own list-item source positions and must keep that mapping.
      if ((child.props.node?.tagName ?? child.type) === "p") {
        return cloneElement(child, { children: editable(child.props.children) });
      }
      return child;
    });
  }
  const children = tasks ? editable(props.children) : props.children;
  return <li>{linkifyNode(children)}</li>;
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
};

const RTL_LETTER =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

/**
 * First-strong direction of a container's text, skipping code. Containers
 * need this because dir="auto" ignores children carrying their own dir,
 * which every <p>/<th> inside a blockquote or table does.
 */
export function blockDir(node: HastNode | undefined): "rtl" | "ltr" | "auto" {
  if (!node) return "auto";
  if (node.type === "text") {
    const letter = /\p{L}/u.exec(node.value ?? "");
    if (!letter) return "auto";
    return RTL_LETTER.test(letter[0]) ? "rtl" : "ltr";
  }
  if (node.tagName === "code" || node.tagName === "pre") return "auto";
  for (const child of node.children ?? []) {
    const dir = blockDir(child);
    if (dir !== "auto") return dir;
  }
  return "auto";
}

/**
 * Bidi (#1939): text blocks take dir="auto", so Arabic/Hebrew paragraphs run
 * right-to-left from their first strong letter. Containers (lists, quotes,
 * tables) get the same first-strong rule via blockDir, so markers, the quote
 * bar and column order follow the text. Code, path links and bare URLs carry
 * dir="ltr": the dir=auto scan skips any descendant with its own dir, so a
 * reply opening with `src/app.ts` still reads RTL when the prose is Arabic,
 * and the path itself stays an isolated left-to-right run.
 */
const COMPONENTS: Components = {
  pre: (props) => <CodeBlock>{props.children}</CodeBlock>,
  // Double-click takes the whole span: word selection stops at `-` and `/`,
  // so `migration-gate` would otherwise select only "migration" (#1754).
  code: (props) => (
    <code
      className={styles.inlineCode}
      dir="ltr"
      onDoubleClick={(e) =>
        window.getSelection()?.selectAllChildren(e.currentTarget)
      }
    >
      {linkifyNode(props.children, { githubRefs: false })}
    </code>
  ),
  p: (props) => <p dir="auto">{linkifyNode(props.children)}</p>,
  // ponytail: direction per list, not per item, so markers and indent stay on
  // one side; a list mixing RTL and LTR items aligns to its first strong text.
  ul: ({ node, ...rest }) => <ul dir={blockDir(node)} {...rest} />,
  ol: ({ node, ...rest }) => <ol dir={blockDir(node)} {...rest} />,
  table: ({ node, ...rest }) => <table dir={blockDir(node)} {...rest} />,
  li: TaskListItem,
  td: (props) => <td dir="auto">{linkifyNode(props.children)}</td>,
  th: (props) => <th dir="auto">{linkifyNode(props.children)}</th>,
  h1: (props) => <h1 dir="auto">{linkifyNode(props.children)}</h1>,
  h2: (props) => <h2 dir="auto">{linkifyNode(props.children)}</h2>,
  h3: (props) => <h3 dir="auto">{linkifyNode(props.children)}</h3>,
  h4: (props) => <h4 dir="auto">{linkifyNode(props.children)}</h4>,
  blockquote: (props) => (
    <blockquote dir={blockDir(props.node)}>
      {linkifyNode(props.children)}
    </blockquote>
  ),
  a: (props) => <MarkdownLink href={props.href}>{props.children}</MarkdownLink>,
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
  // Always the Provider, so a chunk settling keeps its tree (and each code
  // block's highlight state) instead of remounting it.
  return (
    <LiveChunkContext.Provider value={live}>
      {live ? parseMarkdown(text) : cachedParse(text)}
    </LiveChunkContext.Provider>
  );
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
  onTaskToggle,
  tasksDisabled = false,
}: {
  text: string;
  streaming?: boolean;
  onTaskToggle?: (task: MarkdownTask) => void;
  tasksDisabled?: boolean;
}) {
  const chunks = streaming ? markdownChunks(text) : [text];
  const wrap = useWrapCodeBlocksEnabled();
  return (
    <TaskContext.Provider value={onTaskToggle ? { onToggle: onTaskToggle, disabled: tasksDisabled } : null}>
    <div className={styles.md} data-wrap-code={wrap ? "" : undefined}>
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
    </TaskContext.Provider>
  );
}

/**
 * Assistant-message markdown. react-markdown renders to React elements (no
 * dangerouslySetInnerHTML), so raw HTML in agent output is dropped, not
 * executed. An ```html fence is the opt-in: HtmlPage, sandboxed (#1525).
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
