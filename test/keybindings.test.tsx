/**
 * Keybinding table, matcher and Settings › Keyboard (#1506 H2).
 * Run: npm run test:renderer -- --test-name-pattern="keybinding"
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mount } from "./support/dom.ts";
import { matchPaletteShortcut } from "../src/commandPalette";
import {
  effectiveChords,
  findConflicts,
  formatChord,
  matchesBinding,
  parseChord,
  parseOverrides,
  setMacPlatformForTests,
} from "../src/keybindings";
import { KeyboardPane } from "../src/components/settings/KeyboardPane";
import { getKeybindingOverrides, setKeybindingOverrides } from "../src/uiPrefs";

function key(k: string, mods: Partial<KeyboardEvent> = {}) {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

afterEach(() => {
  setKeybindingOverrides({});
  setMacPlatformForTests(null);
});

describe("keybinding table", () => {
  it("ships without conflicts on either platform", () => {
    assert.deepEqual(findConflicts(effectiveChords({}, true)), []);
    assert.deepEqual(findConflicts(effectiveChords({}, false)), []);
  });

  it("parses chords and rejects junk", () => {
    assert.deepEqual(parseChord("mod+shift+F"), {
      mod: true, ctrl: false, meta: false, alt: false, shift: true, key: "f",
    });
    assert.equal(parseChord("mod+"), null);
    assert.equal(parseChord("shift"), null);
    assert.equal(parseChord("hyper+k"), null);
    assert.equal(parseChord("mod+mod+k"), null);
  });

  it("mod matches ⌘ or Ctrl, as the hard-coded handlers did", () => {
    assert.equal(matchesBinding(key("k", { metaKey: true }), "palette.command"), true);
    assert.equal(matchesBinding(key("k", { ctrlKey: true }), "palette.command"), true);
    assert.equal(matchesBinding(key("k", { metaKey: true, altKey: true }), "palette.command"), false);
    assert.equal(matchesBinding(key("K", { metaKey: true, shiftKey: true }), "palette.command"), false);
  });

  it("literal ctrl does not fire on ⌘", () => {
    assert.equal(matchesBinding(key("o", { ctrlKey: true }), "transcript.cycle"), true);
    assert.equal(matchesBinding(key("o", { metaKey: true }), "transcript.cycle"), false);
  });

  it("? fires with or without shift, never with a modifier", () => {
    assert.equal(matchesBinding(key("?", { shiftKey: true }), "keyboard.sheet"), true);
    assert.equal(matchesBinding(key("?"), "keyboard.sheet"), true);
    assert.equal(matchesBinding(key("?", { metaKey: true }), "keyboard.sheet"), false);
  });

  it("option-letter on mac matches by code", () => {
    assert.equal(
      matchesBinding({ ...key("ƒ", { ctrlKey: true, altKey: true }), code: "KeyF" }, "transcript.summary"),
      true,
    );
  });

  it("back/forward default to ⌘[ on mac and Alt+Left elsewhere", () => {
    setMacPlatformForTests(true);
    assert.equal(matchesBinding(key("[", { metaKey: true }), "history.back"), true);
    assert.equal(matchesBinding(key("[", { ctrlKey: true }), "history.back"), false, "Ctrl+[ is vim Escape");
    setMacPlatformForTests(false);
    assert.equal(matchesBinding(key("ArrowLeft", { altKey: true }), "history.back"), true);
    assert.equal(matchesBinding(key("[", { metaKey: true }), "history.back"), false);
  });

  it("formats per platform", () => {
    assert.equal(formatChord("mod+shift+f", true), "⌘ + ⇧ + F");
    assert.equal(formatChord("mod+shift+f", false), "Ctrl + Shift + F");
    assert.equal(formatChord("mod+shift+f", true, true), "⌘⇧F");
    assert.equal(formatChord("mod+shift+f", false, true), "Ctrl+Shift+F");
  });

  it("an override remaps the live handler and frees the old chord", () => {
    setKeybindingOverrides({ "palette.command": "mod+e" });
    assert.equal(matchPaletteShortcut(key("e", { metaKey: true })), "command");
    assert.equal(matchPaletteShortcut(key("k", { metaKey: true })), null);
  });

  it("finds a conflict an override creates", () => {
    const chords = effectiveChords({ "palette.command": "mod+n" }, true);
    assert.deepEqual(findConflicts(chords), [["thread.new", "palette.command"]]);
  });

  it("validates the JSON and keeps the good entries", () => {
    const { overrides, errors } = parseOverrides(
      '{"palette.command": "Mod+E", "nope": "mod+x", "thread.jump": "mod+1", "undo": "mod+"}',
    );
    assert.deepEqual(overrides, { "palette.command": "mod+e" });
    assert.equal(errors.length, 3);
    assert.match(parseOverrides("{").errors[0]!, /Not valid JSON/);
    assert.match(parseOverrides("[]").errors[0]!, /Expected an object/);
  });
});

describe("Settings › Keyboard keybinding editor", () => {
  it("warns on conflicts, applies, and resets", async () => {
    setMacPlatformForTests(true);
    const m = await mount(<KeyboardPane />);
    const json = m.query("[data-keybindings-json]");
    await m.type(json, '{"palette.command": "mod+n"}');
    assert.match(m.query("[data-keybindings-conflict]")?.textContent ?? "", /New thread and Command palette share ⌘ \+ N/);
    await m.type(json, '{"palette.command": "mod+e"}');
    assert.equal(m.query("[data-keybindings-conflict]"), null);
    await m.click(m.query("[data-keybindings-apply]"));
    assert.deepEqual(getKeybindingOverrides(), { "palette.command": "mod+e" });
    assert.equal(m.query('[data-keybinding="palette.command"] kbd')?.textContent, "⌘ + E");
    assert.ok(m.query('[data-keybinding="palette.command"][data-custom]'));
    await m.click(m.query("[data-keybindings-reset]"));
    assert.deepEqual(getKeybindingOverrides(), {});
    assert.equal(m.query('[data-keybinding="palette.command"] kbd')?.textContent, "⌘ + K");
    m.unmount();
  });

  it("shows JSON errors", async () => {
    const m = await mount(<KeyboardPane />);
    await m.type(m.query("[data-keybindings-json]"), '{"nope": "mod+x"}');
    assert.match(m.query("[data-keybindings-error]")?.textContent ?? "", /Unknown shortcut "nope"/);
    m.unmount();
  });
});
