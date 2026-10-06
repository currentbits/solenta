import type { DiffResult } from "./shared/ipc";

/** Tint kind for one line of a unified patch. */
export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

/**
 * Classify a unified-diff line for tinted rendering.
 * +++ / --- file headers are meta (not add/del).
 */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** True when the result has no files and no patch body. */
export function isEmptyDiff(diff: DiffResult): boolean {
  return diff.files.length === 0 && !diff.patch.trim();
}

export interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `@@ -old,count +new,count @@`. Missing counts default to 1. */
export function parseHunkHeader(line: string): HunkHeader | null {
  const m = HUNK_HEADER_RE.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] == null ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] == null ? 1 : Number(m[4]),
  };
}

export interface AnnotatedDiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based old-file line, or null for additions / markers. */
  oldLine: number | null;
  /** 1-based new-file line, or null for deletions / markers. */
  newLine: number | null;
  commentable: boolean;
}

/**
 * Classify a hunk *body* line. Unlike diffLineKind, `+++` / `---` here are
 * added/removed content, not file headers.
 */
function hunkBodyKind(line: string): DiffLineKind {
  if (line.startsWith("\\")) return "ctx";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function splitBody(body: string): string[] {
  const lines = body.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Walk a hunk body and stamp each line with old/new numbers. */
export function annotateHunkLines(
  header: string,
  body: string,
): AnnotatedDiffLine[] {
  const parsed = parseHunkHeader(header);
  let oldLine = parsed?.oldStart ?? 0;
  let newLine = parsed?.newStart ?? 0;
  const out: AnnotatedDiffLine[] = [];
  for (const text of splitBody(body)) {
    if (text.startsWith("\\")) {
      out.push({
        kind: "ctx",
        text,
        oldLine: null,
        newLine: null,
        commentable: false,
      });
      continue;
    }
    const kind = hunkBodyKind(text);
    if (kind === "add") {
      out.push({
        kind,
        text,
        oldLine: null,
        newLine: parsed ? newLine : null,
        commentable: true,
      });
      if (parsed) newLine += 1;
    } else if (kind === "del") {
      out.push({
        kind,
        text,
        oldLine: parsed ? oldLine : null,
        newLine: null,
        commentable: true,
      });
      if (parsed) oldLine += 1;
    } else {
      out.push({
        kind,
        text,
        oldLine: parsed ? oldLine : null,
        newLine: parsed ? newLine : null,
        commentable: true,
      });
      if (parsed) {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return out;
}

export interface DiffCommentAnchor {
  path: string;
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Display line for a comment: new-file for add/ctx, old-file for deletions. */
export function commentLineRef(
  anchor: Pick<DiffCommentAnchor, "kind" | "oldLine" | "newLine">,
): { n: number; removed: boolean } | null {
  if (anchor.kind === "del" && anchor.oldLine != null) {
    return { n: anchor.oldLine, removed: true };
  }
  if (anchor.newLine != null) return { n: anchor.newLine, removed: false };
  if (anchor.oldLine != null) return { n: anchor.oldLine, removed: true };
  return null;
}

export function commentGutterLabel(
  anchor: Pick<DiffCommentAnchor, "kind" | "oldLine" | "newLine">,
): string {
  const ref = commentLineRef(anchor);
  if (ref == null) return "Comment on this line";
  if (ref.removed) return `Comment on removed line ${ref.n}`;
  return `Comment on line ${ref.n}`;
}

/**
 * A diff comment held in the composer draft until the next send (#1493).
 * Lines are new-file numbers, or old-file ones when only removed lines
 * were picked (`removed`). `code` is the selected diff text.
 */
export interface ReviewComment {
  id: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  removed: boolean;
  code: string;
  text: string;
}

/** Lines of the comment excerpt sent to the agent. */
export const REVIEW_CODE_LINES = 12;

/** Turn one or more picked diff rows (same file, in order) into a comment. */
export function reviewCommentFromAnchors(
  anchors: DiffCommentAnchor[],
  text: string,
  id: string,
): ReviewComment {
  const refs = anchors
    .map(commentLineRef)
    .filter((r): r is { n: number; removed: boolean } => r != null);
  const kept = refs.filter((r) => !r.removed);
  const lines = kept.length ? kept : refs;
  return {
    id,
    path: anchors[0]!.path,
    startLine: lines[0]?.n ?? null,
    endLine: lines[lines.length - 1]?.n ?? null,
    removed: !kept.length && refs.length > 0,
    code: anchors.map((a) => a.text).join("\n"),
    text: text.trim(),
  };
}

/** `src/a.ts:L12-18`, `src/a.ts:L12`, `src/a.ts (removed L4)`. */
export function reviewCommentLabel(
  c: Pick<ReviewComment, "path" | "startLine" | "endLine" | "removed">,
): string {
  if (c.startLine == null) return c.path;
  const span =
    c.endLine != null && c.endLine !== c.startLine
      ? `L${c.startLine}-${c.endLine}`
      : `L${c.startLine}`;
  return c.removed ? `${c.path} (removed ${span})` : `${c.path}:${span}`;
}

/**
 * The comments as one block ahead of the user's text, so five comments are
 * one turn. Each carries its file/line and a short excerpt of the code so
 * the agent does not have to hunt for "line 42 of foo.ts".
 */
export function formatReviewCommentsPrompt(comments: ReviewComment[]): string {
  const live = comments.filter((c) => c.text.trim());
  if (!live.length) return "";
  const blocks = live.map((c) => {
    const lines = c.code.split("\n");
    const shown = lines.slice(0, REVIEW_CODE_LINES).map((l) => `    ${l}`);
    if (lines.length > shown.length) {
      shown.push(`    … ${lines.length - shown.length} more lines`);
    }
    return `${reviewCommentLabel(c)}\n${shown.join("\n")}\n\n${c.text.trim()}`;
  });
  const head = live.length === 1 ? "Review comment:" : "Review comments:";
  return `${head}\n\n${blocks.join("\n\n")}`;
}
