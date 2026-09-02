import { useSyncExternalStore } from "react";
import {
  TRANSCRIPT_VIEW_MODES,
  type TranscriptViewMode,
} from "./focusView";
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
 * Transcript density (issue #461). Default is Normal: today's collapsed
 * tool cards. Summary hides settled-turn tools behind one line. Verbose
 * is the old #750 switch. `coder.verboseTools=on` still migrates to Verbose.
 */
const TRANSCRIPT_VIEW_KEY = "coder.transcriptView";
const VERBOSE_TOOLS_KEY = "coder.verboseTools";
let transcriptView: TranscriptViewMode | null = null;
const transcriptViewListeners = new Set<() => void>();

function parseTranscriptView(raw: string | null): TranscriptViewMode | null {
  return TRANSCRIPT_VIEW_MODES.includes(raw as TranscriptViewMode)
    ? (raw as TranscriptViewMode)
    : null;
}

export function getTranscriptViewMode(): TranscriptViewMode {
  if (transcriptView != null) return transcriptView;
  try {
    const stored = parseTranscriptView(
      window.localStorage.getItem(TRANSCRIPT_VIEW_KEY),
    );
    if (stored) {
      transcriptView = stored;
      return stored;
    }
    if (window.localStorage.getItem(VERBOSE_TOOLS_KEY) === "on") {
      transcriptView = "verbose";
      return "verbose";
    }
  } catch {
    // Private mode / quota: fall through to the default.
  }
  transcriptView = "normal";
  return "normal";
}

export function setTranscriptViewMode(mode: TranscriptViewMode): void {
  transcriptView = mode;
  try {
    window.localStorage.setItem(TRANSCRIPT_VIEW_KEY, mode);
    window.localStorage.setItem(
      VERBOSE_TOOLS_KEY,
      mode === "verbose" ? "on" : "off",
    );
  } catch {
    // Private mode / quota: the toggle just stops persisting.
  }
  for (const listener of transcriptViewListeners) listener();
}

export function useTranscriptViewMode(): TranscriptViewMode {
  return useSyncExternalStore(
    (onChange) => {
      transcriptViewListeners.add(onChange);
      return () => transcriptViewListeners.delete(onChange);
    },
    getTranscriptViewMode,
    () => "normal",
  );
}

export function getVerboseToolCards(): boolean {
  return getTranscriptViewMode() === "verbose";
}

export function setVerboseToolCards(on: boolean): void {
  setTranscriptViewMode(on ? "verbose" : "normal");
}

export function useVerboseToolCards(): boolean {
  return useTranscriptViewMode() === "verbose";
}

/**
 * Collapse large pastes into labeled cards (issue #381). On by default;
 * Environment can turn it off so a paste lands in the textarea as text.
 */
const pasteCards = makeFlagPref("coder.pasteCards", true);
export const getPasteCardsEnabled = pasteCards.get;
export const setPasteCardsEnabled = pasteCards.set;
export const usePasteCardsEnabled = pasteCards.use;

/** Opt-in vim motions in the composer textarea (issue #779). Off by default. */
const composerVim = makeFlagPref("coder.composerVim", false);
export const getComposerVimEnabled = composerVim.get;
export const setComposerVimEnabled = composerVim.set;
export const useComposerVimEnabled = composerVim.use;

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
