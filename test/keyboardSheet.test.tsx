/**
 * Keyboard sheet copy for the composer vim pref (#779 / #817 / #820 / #822).
 * Run: npm run test:renderer -- --test-name-pattern="keyboard sheet"
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { KeyboardSheet } from "../src/components/KeyboardSheet";
import { setComposerVimEnabled } from "../src/uiPrefs";

const VIM_MOTION_KEYS = [
  "h / j / k / l",
  "0 / $",
  "w / b",
  "dd",
  "x",
  "i / a / I / A",
] as const;

const VIM_LEFTOVER_KEYS = [
  "^",
  "gg / G",
  "X",
  "D",
  "dw",
  "d0",
  "o / O",
] as const;

async function openSheet() {
  const m = await mount(<KeyboardSheet open onClose={() => {}} />);
  const sheet = m.query("[data-keyboard-sheet]");
  assert.ok(sheet, "keyboard sheet is open");
  const kbds = m
    .queryAll("kbd")
    .map((el) => el.textContent || "");
  return { m, sheet, text: sheet!.textContent || "", kbds };
}

describe("keyboard sheet vim Escape (#779)", () => {
  afterEach(() => {
    setComposerVimEnabled(false);
  });

  it("keeps stop-on-escape when vim motions are off", async () => {
    setComposerVimEnabled(false);
    const { m, text } = await openSheet();
    assert.match(text, /Stop the live turn/);
    assert.doesNotMatch(text, /leave insert/i);
    m.unmount();
  });

  it("documents leave-insert Escape when vim motions are on", async () => {
    setComposerVimEnabled(true);
    const { m, text } = await openSheet();
    assert.match(text, /leave insert/i);
    assert.match(text, /stop from normal/i);
    m.unmount();
  });
});

describe("keyboard sheet vim motions (#817)", () => {
  afterEach(() => {
    setComposerVimEnabled(false);
  });

  it("hides composer vim motions when the pref is off", async () => {
    setComposerVimEnabled(false);
    const { m, kbds } = await openSheet();
    for (const keys of VIM_MOTION_KEYS) {
      assert.equal(
        kbds.includes(keys),
        false,
        `off: ${keys} must not appear`,
      );
    }
    m.unmount();
  });

  it("lists shipped composer vim motions when the pref is on", async () => {
    setComposerVimEnabled(true);
    const { m, kbds, text } = await openSheet();
    for (const keys of VIM_MOTION_KEYS) {
      assert.ok(kbds.includes(keys), `on: ${keys} must appear`);
    }
    assert.match(text, /left \/ down \/ up \/ right/i);
    assert.match(text, /start \/ end of line/i);
    assert.match(text, /next \/ previous word/i);
    assert.match(text, /delete line/i);
    assert.match(text, /delete character/i);
    assert.match(text, /insert/i);
    m.unmount();
  });
});

describe("keyboard sheet leftover vim motions (#820)", () => {
  afterEach(() => {
    setComposerVimEnabled(false);
  });

  it("hides leftover composer vim motions when the pref is off", async () => {
    setComposerVimEnabled(false);
    const { m, kbds } = await openSheet();
    for (const keys of VIM_LEFTOVER_KEYS) {
      assert.equal(
        kbds.includes(keys),
        false,
        `off: ${keys} must not appear`,
      );
    }
    m.unmount();
  });

  it("lists leftover composer vim motions when the pref is on", async () => {
    setComposerVimEnabled(true);
    const { m, kbds, text } = await openSheet();
    for (const keys of VIM_LEFTOVER_KEYS) {
      assert.ok(kbds.includes(keys), `on: ${keys} must appear`);
    }
    assert.match(text, /first non-blank/i);
    assert.match(text, /first \/ last line/i);
    assert.match(text, /delete previous character/i);
    assert.match(text, /delete to end of line/i);
    assert.match(text, /delete word/i);
    assert.match(text, /delete to start of line/i);
    assert.match(text, /open line below \/ above/i);
    m.unmount();
  });
});

describe("keyboard sheet vim section heading (#822)", () => {
  afterEach(() => {
    setComposerVimEnabled(false);
  });

  it("hides the Composer vim heading when the pref is off", async () => {
    setComposerVimEnabled(false);
    const { m, text } = await openSheet();
    assert.doesNotMatch(text, /composer vim/i);
    m.unmount();
  });

  it("shows a Composer vim heading above the vim rows when the pref is on", async () => {
    setComposerVimEnabled(true);
    const { m, sheet } = await openSheet();
    const heading = [...sheet!.querySelectorAll("h3")].find((el) =>
      /composer vim/i.test(el.textContent || ""),
    );
    assert.ok(heading, "on: Composer vim heading must appear");
    const firstVim = [...sheet!.querySelectorAll("kbd")].find(
      (el) => el.textContent === "h / j / k / l",
    );
    assert.ok(firstVim, "on: first vim row must appear");
    assert.ok(
      heading!.compareDocumentPosition(firstVim!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      "heading must sit above the vim rows",
    );
    m.unmount();
  });
});
