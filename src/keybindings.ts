/**
 * The app's keyboard shortcuts in one table (#1506 H2), plus the chord
 * parser, matcher and formatter every handler and the keyboard sheet share.
 *
 * Chords are lowercase "+"-joined tokens: modifiers then one key, e.g.
 * "mod+shift+f". `mod` is ⌘ on mac and Ctrl elsewhere, and (as every handler
 * did before the table) it matches either key so nobody's muscle memory
 * breaks. `ctrl`, `meta`, `alt` and `shift` are literal.
 *
 * Users override chords by id in Settings › Keyboard (stored in uiPrefs).
 * Rows with `keys` instead of `chord` are display-only: gestures, ranges or
 * keys whose meaning depends on state, so they are not remappable.
 *
 * Keep this module free of React so handlers can read it at event time.
 */
import { getKeybindingOverrides } from "./uiPrefs";

export type KeybindingScope = "window" | "list" | "composer";

export interface KeybindingDef {
  id: string;
  label: string;
  scope: KeybindingScope;
  /** Remappable default; a pair when the platform convention differs. */
  chord?: string | { mac: string; other: string };
  /** Display-only row in chord syntax, e.g. "mod+click". */
  keys?: string;
}

export const KEYBINDINGS: readonly KeybindingDef[] = [
  { id: "thread.new", label: "New thread", scope: "list", chord: "mod+n" },
  {
    id: "thread.newInProject",
    label: "New thread in current project",
    scope: "list",
    chord: "mod+shift+n",
  },
  {
    id: "thread.multiSelect",
    label: "Toggle thread in multi-select",
    scope: "list",
    keys: "mod+click",
  },
  {
    id: "thread.rangeSelect",
    label: "Select range in visible list",
    scope: "list",
    keys: "shift+click",
  },
  {
    id: "thread.jump",
    label: "Jump to nth visible thread",
    scope: "list",
    keys: "mod+1…9",
  },
  { id: "thread.next", label: "Next thread", scope: "list", chord: "mod+j" },
  {
    id: "thread.prev",
    label: "Previous thread",
    scope: "list",
    chord: "mod+shift+j",
  },
  {
    id: "history.back",
    label: "Back to the previous thread",
    scope: "window",
    chord: { mac: "meta+[", other: "alt+arrowleft" },
  },
  {
    id: "history.forward",
    label: "Forward again",
    scope: "window",
    chord: { mac: "meta+]", other: "alt+arrowright" },
  },
  {
    id: "palette.command",
    label: "Command palette",
    scope: "window",
    chord: "mod+k",
  },
  {
    id: "palette.files",
    label: "Search files in this project",
    scope: "window",
    chord: "mod+p",
  },
  {
    id: "palette.content",
    label: "Search file contents",
    scope: "window",
    chord: "mod+shift+f",
  },
  {
    id: "composer.send",
    label: "Send message",
    scope: "composer",
    keys: "mod+enter",
  },
  {
    id: "composer.recall",
    label: "Recall the last sent prompt (empty composer)",
    scope: "composer",
    keys: "arrowup",
  },
  {
    id: "composer.btw",
    label: "Ask a side question (/btw)",
    scope: "composer",
    chord: "alt+enter",
  },
  {
    id: "composer.steer",
    label: "Steer the live turn",
    scope: "composer",
    chord: "mod+shift+enter",
  },
  {
    id: "composer.stash",
    label: "Stash the draft",
    scope: "composer",
    chord: "mod+s",
  },
  {
    id: "composer.unstash",
    label: "Restore the stashed draft",
    scope: "composer",
    chord: "mod+shift+s",
  },
  {
    id: "composer.stop",
    label: "Stop the live turn · close menus",
    scope: "composer",
    keys: "escape",
  },
  {
    id: "composer.rewind",
    label: "Rewind the last turn",
    scope: "composer",
    keys: "Escape Escape",
  },
  {
    id: "composer.interrupt",
    label: "Stop the live turn",
    scope: "composer",
    keys: "ctrl+c",
  },
  {
    id: "message.cite",
    label: "Cite the selection in a reply",
    scope: "window",
    chord: "mod+shift+c",
  },
  {
    id: "undo",
    label: "Undo the last settle, snooze or archive",
    scope: "window",
    chord: "mod+z",
  },
  {
    id: "transcript.summary",
    label: "Toggle the summary transcript",
    scope: "window",
    chord: "ctrl+alt+f",
  },
  {
    id: "transcript.cycle",
    label: "Cycle the transcript view",
    scope: "window",
    chord: "ctrl+o",
  },
  {
    id: "keyboard.sheet",
    label: "Show this keyboard reference",
    scope: "list",
    chord: "?",
  },
  {
    id: "sidebar.toggle",
    label: "Toggle sidebar",
    scope: "window",
    chord: "mod+b",
  },
  {
    id: "pane.close",
    label: "Close the focused pane",
    scope: "window",
    chord: "mod+\\",
  },
  {
    id: "agents.toggle",
    label: "Toggle agents panel",
    scope: "window",
    chord: "mod+.",
  },
];

