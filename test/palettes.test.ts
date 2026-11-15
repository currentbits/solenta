import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BUILTIN_PALETTES, exportPalette, PALETTE_FILE_LIMIT, PALETTE_LIBRARY_LIMIT,
  PALETTE_ROLES, PALETTE_STORAGE_KEY, parsePalette, readPaletteLibrary,
  savePaletteLibrary, selectedPalette,
} from "../src/palettes.ts";

const custom = () => ({ ...BUILTIN_PALETTES[1], id: "my-palette", name: "My palette" });

describe("palette definitions", () => {
  it("round-trips all presets and verifies core text/control contrast", () => {
    for (const palette of BUILTIN_PALETTES) assert.deepEqual(parsePalette(exportPalette(palette)), palette);
  });

  it("keeps the Solenta export aligned with the default CSS colors", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    for (const [mode, block] of [
      ["dark", css.split(":root {")[1].split("}")[0]],
      ["light", css.split(':root[data-theme="light"] {')[1].split("}")[0]],
    ] as const) {
      for (const role of PALETTE_ROLES) {
        const value = block.match(new RegExp(`--${role}: ([^;]+);`))?.[1];
        assert.equal(value === "var(--accent)" ? BUILTIN_PALETTES[0][mode].accent : value, BUILTIN_PALETTES[0][mode][role], `${mode} ${role}`);
      }
    }
  });

  it("rejects malformed, oversized, foreign, missing-role and executable definitions", () => {
    assert.throws(() => parsePalette("{"), /Invalid palette JSON/);
    assert.throws(() => parsePalette(" ".repeat(PALETTE_FILE_LIMIT + 1)), /16 KB/);
    for (const value of [
      null, [], { ...custom(), version: 2 }, { ...custom(), format: "vscode" },
      { ...custom(), id: "../file" }, { ...custom(), name: " " },
      { ...custom(), css: "body { display: none }" },
      { ...custom(), light: {} },
      { ...custom(), dark: { ...custom().dark, bg: "url(https://example.com)" } },
      { ...custom(), dark: { ...custom().dark, injected: "#000000" } },
    ]) assert.throws(() => parsePalette(JSON.stringify(value)), /version 1 Solenta palette/);
  });

  it("rejects unreadable text, primary buttons and focus edges", () => {
    for (const role of ["text", "text-body", "text-muted", "text-dim", "accent-edge"] as const) {
      assert.throws(() => parsePalette(JSON.stringify({ ...custom(), dark: { ...custom().dark, [role]: custom().dark.bg } })), /contrast/);
    }
    assert.throws(() => parsePalette(JSON.stringify({ ...custom(), dark: { ...custom().dark, "text-on-accent": custom().dark.accent } })), /contrast/);
    assert.throws(() => parsePalette(JSON.stringify({ ...custom(), light: { ...custom().light, bg: "#0e1420" } })), /built-in status colors/);
  });
});

describe("palette persistence", () => {
  it("round-trips a custom library without replacing a built-in sharing its id", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
    const palette = { ...custom(), id: "midnight" };
    const library = { version: 1, selected: "custom:midnight", custom: [palette] } as const;
    savePaletteLibrary({ ...library, custom: [palette] }, storage);
    assert.deepEqual(readPaletteLibrary(storage), library);
    assert.equal(selectedPalette(readPaletteLibrary(storage)).name, "My palette");
    assert.equal(selectedPalette({ version: 1, selected: "midnight", custom: [palette] }).name, "Midnight");
    assert.ok(map.has(PALETTE_STORAGE_KEY));
  });

  it("bounds the library, validates disk data, and falls back without overwriting corruption", () => {
    const invalid = JSON.stringify({ version: 1, selected: "custom:broken", custom: [{ id: "broken" }] });
    assert.deepEqual(readPaletteLibrary({ getItem: () => invalid }), { version: 1, selected: "solenta", custom: [] });
    assert.equal(readPaletteLibrary({ getItem: () => JSON.stringify({ version: 1, selected: "missing", custom: [] }) }).selected, "solenta");
    assert.equal(readPaletteLibrary({ getItem() { throw new Error("blocked"); } }).selected, "solenta");
    assert.throws(() => savePaletteLibrary({ version: 1, selected: "solenta", custom: Array.from({ length: PALETTE_LIBRARY_LIMIT + 1 }, (_, i) => ({ ...custom(), id: `palette-${i}` })) }, { setItem() {} }), /Invalid palette library/);
    assert.throws(() => savePaletteLibrary({ version: 1, selected: "solenta", custom: [custom(), custom()] }, { setItem() {} }), /Duplicate/);
    assert.throws(() => savePaletteLibrary({ version: 1, selected: "midnight", custom: [] }, { setItem() { throw new Error("quota"); } }), /Could not save/);
  });
});
