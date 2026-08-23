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
 * Follow-up prompt with file/line context so the agent does not have to
 * hunt for "line 42 of foo.ts". Empty comments return "".
 */
export function formatDiffCommentPrompt(
  anchor: DiffCommentAnchor,
  comment: string,
): string {
  const body = comment.trim();
  if (!body) return "";
  const ref = commentLineRef(anchor);
  const where =
    ref == null
      ? `Comment on ${anchor.path}:`
      : ref.removed
        ? `Comment on ${anchor.path} (removed line ${ref.n}):`
        : `Comment on ${anchor.path}:${ref.n}:`;
  return `${where}\n\n    ${anchor.text}\n\n${body}`;
}
