/**
 * Composer vim motions (issue #779). Pure engine: 0 / w / dd plus the
 * insert↔normal gate so the default typing path stays intact.
 *
 * Run: node --experimental-strip-types --test test/composerVim.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_VIM,
  applyComposerVim,
  type VimBuffer,
  type VimState,
} from "../src/composerVim.ts";

function apply(
  text: string,
  cursor: number,
  keys: string[],
  state: VimState = { ...INITIAL_VIM, mode: "normal" },
): { text: string; cursor: number; state: VimState } {
  let buffer: VimBuffer = { text, cursor };
  let current = { ...state };
  for (const key of keys) {
    const result = applyComposerVim(current, buffer, { key });
    current = result.state;
    if (result.handled) buffer = result.buffer;
  }
  return { text: buffer.text, cursor: buffer.cursor, state: current };
}

describe("composerVim insert vs normal", () => {
  it("starts in insert and lets letter keys fall through", () => {
    const result = applyComposerVim(INITIAL_VIM, { text: "", cursor: 0 }, {
      key: "w",
    });
    assert.equal(result.handled, false);
    assert.equal(result.state.mode, "insert");
  });

  it("Escape leaves insert for normal without changing the buffer", () => {
    const result = applyComposerVim(
      INITIAL_VIM,
      { text: "hello", cursor: 5 },
      { key: "Escape" },
    );
    assert.equal(result.handled, true);
    assert.equal(result.state.mode, "normal");
    assert.equal(result.buffer.text, "hello");
    assert.equal(result.buffer.cursor, 5);
  });

  it("does not steal Cmd/Ctrl/Alt chords in either mode", () => {
    const insert = applyComposerVim(INITIAL_VIM, { text: "x", cursor: 1 }, {
      key: "Enter",
      metaKey: true,
    });
    assert.equal(insert.handled, false);

    const normal = applyComposerVim(
      { ...INITIAL_VIM, mode: "normal" },
      { text: "x", cursor: 1 },
      { key: "Enter", metaKey: true },
    );
    assert.equal(normal.handled, false);
  });
});

describe("composerVim motions", () => {
  it("0 moves to the start of the current line", () => {
    const out = apply("hello world", 11, ["0"]);
    assert.equal(out.cursor, 0);
    assert.equal(out.text, "hello world");
  });

  it("0 stays on the current line when the buffer is multi-line", () => {
    const out = apply("alpha\nbravo charlie", 19, ["0"]);
    assert.equal(out.cursor, 6);
    assert.equal(out.text, "alpha\nbravo charlie");
  });

  it("w jumps to the start of the next word", () => {
    const out = apply("hello world", 0, ["w"]);
    assert.equal(out.cursor, 6);
    assert.equal(out.text, "hello world");
  });

  it("dd deletes the current line", () => {
    const out = apply("hello\nworld", 0, ["d", "d"]);
    assert.equal(out.text, "world");
    assert.equal(out.cursor, 0);
  });

  it("i returns to insert so typing is unblocked", () => {
    const out = apply("hello", 0, ["i"]);
    assert.equal(out.state.mode, "insert");
    const typed = applyComposerVim(out.state, { text: "hello", cursor: 0 }, {
      key: "x",
    });
    assert.equal(typed.handled, false);
  });
});
