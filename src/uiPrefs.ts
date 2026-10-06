import { useSyncExternalStore } from "react";
import {
  TRANSCRIPT_VIEW_MODES,
  type TranscriptViewMode,
} from "./focusView";
import {
  REASONING_EFFORTS,
  type DiffScope,
  type ReasoningEffort,
} from "./shared/ipc";

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

/**
 * Collapse large pastes into labeled cards (issue #381). On by default;
 * Settings → General → Display can turn it off so a paste lands in the textarea as text.
 */
const pasteCards = makeFlagPref("coder.pasteCards", true);
export const getPasteCardsEnabled = pasteCards.get;
export const setPasteCardsEnabled = pasteCards.set;
export const usePasteCardsEnabled = pasteCards.use;

/**
 * Vim-style motions in the composer textarea (issue #779). Off by default:
 * the typing path must stay ordinary unless the user opts in.
 */
const composerVim = makeFlagPref("coder.composerVim", false);
export const setComposerVimEnabled = composerVim.set;
export const useComposerVimEnabled = composerVim.use;

/**
 * Bare Enter sends and ⇧Enter is a newline. Off by default: Enter is a
 * newline and ⌘/Ctrl+Enter sends, as the composer has always done.
 */
const enterSends = makeFlagPref("coder.enterSends", false);
export const setEnterSendsEnabled = enterSends.set;
export const useEnterSendsEnabled = enterSends.use;

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

/** Mid-run composer action (issue #156). Queue is the predictable default. */
export type ComposerBusyAction = "queue" | "steer";
const BUSY_ACTION_KEY = "coder.composerBusyAction";
let busyAction: ComposerBusyAction | undefined;

export function getComposerBusyAction(): ComposerBusyAction {
  if (busyAction === undefined) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(BUSY_ACTION_KEY);
    } catch {
      raw = null;
    }
    busyAction = raw === "steer" ? "steer" : "queue";
  }
  return busyAction;
}

export function setComposerBusyAction(action: ComposerBusyAction): void {
  busyAction = action === "steer" ? "steer" : "queue";
  try {
    window.localStorage.setItem(BUSY_ACTION_KEY, busyAction);
  } catch {
    // Private mode / quota: the preference just stops surviving a relaunch.
  }
}

/** Git pane diff toggles (#1493): side-by-side, soft wrap, `git diff -w`. */
const diffSplit = makeFlagPref("coder.diffSplit", false);
export const setDiffSplit = diffSplit.set;
export const useDiffSplit = diffSplit.use;
const diffWrap = makeFlagPref("coder.diffWrap", false);
export const setDiffWrap = diffWrap.set;
export const useDiffWrap = diffWrap.use;
const diffIgnoreWs = makeFlagPref("coder.diffIgnoreWhitespace", false);
export const setDiffIgnoreWhitespace = diffIgnoreWs.set;
export const useDiffIgnoreWhitespace = diffIgnoreWs.use;

/**
 * User keybinding overrides (#1506): binding id → chord, e.g.
 * {"palette.command": "mod+e"}. Empty means every default applies. Shape is
 * checked here; chord validity and conflicts are src/keybindings.ts's job.
 */
const KEYBINDINGS_KEY = "coder.keybindings";
let keybindingOverrides: Readonly<Record<string, string>> | null = null;
const keybindingListeners = new Set<() => void>();
const NO_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({});

export function getKeybindingOverrides(): Readonly<Record<string, string>> {
  if (keybindingOverrides) return keybindingOverrides;
  const out: Record<string, string> = {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEYBINDINGS_KEY) || "{}");
    for (const [id, chord] of Object.entries(raw ?? {})) {
      if (typeof chord === "string") out[id] = chord;
    }
  } catch {
    // Corrupt or unavailable: the defaults apply.
  }
  keybindingOverrides = Object.keys(out).length ? out : NO_OVERRIDES;
  return keybindingOverrides;
}

export function setKeybindingOverrides(next: Record<string, string>): void {
  keybindingOverrides = Object.keys(next).length ? { ...next } : NO_OVERRIDES;
  try {
    if (keybindingOverrides === NO_OVERRIDES) {
      window.localStorage.removeItem(KEYBINDINGS_KEY);
    } else {
      window.localStorage.setItem(KEYBINDINGS_KEY, JSON.stringify(next));
    }
  } catch {
    // Private mode / quota: the remap just stops surviving a relaunch.
  }
  for (const l of keybindingListeners) l();
}

export function useKeybindingOverrides(): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    (onChange) => {
      keybindingListeners.add(onChange);
      return () => keybindingListeners.delete(onChange);
    },
    getKeybindingOverrides,
    () => NO_OVERRIDES,
  );
}

/** Git pane review scope per thread (#1493). Oldest threads drop past the cap. */
const DIFF_SCOPE_KEY = "coder.diffScope";
const DIFF_SCOPE_CAP = 200;
let diffScopes: Map<string, DiffScope> | null = null;

function loadDiffScopes(): Map<string, DiffScope> {
  if (diffScopes) return diffScopes;
  diffScopes = new Map();
  try {
    const raw = JSON.parse(window.localStorage.getItem(DIFF_SCOPE_KEY) || "{}");
    for (const [id, scope] of Object.entries(raw ?? {})) {
      if (scope === "branch" || scope === "turn") diffScopes.set(id, scope);
    }
  } catch {
    // Corrupt or unavailable: every thread starts on Uncommitted.
  }
  return diffScopes;
}

export function getDiffScope(threadId: string | null): DiffScope {
  return (threadId && loadDiffScopes().get(threadId)) || "uncommitted";
}

export function setDiffScope(threadId: string, scope: DiffScope): void {
  const map = loadDiffScopes();
  map.delete(threadId);
  if (scope !== "uncommitted") map.set(threadId, scope);
  while (map.size > DIFF_SCOPE_CAP) map.delete(map.keys().next().value!);
  try {
    window.localStorage.setItem(DIFF_SCOPE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Private mode / quota: the choice just stops surviving a relaunch.
  }
}
