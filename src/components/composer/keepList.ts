import type { Dispatch, SetStateAction } from "react";
import { syncListRecord } from "../../composerSession";

export function keepList<T>(
  store: Record<string, T[]>,
  set: Dispatch<SetStateAction<Record<string, T[]>>>,
): Dispatch<SetStateAction<Record<string, T[]>>> {
  return (action) => {
    set((prev) => {
      const next = typeof action === "function" ? action(prev) : action;
      syncListRecord(store, next);
      return next;
    });
  };
}
