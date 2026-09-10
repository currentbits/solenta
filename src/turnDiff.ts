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

/**
 * Pair a hunk body into aligned left (old) / right (new) rows.
 * Consecutive deletions zip with the additions that follow; context spans both.
 */
export function splitHunkRows(header: string, body: string): SplitRow[] {
  const lines = annotateHunkLines(header, body);
  const rows: SplitRow[] = [];
  let dels: AnnotatedDiffLine[] = [];
  let adds: AnnotatedDiffLine[] = [];

  const flushChange = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const del = dels[i];
      const add = adds[i];
      rows.push({
        left: del ? leftCell(del) : EMPTY_CELL,
        right: add ? rightCell(add) : EMPTY_CELL,
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.kind === "del") {
      dels.push(line);
      continue;
    }
    if (line.kind === "add") {
      adds.push(line);
      continue;
    }
    flushChange();
    rows.push({
      left: leftCell(line),
      right: rightCell(line),
    });
  }
  flushChange();
  return rows;
}