const BY_ID = new Map(KEYBINDINGS.map((def) => [def.id, def]));

let macOverride: boolean | null = null;

/** Test seam: force mac (true), other (false) or detection (null). */
export function setMacPlatformForTests(mac: boolean | null): void {
  macOverride = mac;
}

export function isMacPlatform(): boolean {
  if (macOverride != null) return macOverride;
  return (
    typeof navigator !== "undefined" &&
    /Mac/i.test(navigator.platform || navigator.userAgent || "")
  );
}

export interface Chord {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const MODIFIERS = new Set(["mod", "ctrl", "meta", "alt", "shift"]);
const chordCache = new Map<string, Chord | null>();

/** "mod+shift+f" → Chord, or null when it is not one modifier set + one key. */
export function parseChord(text: string): Chord | null {
  const cached = chordCache.get(text);
  if (cached !== undefined) return cached;
  let chord: Chord | null = null;
  const tokens = text.trim().toLowerCase().split("+");
  const key = tokens.pop() ?? "";
  if (key && !MODIFIERS.has(key) && !/\s/.test(key)) {
    chord = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key };
    for (const t of tokens) {
      if (!MODIFIERS.has(t) || chord[t as keyof Omit<Chord, "key">]) {
        chord = null;
        break;
      }
      chord[t as keyof Omit<Chord, "key">] = true;
    }
  }
  chordCache.set(text, chord);
  return chord;
}

/** Punctuation is shifted on some layouts ("?"), so shift only counts when named. */
function shiftAgnostic(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> & { code?: string };

export function matchesChord(e: KeyLike, chord: Chord): boolean {
  const key = e.key.toLowerCase();
  // Option on mac turns letters into symbols (⌥F is "ƒ"); fall back to code.
  const code = (e.code ?? "").toLowerCase().replace(/^(key|digit)/, "");
  if (key !== chord.key && !(e.altKey && code === chord.key)) return false;
  if (e.altKey !== chord.alt) return false;
  if (chord.shift ? !e.shiftKey : e.shiftKey && !shiftAgnostic(chord.key)) {
    return false;
  }
  if (chord.mod) return e.metaKey || e.ctrlKey;
  return e.metaKey === chord.meta && e.ctrlKey === chord.ctrl;
}

function defaultChord(def: KeybindingDef, mac: boolean): string | null {
  if (!def.chord) return null;
  return typeof def.chord === "string" ? def.chord : mac ? def.chord.mac : def.chord.other;
}

/** id → chord after overrides; display-only rows are absent. */
export function effectiveChords(
  overrides: Readonly<Record<string, string>> = getKeybindingOverrides(),
  mac = isMacPlatform(),
): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of KEYBINDINGS) {
    const base = defaultChord(def, mac);
    if (base == null) continue;
    const custom = overrides[def.id];
    out.set(def.id, custom != null && parseChord(custom) ? custom : base);
  }
  return out;
}

