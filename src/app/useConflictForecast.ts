import {
  useEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ConflictForecast, ThreadInfo } from "../shared/ipc";

export const EMPTY_FORECAST: ConflictForecast = { pairs: [], computedAt: 0 };

/** Keeps the conflict forecast for the selected project fresh. */
export function useConflictForecast({
  threads,
  selectedProjectId,
  conflictForecast,
  setForecast,
}: {
  threads: ThreadInfo[];
  selectedProjectId: string | null;
  conflictForecast: (projectId: string) => Promise<ConflictForecast>;
  setForecast: Dispatch<SetStateAction<ConflictForecast>>;
}): void {
  // Issue #249: refetch the cached forecast when the thread list moves.
  // Keyed on a cheap derived value, not the live `threads` array: the array
  // identity changes on every 700ms stream tick, which used to fire this IPC
  // call ~1.4x/sec for the duration of any run.
  const forecastKey = useMemo(
    () =>
      threads
        .map((t) => `${t.id}:${t.branch ?? ""}:${t.worktreePath ?? ""}`)
        .join("|"),
    [threads],
  );
  useEffect(() => {
    if (!selectedProjectId) {
      setForecast(EMPTY_FORECAST);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void conflictForecast(selectedProjectId).then((next) => {
        if (!cancelled) setForecast(next);
      });
    };
    refresh();
    // Git state can move without branch/worktree changing (merges, pulls), so
    // also refresh when the window regains focus — no steady-state timer.
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selectedProjectId, forecastKey, conflictForecast]);
}
