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

const idle: (cb: () => void) => number =
  typeof requestIdleCallback === "function"
    ? (cb) => requestIdleCallback(cb, { timeout: 120 })
    : (cb) => window.setTimeout(cb, 0);
const cancelIdle: (id: number) => void =
  typeof cancelIdleCallback === "function" ? cancelIdleCallback : clearTimeout;

/**
 * Per-line highlighted HTML (null = plain) for `codes`, filled in idle
 * slices once the engine loads. Pass a memoized array: identity is the key.
 * ponytail: lines are highlighted one at a time, so a block comment that
 * opens above a hunk is not coloured. Highlight whole sides if that bites.
 */
export function useHighlightedLines(
  lang: string | null,
  codes: string[],
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
    void loadEngine().then((engine) => {
      let i = 0;
      const step = () => {
        if (cancelled) return;
        const end = Math.min(codes.length, i + SLICE);
        for (; i < end; i++) {
          const code = codes[i]!;
          html[i] = code.length > MAX_LINE ? null : cached(engine, lang, code);
        }
        setState({ codes, html: html.slice() });
        if (i < codes.length) handle = idle(step);
      };
      step();
    });
    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
  }, [lang, codes]);
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
