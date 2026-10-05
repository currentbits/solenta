import { useMemo, useRef } from "react";
import type { ThreadInfo } from "../../shared/ipc";

/** id → title map that keeps its identity until a title actually changes. */
export function useStableThreadTitles(
  threads: ThreadInfo[],
): Map<string, string> {
  const threadTitlesRef = useRef<Map<string, string>>(new Map());
  const threadTitles = useMemo(() => {
    const prev = threadTitlesRef.current;
    let same = prev.size === threads.length;
    if (same) {
      for (const t of threads) {
        if (prev.get(t.id) !== t.title) {
          same = false;
          break;
        }
      }
    }
    if (same) return prev;
    const titles = new Map<string, string>();
    for (const t of threads) titles.set(t.id, t.title);
    threadTitlesRef.current = titles;
    return titles;
  }, [threads]);
  return threadTitles;
}
