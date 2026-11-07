/**
 * Detect repo-relative / absolute file paths in transcript text so the
 * renderer can turn existing ones into openable links (#492).
 *
 * Pure: no IPC, no fs. Existence and worktree membership are injected.
 */

export interface PathRef {
  /** Matched text, including an optional `:line` / `:line:col` suffix. */
  raw: string;
  /** Path with the line suffix stripped. */
  path: string;
  line?: number;
  col?: number;
  start: number;
  end: number;
}

const URL_RE = /https?:\/\/\S+|file:\/\/\S+|mailto:\S+/gi;

/** Token body: path characters, plus `:` so `C:\` and `:12` stay attached. */
const PATH_CHAR = /[A-Za-z0-9_./\\@+~:$()[\]…-]/;

/** Ranges covered by a URL; shared with githubRefs.ts so a ref inside a link is never double-matched. */
export function urlRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

export function inRange(
  ranges: Array<{ start: number; end: number }>,
  i: number,
): boolean {
  return ranges.some((r) => i >= r.start && i < r.end);
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  return !PATH_CHAR.test(text[i - 1]);
}

function stripTrailingDots(s: string): string {
  const last = s.split(/[/\\]/).at(-1);
  if (last && /^\.+$/.test(last)) return s;
  return s.replace(/\.+$/, "");
}

function trimPathToken(raw: string): { token: string; offset: number } {
  let token = stripTrailingDots(raw);
  let offset = 0;
  for (const [open, close] of [["(", ")"], ["[", "]"]]) {
    if (token.startsWith(open)) {
      let depth = 0;
      let end = -1;
      for (let i = 0; i < token.length; i++) {
        if (token[i] === open) depth++;
        if (token[i] === close && --depth === 0) {
          end = i;
          break;
        }
      }
      if (end === token.length - 1) {
        token = token.slice(1, -1);
        offset++;
      }
    }
    const count = (char: string) => token.split(char).length - 1;
    let excess = count(close) - count(open);
    while (excess-- > 0 && token.endsWith(close)) token = token.slice(0, -1);
  }
  return { token, offset };
}

/**
 * Pull a `:line` / `:line:col` suffix off a token without eating a Windows
 * drive letter (`C:\foo`).
 */
export function splitLineSuffix(raw: string): {
  path: string;
  line?: number;
  col?: number;
} {
  const m = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!m) return { path: raw };
  // `C:` alone is a drive, not `file:12`.
  if (/^[A-Za-z]$/.test(m[1])) return { path: raw };
  return {
    path: m[1],
    line: Number(m[2]),
    col: m[3] != null ? Number(m[3]) : undefined,
  };
}

function hasSep(p: string): boolean {
  return p.includes("/") || p.includes("\\");
}

function fileExt(p: string): string | null {
  const base = p.split(/[/\\]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1);
}

/** `@scope/pkg` with no file extension is an npm name, not a path. */
function isNpmScoped(p: string): boolean {
  if (!p.startsWith("@")) return false;
  if (fileExt(p)) return false;
  return /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(p);
}

function looksLikePath(p: string): boolean {
  if (!p || p === "." || p === ".." || p === "/" || p === "\\") return false;
  if (isNpmScoped(p)) return false;
  if (p.startsWith("~/") || p.startsWith("~\\")) return true;
  if (hasSep(p)) return true;
  const ext = fileExt(p);
  // Bare names need a 2+ char extension so `e.g.` / `i.e.` stay plain.
  return Boolean(ext && ext.length >= 2);
}

export function findPathRefs(text: string): PathRef[] {
  const blocked = urlRanges(text);
  const hits: PathRef[] = [];
  let i = 0;
  while (i < text.length) {
    if (inRange(blocked, i) || !PATH_CHAR.test(text[i]) || !isBoundary(text, i)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < text.length && PATH_CHAR.test(text[j]) && !inRange(blocked, j)) {
      j += 1;
    }
    const trimmed = trimPathToken(text.slice(i, j));
    const untrimmedPath = splitLineSuffix(trimmed.token).path;
    if (untrimmedPath.split(/[/\\]/).some((part) => /^(?:\.{3,}|…+)$/.test(part))) {
      i = j;
      continue;
    }
    let token = stripTrailingDots(trimmed.token);
    // Trailing `:` that is not a line suffix (e.g. `path:` in JSON keys).
    if (token.endsWith(":") && !/:\d+$/.test(token)) {
      token = token.slice(0, -1);
    }
    const { path, line, col } = splitLineSuffix(token);
    if (looksLikePath(path)) {
      const raw = token;
      hits.push({
        raw,
        path,
        line,
        col,
        start: i + trimmed.offset,
        end: i + trimmed.offset + raw.length,
      });
      i = j;
      continue;
    }
    i = j;
  }
  return hits;
}

export function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  return false;
}

function sepFor(root: string): "/" | "\\" {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

export function joinWorkspacePath(root: string, candidate: string): string {
  const sep = sepFor(root);
  const normRoot = root.replace(/[\\/]+$/, "");
  const rel = candidate.replace(/^\.[\\/]/, "").replace(/\\/g, sep).replace(/\//g, sep);
  return `${normRoot}${sep}${rel}`;
}

export function isInsideRoot(root: string, abs: string): boolean {
  const sep = sepFor(root);
  const normRoot = root.replace(/[\\/]+$/, "");
  if (abs === normRoot) return true;
  const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep;
  return abs.startsWith(prefix);
}

/**
 * Resolve `candidate` against the thread worktree. Missing files, and
 * paths that escape the root, return null.
 */
export function resolveWorkspacePath(
  root: string,
  candidate: string,
  exists: (abs: string) => boolean,
): string | null {
  if (!root || !candidate) return null;
  const abs =
    isAbsolutePath(candidate) || candidate.startsWith("~")
      ? candidate
      : joinWorkspacePath(root, candidate);
  if (!exists(abs)) return null;
  if (!isInsideRoot(root, abs)) return null;
  return abs;
}
