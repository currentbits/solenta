const GROUND = 0, ESCAPE = 1, CSI = 2, OSC = 3, STRING = 4, OSC_ESCAPE = 5, STRING_ESCAPE = 6, ESC_INTERMEDIATE = 7;

function nextState(state, code) {
  if (code === 0x18 || code === 0x1a || code === 0x9c) return GROUND;
  if (state === OSC || state === STRING) {
    if (code === 0x1b) return state === OSC ? OSC_ESCAPE : STRING_ESCAPE;
    return state === OSC && code === 7 ? GROUND : state;
  }
  if (state === OSC_ESCAPE || state === STRING_ESCAPE) {
    if (code === 0x5c) return GROUND;
    if (code === 0x1b) return state;
    state = ESCAPE;
  }
  if (code === 0x1b) return ESCAPE;
  if (code === 0x9b) return CSI;
  if (code === 0x9d) return OSC;
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) return STRING;
  if (state === ESCAPE) {
    if (code === 0x5b) return CSI;
    if (code === 0x5d) return OSC;
    if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) return STRING;
    if (code >= 0x20 && code <= 0x2f) return ESC_INTERMEDIATE;
    return code >= 0x30 && code <= 0x7e ? GROUND : ESCAPE;
  }
  if (state === ESC_INTERMEDIATE) return code >= 0x30 && code <= 0x7e ? GROUND : ESC_INTERMEDIATE;
  if (state === CSI) return code >= 0x40 && code <= 0x7e ? GROUND : CSI;
  return GROUND;
}

/** Parser state at a trim boundary, without retaining discarded output. */
export function sequenceStateAfter(state, text, end = text.length) {
  for (let i = 0; i < end; i++) state = nextState(state, text.charCodeAt(i));
  return state;
}

/** A fresh emulator never saw the sequence's beginning; discard its remainder. */
export function skipPartialSequence(state, text) {
  let start = 0;
  while (state !== GROUND && start < text.length) state = nextState(state, text.charCodeAt(start++));
  return { state, text: text.slice(start) };
}
