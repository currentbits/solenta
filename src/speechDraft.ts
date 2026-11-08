/** Pinned Nemotron streaming Q8 size; confirmation must show this exact byte count. */
export const SPEECH_MODEL_BYTES = 699_872_960;

export function formatSpeechModelSize(
  bytes: number = SPEECH_MODEL_BYTES,
): string {
  const mb = Math.round(bytes / 1_000_000);
  return `~${mb} MB / ${bytes.toLocaleString("en-US")} bytes`;
}

const WORD = /[\p{L}\p{M}\p{N}]/u;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function speechBoundary(left: string, right: string): string {
  const end = Array.from(left.slice(-2)).at(-1) ?? "";
  const start = Array.from(right.slice(0, 2))[0] ?? "";
  return WORD.test(end) && WORD.test(start) &&
    !UNSPACED.test(end) && !UNSPACED.test(start) ? " " : "";
}

function insertSpeech(prefix: string, transcript: string, suffix: string, replaceSelection = false) {
  const before = replaceSelection ? "" : speechBoundary(prefix, transcript);
  const after = replaceSelection ? "" : speechBoundary(transcript, suffix);
  return {
    text: prefix + before + transcript + after + suffix,
    caret: prefix.length + before.length + transcript.length,
  };
}

/** Concatenate an incremental suffix onto the one provisional range. */
export function applySpeechDelta(input: {
  prefix: string;
  suffix: string;
  accumulated: string;
  delta: string;
  replaceSelection?: boolean;
}): { text: string; accumulated: string; caret: number } {
  const accumulated = input.accumulated + input.delta;
  return { ...insertSpeech(input.prefix, accumulated, input.suffix, input.replaceSelection), accumulated };
}

/** Replace the whole provisional range. Empty final restores the snapshot. */
export function applySpeechTranscript(input: {
  prefix: string;
  suffix: string;
  original: string;
  originalCaret: number;
  transcript: string;
  replaceSelection?: boolean;
}): { text: string; caret: number } {
  if (!input.transcript) {
    return { text: input.original, caret: input.originalCaret };
  }
  return insertSpeech(input.prefix, input.transcript, input.suffix, input.replaceSelection);
}