export function chordFor(id: string): string | null {
  const def = BY_ID.get(id);
  if (!def) return null;
  const mac = isMacPlatform();
  const custom = getKeybindingOverrides()[id];
  if (def.chord && custom != null && parseChord(custom)) return custom;
  return defaultChord(def, mac);
}

/** True when `e` is the (possibly remapped) chord for binding `id`. */
export function matchesBinding(e: KeyLike, id: string): boolean {
  const text = chordFor(id);
  const chord = text ? parseChord(text) : null;
  return chord != null && matchesChord(e, chord);
}

const KEY_NAMES: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  enter: "Enter",
  escape: "Escape",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
};

/**
 * "mod+shift+f" → "⌘ + ⇧ + F" on mac, "Ctrl + Shift + F" elsewhere.
 * `compact` drops the spacing for palette hints ("⌘⇧F", "Ctrl+Shift+F").
 */
export function formatChord(
  text: string,
  mac = isMacPlatform(),
  compact = false,
): string {
  const names: Record<string, string> = {
    mod: mac ? "⌘" : "Ctrl",
    meta: mac ? "⌘" : "Meta",
    ctrl: "Ctrl",
    alt: mac ? "⌥" : "Alt",
    shift: mac ? "⇧" : "Shift",
  };
  const parts = text.split("+").map((token) => {
    const t = token.toLowerCase();
    return names[t] ?? KEY_NAMES[t] ?? (token.length === 1 ? token.toUpperCase() : token);
  });
  if (!compact) return parts.join(" + ");
  return parts.join(mac ? "" : "+");
}

/** Display text for any row, remapped or not. */
export function bindingLabel(id: string, compact = false): string | null {
  const def = BY_ID.get(id);
  const text = def?.keys ?? chordFor(id);
  return text ? formatChord(text, isMacPlatform(), compact) : null;
}

/** Same physical keys? ctrl/meta fold into mod since `mod` matches either. */
function conflictKey(chord: Chord): string {
  const mod = chord.mod || chord.ctrl || chord.meta;
  const shift = chord.shift && !shiftAgnostic(chord.key);
  return `${mod ? "mod+" : ""}${chord.alt ? "alt+" : ""}${shift ? "shift+" : ""}${chord.key}`;
}

/** Groups of ids that would fire on the same keys, e.g. [["undo", "thread.new"]]. */
export function findConflicts(chords: Map<string, string>): string[][] {
  const groups = new Map<string, string[]>();
  for (const [id, text] of chords) {
    const chord = parseChord(text);
    if (!chord) continue;
    const k = conflictKey(chord);
    groups.set(k, [...(groups.get(k) ?? []), id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

/**
 * Validates the Settings › Keyboard JSON. Bad entries are reported and
 * dropped; the rest still apply.
 */
export function parseOverrides(json: string): {
  overrides: Record<string, string>;
  errors: string[];
} {
  const overrides: Record<string, string> = {};
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = json.trim() ? JSON.parse(json) : {};
  } catch (err) {
    return { overrides, errors: [`Not valid JSON: ${(err as Error).message}`] };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { overrides, errors: ['Expected an object like {"palette.command": "mod+e"}'] };
  }
  for (const [id, chord] of Object.entries(raw)) {
    const def = BY_ID.get(id);
    if (!def) errors.push(`Unknown shortcut "${id}"`);
    else if (!def.chord) errors.push(`"${id}" cannot be remapped`);
    else if (typeof chord !== "string" || !parseChord(chord)) {
      errors.push(`"${id}": "${String(chord)}" is not a chord like "mod+shift+k"`);
    } else overrides[id] = chord.trim().toLowerCase();
  }
  return { overrides, errors };
}

export function keybindingDef(id: string): KeybindingDef | undefined {
  return BY_ID.get(id);
}
