import { useSyncExternalStore } from "react";
import { REASONING_EFFORTS, type ReasoningEffort } from "./shared/ipc";

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

/**
 * Expand every tool card in the open transcript (issue #750). Off by default;
 * the latest running tool still auto-expands even when this is off.
 */
const verboseTools = makeFlagPref("coder.verboseTools", false);
export const getVerboseToolCards = verboseTools.get;
export const setVerboseToolCards = verboseTools.set;
export const useVerboseToolCards = verboseTools.use;

/**
 * Collapse large pastes into labeled cards (issue #381). On by default;
 * Environment can turn it off so a paste lands in the textarea as text.
 */
const pasteCards = makeFlagPref("coder.pasteCards", true);
export const getPasteCardsEnabled = pasteCards.get;
export const setPasteCardsEnabled = pasteCards.set;
export const usePasteCardsEnabled = pasteCards.use;

/**
 * The last reasoning level the user picked, remembered across harness switches.
 *
 * Effort lives on the thread, and setProvider (electron/services.js) has to
 * clear it when the new harness does not advertise that level — a level the CLI
 * would never receive must not keep showing in the pill. That made the choice
 * unrecoverable: claude/Max → codex (no Max) → back to claude came back as
 * Default. This remembers the intent so the switch back restores it.
 */
const EFFORT_KEY = "coder.lastReasoningEffort";
let lastEffort: ReasoningEffort | null | undefined;

export function getLastReasoningEffort(): ReasoningEffort | null {
  if (lastEffort === undefined) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(EFFORT_KEY);
    } catch {
      raw = null;
    }
    lastEffort = REASONING_EFFORTS.includes(raw as ReasoningEffort)
      ? (raw as ReasoningEffort)
      : null;
  }
  return lastEffort;
}

export function setLastReasoningEffort(effort: ReasoningEffort | null): void {
  lastEffort = effort;
  try {
    if (effort == null) window.localStorage.removeItem(EFFORT_KEY);
    else window.localStorage.setItem(EFFORT_KEY, effort);
  } catch {
    // Private mode / quota: the preference just stops surviving a relaunch.
  }
}
