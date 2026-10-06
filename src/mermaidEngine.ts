// Mermaid diagrams for ```mermaid fences (#1506). A lazy chunk: mermaid and
// DOMPurify only load the first time a transcript shows a diagram.
//
// Agent output is untrusted, so three layers: securityLevel "strict" (no
// click handlers, labels escaped), htmlLabels off (plain SVG text, no
// foreignObject HTML), and the finished SVG goes through DOMPurify's SVG
// profile before it touches the DOM.
import DOMPurify from "dompurify";
import mermaid from "mermaid";

/**
 * Mermaid's base theme from the app's tokens (src/index.css), read at
 * render time so light and dark each get their own palette.
 */
function themeVariables(): Record<string, string | boolean> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: document.documentElement.getAttribute("data-theme") !== "light",
    fontFamily: v("--font"),
    fontSize: "13px",
    background: v("--card"),
    mainBkg: v("--card-hover"),
    primaryColor: v("--card-hover"),
    primaryTextColor: v("--text"),
    primaryBorderColor: v("--text-dim"),
    secondaryColor: v("--bg-elevated"),
    tertiaryColor: v("--panel"),
    nodeBorder: v("--text-dim"),
    lineColor: v("--text-muted"),
    textColor: v("--text"),
    titleColor: v("--text"),
    clusterBkg: v("--bg-elevated"),
    clusterBorder: v("--border"),
    edgeLabelBackground: v("--card"),
    noteBkgColor: v("--bg-elevated"),
    noteTextColor: v("--text"),
    noteBorderColor: v("--border"),
    actorBkg: v("--card-hover"),
    actorBorder: v("--text-dim"),
    actorTextColor: v("--text"),
    signalColor: v("--text-muted"),
    signalTextColor: v("--text"),
  };
}

/** Sanitised SVG or null (a parse/render error), by theme + source. */
const cache = new Map<string, string | null>();
// ponytail: dropped wholesale at the cap; LRU if long threads thrash it.
const CACHE_CAP = 100;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

async function renderNow(code: string): Promise<string | null> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "base",
    themeVariables: themeVariables(),
  });
  if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
  const { svg } = await mermaid.render(`solenta-mermaid-${++seq}`, code);
  return sanitizeSvg(svg);
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** DOMPurify's SVG profile; `<style>` kept, it carries the diagram theme. */
export function sanitizeSvg(svg: string): string {
  // Bound on first use: the import can run before a test installs its DOM.
  purifier ??= DOMPurify(window);
  return purifier.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
  });
}

/**
 * Render `code` to sanitised SVG, or null when it does not parse. Renders
 * run one at a time: mermaid's config is global and initialize() before each
 * render must not interleave with another diagram's.
 */
export function renderMermaid(code: string): Promise<string | null> {
  const key = `${document.documentElement.getAttribute("data-theme")}\0${code}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const run = queue.then(() => renderNow(code)).catch(() => null);
  queue = run;
  return run.then((svg) => {
    if (cache.size >= CACHE_CAP) cache.clear();
    cache.set(key, svg);
    return svg;
  });
}
