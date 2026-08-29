import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PASTE_HARD_CAP,
  PASTE_KEEP_HEAD,
  PASTE_KEEP_TAIL,
  composePastePrompt,
  compressHugePaste,
  countLines,
  formatOverflow,
  makePasteCard,
  overflowWarn,
  pasteCardLabel,
  payloadChars,
  shouldCollapsePaste,
} from "../src/pasteCards.ts";

describe("shouldCollapsePaste", () => {
  it("leaves a short one-liner in the textarea", () => {
    assert.equal(shouldCollapsePaste("fix the mention popup"), false);
  });

  it("collapses a long blob even on one line", () => {
    assert.equal(shouldCollapsePaste("x".repeat(400)), true);
  });

  it("collapses a short stack of lines", () => {
    assert.equal(shouldCollapsePaste("a\nb\nc\nd\ne\nf\ng\nh"), true);
  });
});

describe("compressHugePaste", () => {
  it("leaves a paste at the cap untouched", () => {
    const text = "a".repeat(PASTE_HARD_CAP);
    const out = compressHugePaste(text);
    assert.equal(out.compressed, false);
    assert.equal(out.text, text);
    assert.equal(out.omitted, 0);
  });

  it("keeps head and tail when over the cap", () => {
    const text = "H".repeat(PASTE_KEEP_HEAD) + "M".repeat(50_000) + "T".repeat(PASTE_KEEP_TAIL);
    const out = compressHugePaste(text);
    assert.equal(out.compressed, true);
    assert.equal(out.omitted, 50_000);
    assert.ok(out.text.startsWith("H".repeat(PASTE_KEEP_HEAD)));
    assert.ok(out.text.endsWith("T".repeat(PASTE_KEEP_TAIL)));
    assert.match(out.text, /50,000 characters omitted/);
  });
});

describe("makePasteCard / compose", () => {
  it("labels line count and expands into a bounded block", () => {
    const card = makePasteCard("one\ntwo\nthree", 1);
    assert.equal(card.lines, 3);
    assert.equal(pasteCardLabel(card), "Pasted 3 lines");
    const prompt = composePastePrompt("look at this", [card]);
    assert.match(prompt, /<pasted-context label="Pasted 3 lines">/);
    assert.match(prompt, /one\ntwo\nthree/);
    assert.match(prompt, /look at this$/);
  });

  it("sends cards alone when the draft is empty", () => {
    const card = makePasteCard("only", 1);
    assert.equal(
      composePastePrompt("  ", [card]),
      `<pasted-context label="Pasted 1 line">\nonly\n</pasted-context>`,
    );
  });

  it("marks a compressed card in the label", () => {
    const card = makePasteCard("x".repeat(PASTE_HARD_CAP + 10), 1);
    assert.equal(card.compressed, true);
    assert.match(pasteCardLabel(card), /compressed/);
  });
});

describe("overflow", () => {
  it("counts draft plus cards and formats the live counter", () => {
    const card = makePasteCard("abcd", 1);
    assert.equal(payloadChars("hi", [card]), 6);
    assert.equal(formatOverflow(1234), "1,234 / 120,000");
    assert.equal(overflowWarn(100_000), false);
    assert.equal(overflowWarn(102_000), true);
  });

  it("countLines treats an empty string as zero", () => {
    assert.equal(countLines(""), 0);
  });
});
