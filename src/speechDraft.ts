/** Pinned Nemotron streaming Q8 size; confirmation must show this exact byte count. */
export const SPEECH_MODEL_BYTES = 699_872_960;

export function formatSpeechModelSize(
  bytes: number = SPEECH_MODEL_BYTES,
): string {
  const mb = Math.round(bytes / 1_000_000);
  return `~${mb} MB / ${bytes.toLocaleString("en-US")} bytes`;
}

/** Concatenate an incremental suffix onto the one provisional range. */
export function applySpeechDelta(input: {
  prefix: string;
  suffix: string;
  accumulated: string;
  delta: string;
}): { text: string; accumulated: string; caret: number } {
  const accumulated = input.accumulated + input.delta;
  const text = input.prefix + accumulated + input.suffix;
  return { text, accumulated, caret: input.prefix.length + accumulated.length };
}

/** Replace the whole provisional range. Empty final restores the snapshot. */
export function applySpeechTranscript(input: {
  prefix: string;
  suffix: string;
  original: string;
  originalCaret: number;
  transcript: string;
}): { text: string; caret: number } {
  if (!input.transcript) {
    return { text: input.original, caret: input.originalCaret };
  }
  const text = input.prefix + input.transcript + input.suffix;
  return { text, caret: input.prefix.length + input.transcript.length };
}
