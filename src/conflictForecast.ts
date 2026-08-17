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
