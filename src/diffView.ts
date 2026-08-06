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
