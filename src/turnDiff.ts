import {
  annotateHunkLines,
  type AnnotatedDiffLine,
  type DiffLineKind,
} from "./diffView";

/** Review-bar patch layout. Unified is the Git pane default; split is side-by-side. */
export type DiffViewMode = "unified" | "split";

export interface SplitCell {
  kind: DiffLineKind | "empty";
  /** Body text without the unified-diff +/-/space prefix. */
  text: string;
  /** 1-based line on this side, or null for empty / markers. */
  line: number | null;
}

export interface SplitRow {
  left: SplitCell;
  right: SplitCell;
}

const EMPTY_CELL: SplitCell = { kind: "empty", text: "", line: null };

/** Strip the unified-diff prefix so split cells read like file contents. */
export function splitLineText(text: string, kind: DiffLineKind): string {
  if (kind === "add" || kind === "del") return text.slice(1);
  if (kind === "ctx" && text.startsWith(" ")) return text.slice(1);
  return text;
}

function leftCell(line: AnnotatedDiffLine): SplitCell {
  return {
    kind: line.kind,
    text: splitLineText(line.text, line.kind),
    line: line.oldLine,
  };
}

function rightCell(line: AnnotatedDiffLine): SplitCell {
  return {
    kind: line.kind,
    text: splitLineText(line.text, line.kind),
    line: line.newLine,
  };
}

/** Indices into annotated hunk lines for one side-by-side row. */
export interface SplitRowIndex {
  left: number | null;
  right: number | null;
}

/**
 * Pair annotated hunk lines into aligned left (old) / right (new) rows.
 * Consecutive deletions zip with the additions that follow; context spans both.
 */
export function splitRowIndices(lines: AnnotatedDiffLine[]): SplitRowIndex[] {
  const rows: SplitRowIndex[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flushChange = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  lines.forEach((line, i) => {
    if (line.kind === "del") dels.push(i);
    else if (line.kind === "add") adds.push(i);
    else {
      flushChange();
      rows.push({ left: i, right: i });
    }
  });
  flushChange();
  return rows;
}

/** {@link splitRowIndices} as display cells for one hunk. */
export function splitHunkRows(header: string, body: string): SplitRow[] {
  const lines = annotateHunkLines(header, body);
  return splitRowIndices(lines).map(({ left, right }) => ({
    left: left == null ? EMPTY_CELL : leftCell(lines[left]!),
    right: right == null ? EMPTY_CELL : rightCell(lines[right]!),
  }));
}
