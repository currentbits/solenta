import { useSyncExternalStore } from "react";

/**
 * Boolean display preferences toggled from the Environment tab. Module state
 * is the source of truth (so a toggle works even when localStorage does not
 * persist); localStorage carries it across launches. Both default off — they
 * are opt-in chrome, not part of the default thread view.
 */
function makeFlagPref(key: string, defaultOn: boolean) {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();

  function get(): boolean {
    if (value == null) {
      try {
        const raw = window.localStorage.getItem(key);
        value = raw == null ? defaultOn : raw === "on";
      } catch {
        value = defaultOn;
      }
    }
    return value;
  }

  function set(on: boolean): void {
    value = on;
    try {
      window.localStorage.setItem(key, on ? "on" : "off");
    } catch {
      // Private mode / quota: the toggle just stops persisting.
    }
    for (const l of listeners) l();
  }

  function useFlag(): boolean {
    return useSyncExternalStore(
      (onChange) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      get,
      () => defaultOn,
    );
  }

  return { get, set, use: useFlag };
}

/** Thread-header divergence compare card (#393). */
const divergenceCard = makeFlagPref("coder.divergenceCard", false);
export const getDivergenceCardEnabled = divergenceCard.get;
export const setDivergenceCardEnabled = divergenceCard.set;
export const useDivergenceCardEnabled = divergenceCard.use;

/** "1m 45s" segment in the assistant message footer at the end of a run. */
const runDuration = makeFlagPref("coder.runDuration", false);
export const getRunDurationEnabled = runDuration.get;
export const setRunDurationEnabled = runDuration.set;
export const useRunDurationEnabled = runDuration.use;
