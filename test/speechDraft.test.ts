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

  it("separates inserted words on both sides without changing punctuation or unspaced scripts", () => {
    for (const [prefix, transcript, suffix, expected] of [
      ["Hello", "world", "next", "Hello world next"],
      ["코드를", "검토", "해주세요", "코드를 검토 해주세요"],
      ["नमस्ते", "दुनिया", "", "नमस्ते दुनिया"],
      ["Cafe\u0301", "menu", "", "Cafe\u0301 menu"],
      ["Hello ", "world", "!", "Hello world!"],
      ["Hello\n", "world", "", "Hello\nworld"],
      ["Hello", "world", "\nnext", "Hello world\nnext"],
      ["𐐀", "word", "", "𐐀 word"],
      ["Hello", " world ", "next", "Hello world next"],
      ["(", "hello", ")", "(hello)"],
      ["日本", "語", "です", "日本語です"],
      ["Hello", "世界", "", "Hello世界"],
      ["สวัสดี", "โลก", "", "สวัสดีโลก"],
    ]) {
      const result = applySpeechTranscript({ prefix, suffix, transcript, original: prefix + suffix, originalCaret: prefix.length });
      assert.equal(result.text, expected);
      assert.equal(result.text.slice(0, result.caret).endsWith(transcript), true);
    }
  });

  it("formats the provisional range without adding spaces between partial word deltas", () => {
    const first = applySpeechDelta({ prefix: "Hello", suffix: "next", accumulated: "", delta: "wor" });
    assert.equal(first.text, "Hello wor next");
    const second = applySpeechDelta({ prefix: "Hello", suffix: "next", accumulated: first.accumulated, delta: "ld" });
    const final = applySpeechTranscript({ prefix: "Hello", suffix: "next", original: "Hellonext", originalCaret: 5, transcript: "world" });
    assert.equal(second.text, "Hello world next");
    assert.equal(second.text, final.text);
    assert.equal(second.caret, final.caret);
    assert.equal(second.accumulated, "world");
  });

  it("replaces a selection verbatim and restores it when transcription is empty", () => {
    const input = { prefix: "some", suffix: "thing", original: "someOLDthing", originalCaret: 4, replaceSelection: true };
    assert.equal(applySpeechDelta({ ...input, accumulated: "", delta: "new" }).text, "somenewthing");
    assert.equal(applySpeechTranscript({ ...input, transcript: "new" }).text, "somenewthing");
    assert.deepEqual(applySpeechTranscript({ ...input, transcript: "" }), { text: input.original, caret: 4 });
  });
});
