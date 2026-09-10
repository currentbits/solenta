/**
 * Command palette ranking and shortcut matching (#150).
 * Run: npm run test:renderer -- --test-name-pattern="command palette"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupPaletteItems,
  matchPaletteShortcut,
  palettePlaceholder,
  rankPaletteItems,
  scoreMatch,
} from "../src/commandPalette";

describe("command palette ranking", () => {
  it("empty query includes every field", () => {
    assert.equal(scoreMatch("", "New thread"), 0);
    assert.equal(scoreMatch("   ", "New thread"), 0);
  });

  it("prefix ranks above a mid-string hit", () => {
    const prefix = scoreMatch("set", "Settings");
    const mid = scoreMatch("set", "Open settings");
    assert.ok(prefix != null && mid != null);
    assert.ok(prefix > mid);
  });

  it("path and space boundaries count as prefix", () => {
    const path = scoreMatch("app", "src/App.tsx");
    const mid = scoreMatch("app", "myapp.tsx");
    assert.ok(path != null && mid != null);
    assert.ok(path > mid);
    const word = scoreMatch("thread", "New thread");
    assert.ok(word != null);
    assert.ok(word > (scoreMatch("thread", "pthread") ?? 0));
  });

  it("drops items that do not contain the query", () => {
    const ranked = rankPaletteItems(
      [
        {
          id: "action:new-thread",
          kind: "action",
          title: "New thread",
          haystack: ["New thread", "create"],
        },
        {
          id: "action:settings",
          kind: "action",
          title: "Open settings",
          haystack: ["Open settings"],
        },
      ],
      "kanban",
      10,
    );
    assert.deepEqual(ranked, []);
  });

  it("keeps definition order when scores tie", () => {
    const ranked = rankPaletteItems(
      [
        {
          id: "action:new-thread",
          kind: "action",
          title: "New thread",
          haystack: ["New thread"],
        },
        {
          id: "action:settings",
          kind: "action",
          title: "Open settings",
          haystack: ["Open settings"],
        },
      ],
      "",
      10,
    );
    assert.deepEqual(
      ranked.map((r) => r.id),
      ["action:new-thread", "action:settings"],
    );
  });

  it("groups in kind order and caps the list", () => {
    const ranked = rankPaletteItems(
      [
        {
          id: "thread:1",
          kind: "thread",
          title: "Fix search",
          haystack: ["Fix search"],
        },
        {
          id: "action:settings",
          kind: "action",
          title: "Open settings",
          haystack: ["Open settings"],
        },
        {
          id: "project:p",
          kind: "project",
          title: "solenta",
          haystack: ["solenta"],
        },
      ],
      "",
      2,
    );
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]?.kind, "action");
    assert.equal(ranked[1]?.kind, "thread");
    const groups = groupPaletteItems(ranked);
    assert.deepEqual(
      groups.map((g) => g.kind),
      ["action", "thread"],
    );
  });
});

describe("command palette shortcuts", () => {
  const base = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };

  it("maps cmd/ctrl k p and shift+f, ignores alt", () => {
    assert.equal(
      matchPaletteShortcut({ ...base, key: "k", metaKey: true }),
      "command",
    );
    assert.equal(
      matchPaletteShortcut({ ...base, key: "K", ctrlKey: true }),
      "command",
    );
    assert.equal(
      matchPaletteShortcut({ ...base, key: "p", metaKey: true }),
      "files",
    );
    assert.equal(
      matchPaletteShortcut({
        ...base,
        key: "f",
        metaKey: true,
        shiftKey: true,
      }),
      "content",
    );
    assert.equal(
      matchPaletteShortcut({ ...base, key: "k", metaKey: true, altKey: true }),
      null,
    );
    assert.equal(
      matchPaletteShortcut({ ...base, key: "k", shiftKey: true, metaKey: true }),
      null,
    );
    assert.equal(matchPaletteShortcut({ ...base, key: "k" }), null);
  });

  it("labels the empty field per mode", () => {
    assert.match(palettePlaceholder("command"), /threads/i);
    assert.match(palettePlaceholder("files"), /files/i);
    assert.match(palettePlaceholder("content"), /contents/i);
  });
});
