import type { ConflictForecast, ConflictPairInfo } from "./shared/ipc";

/** Pairs in `forecast` that mention `threadId` as either side. */
export function pairsForThread(
  forecast: ConflictForecast | null | undefined,
  threadId: string,
): ConflictPairInfo[] {
  if (!forecast) return [];
  return forecast.pairs.filter(
    (pair) => pair.threadA === threadId || pair.threadB === threadId,
  );
}

const FILE_CAP = 4;

/** One other thread in the hover explanation (#516). */
export interface ForecastHoverLine {
  otherId: string;
  name: string;
  /** Hard collide vs same files that still auto-merge. */
  kind: "conflict" | "overlap";
  files: string[];
  extra: number;
}

/**
 * Hover copy for the conflict/overlap pill. One line per other thread.
 * Conflicts list colliding files; overlap-only pairs list the shared files.
 */
export function forecastHoverLines(
  pairs: readonly ConflictPairInfo[],
  threadId: string,
  titles?: ReadonlyMap<string, string>,
): ForecastHoverLine[] {
  return pairs.map((pair) => {
    const other = pair.threadA === threadId ? pair.threadB : pair.threadA;
    const hard = pair.conflicts.length > 0;
    const raw = hard ? pair.conflicts : pair.overlap;
    return {
      otherId: other,
      name: titles?.get(other) ?? other,
      kind: hard ? "conflict" : "overlap",
      files: raw.slice(0, FILE_CAP),
      extra: Math.max(0, raw.length - FILE_CAP),
    };
  });
}

/** `beta work — src/a.ts` or `overlaps gamma work — src/c.ts`. */
export function formatForecastHoverLine(line: ForecastHoverLine): string {
  const files =
    line.files.length === 0
      ? ""
      : `${line.files.join(", ")}${line.extra > 0 ? ` +${line.extra} more` : ""}`;
  if (line.kind === "conflict") {
    return files ? `${line.name} — ${files}` : line.name;
  }
  return files ? `overlaps ${line.name} — ${files}` : `overlaps ${line.name}`;
}
