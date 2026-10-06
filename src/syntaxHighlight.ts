// Syntax highlighting for diff lines and markdown code (#1493). The engine
// (highlight.js + languages + token CSS) is a lazy chunk; this file is the
// small main-bundle side: language lookup, a cache and two hooks.
import { useEffect, useState } from "react";

type Engine = typeof import("./highlightEngine");

let enginePromise: Promise<Engine> | null = null;

function loadEngine(): Promise<Engine> {
  enginePromise ??= import("./highlightEngine");
  return enginePromise;
}

/** Load the engine now. Tests call this so highlight updates land inside act. */
export function preloadHighlighter(): Promise<unknown> {
  return loadEngine();
}

const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", css: "css", scss: "css", less: "css",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", plist: "xml",
  md: "markdown", markdown: "markdown", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", swift: "swift", c: "c", h: "c", cc: "cpp",
  cpp: "cpp", cxx: "cpp", hpp: "cpp", m: "c", mm: "cpp", sh: "bash",
  bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini",
  ini: "ini", sql: "sql", diff: "diff", patch: "diff",
};

/** Fence names that are not an extension (```shell, ```python …). */
const FENCE_ALIAS: Record<string, string> = {
  shell: "bash", console: "bash", typescript: "typescript",
  javascript: "javascript", python: "python", ruby: "ruby", rust: "rust",
  html: "xml", golang: "go", "c++": "cpp", toml: "ini",
};

/** highlight.js language for a repo path, or null to leave it plain. */
export function languageForPath(path: string): string | null {
  const base = path.split("/").pop() || "";
  if (/^dockerfile$/i.test(base) || /^makefile$/i.test(base)) return "bash";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** highlight.js language for a markdown fence tag. */
export function languageForFence(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  return FENCE_ALIAS[t] ?? BY_EXT[t] ?? null;
}

/** Minified one-liners: highlighting them costs more than it gives. */
const MAX_LINE = 2000;
const MAX_BLOCK = 20_000;
/** Lines highlighted per idle slice, so a 5k-line file never blocks input. */
const SLICE = 200;
/**
 * A slice that ends inside a span (an unclosed comment or string) is redone
 * this many lines long so the construct colours through; past it, it is cut.
 */
const MAX_GROW = 10 * SLICE;

// ponytail: flat cache, dropped wholesale at the cap; LRU if reloads thrash it.
const CACHE_CAP = 20_000;
const cache = new Map<string, string | null>();

function cached(engine: Engine, lang: string, code: string): string | null {
  const key = `${lang}\0${code}`;
  let html = cache.get(key);
  if (html === undefined) {
    html = engine.highlight(lang, code);
    if (cache.size >= CACHE_CAP) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/**
 * Split highlighted HTML into lines that each stand alone: spans still open
 * at a line break are closed there and reopened on the next line, so a
 * multi-line comment or string keeps its colour on every line (#1512).
 * `open` is how many spans the last line inherits from the one before.
 */
export function splitHighlightedLines(html: string): { lines: string[]; open: number } {
  const lines: string[] = [];
  const stack: string[] = [];
  let line = "";
  let last = 0;
  let open = 0;
  for (const m of html.matchAll(/<span[^>]*>|<\/span>|\n/g)) {
    line += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0] === "\n") {
      lines.push(line + "</span>".repeat(stack.length));
      line = stack.join("");
      open = stack.length;
    } else if (m[0] === "</span>") {
      stack.pop();
      line += m[0];
    } else {
      stack.push(m[0]);
      line += m[0];
    }
  }
  lines.push(line + html.slice(last));
  return { lines, open };
}

const idle: (cb: () => void) => number =
  typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(cb, { timeout: 120 })
    : (cb) => window.setTimeout(cb, 0);
const cancelIdle: (id: number) => void =
  typeof cancelIdleCallback === "function" ? cancelIdleCallback : clearTimeout;

/**
 * Per-line highlighted HTML (null = plain) for `codes`, filled in idle
 * slices once the engine loads. Each of `groups` (indices into codes) is
 * highlighted as one document, so multi-line comments and strings colour
 * through (#1512); the default is the whole list. A diff passes one group
 * per side per hunk; a line in several groups takes the last one's colour.
 * Pass memoized arrays: identity is the key.
 */
export function useHighlightedLines(
  lang: string | null,
  codes: string[],
  groups?: number[][],
): Array<string | null> {
  const [state, setState] = useState<{
    codes: string[];
    html: Array<string | null>;
  } | null>(null);
  useEffect(() => {
    if (!lang || codes.length === 0) return;
    let cancelled = false;
    let handle = 0;
    const html: Array<string | null> = new Array(codes.length).fill(null);
    const docs = groups ?? [codes.map((_, i) => i)];
    void loadEngine().then((engine) => {
      let g = 0;
      let pos = 0;
      const step = () => {
        if (cancelled) return;
        let budget = SLICE;
        while (budget > 0 && g < docs.length) {
          const doc = docs[g]!;
          let end = Math.min(doc.length, pos + SLICE);
          let out: { lines: string[]; open: number } | null;
          for (;;) {
            // The engine closes every scope at the end of its input, so an
            // empty last line is the probe: it inherits whatever the block's
            // real last line left open.
            const text = doc
              .slice(pos, end)
              .map((i) => (codes[i]!.length > MAX_LINE ? "" : codes[i]!))
              .join("\n");
            const hl = cached(engine, lang, `${text}\n`);
            out = hl == null ? null : splitHighlightedLines(hl);
            if (!out || !out.open || end >= doc.length || end - pos >= MAX_GROW) break;
            end = Math.min(doc.length, pos + MAX_GROW);
          }
          for (let k = pos; k < end; k++) {
            const i = doc[k]!;
            html[i] = !out || codes[i]!.length > MAX_LINE ? null : (out.lines[k - pos] ?? null);
          }
          budget -= end - pos;
          pos = end;
          if (pos >= doc.length) {
            g += 1;
            pos = 0;
          }
        }
        setState({ codes, html: html.slice() });
        if (g < docs.length) handle = idle(step);
      };
      step();
    });
    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
  }, [lang, codes, groups]);
  return state && state.codes === codes && lang ? state.html : [];
}

/** Highlighted HTML for one markdown code block, or null while plain. */
export function useHighlightedBlock(
  lang: string | null,
  code: string,
): string | null {
  const [state, setState] = useState<{ key: string; html: string | null } | null>(null);
  const key = `${lang}\0${code}`;
  useEffect(() => {
    if (!lang || !code || code.length > MAX_BLOCK) return;
    let cancelled = false;
    void loadEngine().then((engine) => {
      if (!cancelled) setState({ key, html: cached(engine, lang, code) });
    });
    return () => {
      cancelled = true;
    };
  }, [key, lang, code]);
  return state && state.key === key ? state.html : null;
}
