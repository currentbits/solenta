/**
 * Opt-in vim motions for the composer textarea (issue #779).
 *
 * Insert is the default so typing is unchanged until Escape. Normal mode
 * owns a small motion/operator set (0, w, dd, ...). Modifier chords stay
 * unhandled so the composer can keep Cmd+Enter, Cmd+S, and Ctrl+C.
 */

export type VimMode = "insert" | "normal";

export interface VimState {
  mode: VimMode;
  /** Digits typed before a motion, or empty. */
  count: string;
  /** Pending operator (`d`) or `g` waiting for a second `g`. */
  pending: "d" | "g" | null;
}

export const INITIAL_VIM: VimState = {
  mode: "insert",
  count: "",
  pending: null,
};

export interface VimBuffer {
  text: string;
  cursor: number;
}

export interface VimKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface VimResult {
  handled: boolean;
  state: VimState;
  buffer: VimBuffer;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isBlank(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function lineStart(text: string, cursor: number): number {
  const i = text.lastIndexOf("\n", cursor - 1);
  return i === -1 ? 0 : i + 1;
}

function lineEnd(text: string, cursor: number): number {
  const i = text.indexOf("\n", cursor);
  return i === -1 ? text.length : i;
}

function firstNonBlank(text: string, cursor: number): number {
  let i = lineStart(text, cursor);
  const end = lineEnd(text, cursor);
  while (i < end && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

function nextWord(text: string, cursor: number): number {
  let i = cursor;
  if (i >= text.length) return text.length;
  if (isWordChar(text[i])) {
    while (i < text.length && isWordChar(text[i])) i++;
  } else if (!isBlank(text[i])) {
    while (i < text.length && !isWordChar(text[i]) && !isBlank(text[i])) i++;
  }
  while (i < text.length && isBlank(text[i])) i++;
  return i;
}

function prevWord(text: string, cursor: number): number {
  let i = cursor;
  if (i <= 0) return 0;
  i--;
  while (i > 0 && isBlank(text[i])) i--;
  if (i <= 0) return 0;
  if (isWordChar(text[i])) {
    while (i > 0 && isWordChar(text[i - 1])) i--;
  } else {
    while (i > 0 && !isWordChar(text[i - 1]) && !isBlank(text[i - 1])) i--;
  }
  return i;
}

function nextLineStart(text: string, cursor: number): number {
  const end = lineEnd(text, cursor);
  if (end >= text.length) return cursor;
  return end + 1;
}

function prevLineStart(text: string, cursor: number): number {
  const start = lineStart(text, cursor);
  if (start === 0) return 0;
  return lineStart(text, start - 1);
}

function deleteRange(text: string, from: number, to: number): VimBuffer {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.max(from, to);
  return { text: text.slice(0, a) + text.slice(b), cursor: a };
}

function deleteLine(text: string, cursor: number): VimBuffer {
  const start = lineStart(text, cursor);
  const end = lineEnd(text, cursor);
  if (end < text.length && text[end] === "\n") {
    return deleteRange(text, start, end + 1);
  }
  if (start > 0 && text[start - 1] === "\n") {
    return {
      text: text.slice(0, start - 1),
      cursor: lineStart(text, start - 1),
    };
  }
  return { text: "", cursor: 0 };
}

function repeatMotion(
  text: string,
  cursor: number,
  n: number,
  step: (t: string, c: number) => number,
): number {
  let pos = cursor;
  for (let i = 0; i < n; i++) {
    const next = step(text, pos);
    if (next === pos) break;
    pos = next;
  }
  return pos;
}

function parseCount(count: string): number {
  if (!count) return 1;
  const n = Number.parseInt(count, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function clearPending(state: VimState, mode: VimMode = state.mode): VimState {
  return { mode, count: "", pending: null };
}

function same(state: VimState, buffer: VimBuffer, handled: boolean): VimResult {
  return { handled, state, buffer };
}

export function applyComposerVim(
  state: VimState,
  buffer: VimBuffer,
  key: VimKey,
): VimResult {
  if (key.metaKey || key.altKey) return same(state, buffer, false);
  // Ctrl+[ is Escape. Every other Ctrl/Cmd chord belongs to the composer.
  if (key.ctrlKey && key.key !== "[") return same(state, buffer, false);

  const isEscape = key.key === "Escape" || (key.ctrlKey && key.key === "[");

  if (state.mode === "insert") {
    if (isEscape) {
      return {
        handled: true,
        state: clearPending(state, "normal"),
        buffer,
      };
    }
    return same(state, buffer, false);
  }

  // Normal mode.
  if (isEscape) {
    if (state.pending || state.count) {
      return {
        handled: true,
        state: clearPending(state, "normal"),
        buffer,
      };
    }
    // Bare Escape in normal falls through so stop-run / rewind still work.
    return same(state, buffer, false);
  }

  if (key.key >= "1" && key.key <= "9") {
    return {
      handled: true,
      state: { ...state, count: state.count + key.key },
      buffer,
    };
  }
  if (key.key === "0" && state.count) {
    return {
      handled: true,
      state: { ...state, count: state.count + "0" },
      buffer,
    };
  }

  const n = parseCount(state.count);
  const { text } = buffer;
  const cursor = clamp(buffer.cursor, 0, text.length);

  if (state.pending === "g") {
    if (key.key === "g") {
      return {
        handled: true,
        state: clearPending(state, "normal"),
        buffer: { text, cursor: 0 },
      };
    }
    return {
      handled: true,
      state: clearPending(state, "normal"),
      buffer,
    };
  }

  if (state.pending === "d") {
    if (key.key === "d") {
      let next = { text, cursor };
      for (let i = 0; i < n; i++) {
        if (!next.text) break;
        next = deleteLine(next.text, next.cursor);
      }
      return {
        handled: true,
        state: clearPending(state, "normal"),
        buffer: next,
      };
    }
    if (key.key === "w") {
      const end = repeatMotion(text, cursor, n, nextWord);
      return {
        handled: true,
        state: clearPending(state, "normal"),
        buffer: deleteRange(text, cursor, end),
      };
    }
    if (key.key === "0") {
      const start = lineStart(text, cursor);
      return {
        handled: true,
        state: clearPending(state, "normal"),
        buffer: deleteRange(text, start, cursor),
      };
    }
    return {
      handled: true,
      state: clearPending(state, "normal"),
      buffer,
    };
  }

  if (key.key === "d") {
    return {
      handled: true,
      state: { ...state, pending: "d" },
      buffer,
    };
  }

  if (key.key === "g") {
    return {
      handled: true,
      state: { ...state, pending: "g" },
      buffer,
    };
  }

  let nextCursor = cursor;
  let nextText = text;
  let nextMode: VimMode = "normal";

  switch (key.key) {
    case "0":
      nextCursor = lineStart(text, cursor);
      break;
    case "^":
      nextCursor = firstNonBlank(text, cursor);
      break;
    case "$":
      nextCursor = lineEnd(text, cursor);
      break;
    case "w":
      nextCursor = repeatMotion(text, cursor, n, nextWord);
      break;
    case "b":
      nextCursor = repeatMotion(text, cursor, n, prevWord);
      break;
    case "h":
      nextCursor = clamp(cursor - n, 0, text.length);
      break;
    case "l":
      nextCursor = clamp(cursor + n, 0, text.length);
      break;
    case "j":
      nextCursor = repeatMotion(text, cursor, n, nextLineStart);
      break;
    case "k":
      nextCursor = repeatMotion(text, cursor, n, prevLineStart);
      break;
    case "G":
      nextCursor = lineStart(text, text.length);
      break;
    case "x": {
      const end = clamp(cursor + n, 0, text.length);
      ({ text: nextText, cursor: nextCursor } = deleteRange(text, cursor, end));
      break;
    }
    case "X": {
      const start = clamp(cursor - n, 0, text.length);
      ({ text: nextText, cursor: nextCursor } = deleteRange(text, start, cursor));
      break;
    }
    case "D": {
      const end = lineEnd(text, cursor);
      ({ text: nextText, cursor: nextCursor } = deleteRange(text, cursor, end));
      break;
    }
    case "i":
      nextMode = "insert";
      break;
    case "a":
      nextMode = "insert";
      nextCursor = clamp(cursor + 1, 0, text.length);
      break;
    case "I":
      nextMode = "insert";
      nextCursor = firstNonBlank(text, cursor);
      break;
    case "A":
      nextMode = "insert";
      nextCursor = lineEnd(text, cursor);
      break;
    case "o": {
      const end = lineEnd(text, cursor);
      nextText = text.slice(0, end) + "\n" + text.slice(end);
      nextCursor = end + 1;
      nextMode = "insert";
      break;
    }
    case "O": {
      const start = lineStart(text, cursor);
      nextText = text.slice(0, start) + "\n" + text.slice(start);
      nextCursor = start;
      nextMode = "insert";
      break;
    }
    default:
      // Swallow the key so it cannot type into the draft.
      return {
        handled: true,
        state: clearPending(state, "normal"),
        buffer,
      };
  }

  return {
    handled: true,
    state: clearPending(state, nextMode),
    buffer: { text: nextText, cursor: nextCursor },
  };
}
