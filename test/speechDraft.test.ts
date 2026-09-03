/**
 * Provisional draft range for live dictation (#845).
 * Run: node --experimental-strip-types --test test/speechDraft.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SPEECH_MODEL_BYTES,
  applySpeechDelta,
  applySpeechTranscript,
  formatSpeechModelSize,
} from "../src/speechDraft.ts";

describe("speech draft range", () => {
  it("formats the pinned model size", () => {
    assert.equal(SPEECH_MODEL_BYTES, 699_872_960);
    assert.equal(formatSpeechModelSize(), "~700 MB / 699,872,960 bytes");
  });

  it("concatenates incremental suffix deltas", () => {
    let acc = "";
    const prefix = "Hello ";
    const suffix = "";
    const first = applySpeechDelta({
      prefix,
      suffix,
      accumulated: acc,
      delta: "Quick",
    });
    acc = first.accumulated;
    assert.equal(first.text, "Hello Quick");
    const second = applySpeechDelta({
      prefix,
      suffix,
      accumulated: acc,
      delta: " brown",
    });
    assert.equal(second.text, "Hello Quick brown");
    assert.equal(second.accumulated, "Quick brown");
  });

  it("replaces the whole provisional range on a completed transcript", () => {
    const committed = applySpeechTranscript({
      prefix: "Hello ",
      suffix: "!",
      original: "Hello !",
      originalCaret: 6,
      transcript: "Quick brown fox",
    });
    assert.equal(committed.text, "Hello Quick brown fox!");
    assert.equal(committed.caret, "Hello Quick brown fox".length);
  });

  it("empty final restores the original draft", () => {
    const restored = applySpeechTranscript({
      prefix: "Hello ",
      suffix: "",
      original: "Hello ",
      originalCaret: 6,
      transcript: "",
    });
    assert.equal(restored.text, "Hello ");
    assert.equal(restored.caret, 6);
  });
});
