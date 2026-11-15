import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { inAct, mount, unmountAll } from "./support/dom.ts";
import { PaletteSettings } from "../src/components/settings/PaletteSettings";
import {
  applyPalette, BUILTIN_PALETTES, exportPalette, PALETTE_STORAGE_KEY,
  readPaletteLibrary, selectedPalette,
} from "../src/palettes";

afterEach(() => {
  unmountAll();
  window.localStorage.removeItem(PALETTE_STORAGE_KEY);
  applyPalette(readPaletteLibrary());
});

async function importFile(m: Awaited<ReturnType<typeof mount>>, text: string | Promise<string>, size = 1000) {
  const input = m.query('input[type="file"]');
  assert.ok(input);
  Object.defineProperty(input, "files", { configurable: true, value: [{ size, text: () => Promise.resolve(text) }] });
  await inAct(() => input.dispatchEvent(new window.Event("change", { bubbles: true })));
  await m.flush();
}

describe("palette previews", () => {
  it("previews, cancels and restores on unmount without changing appearance or persistence", async () => {
    const m = await mount(<PaletteSettings />);
    document.documentElement.setAttribute("data-theme", "light");
    await m.change(m.query("#theme-palette"), "midnight");
    assert.equal(document.documentElement.getAttribute("data-palette"), "midnight");
    assert.equal(document.documentElement.getAttribute("data-theme"), "light");
    assert.equal(readPaletteLibrary().selected, "solenta");
    const css = document.getElementById("solenta-palette-colors")?.textContent ?? "";
    assert.ok(css.includes(BUILTIN_PALETTES[1].light.bg) && css.includes(BUILTIN_PALETTES[1].dark.bg));
    assert.match(css, /prefers-contrast: no-preference/);
    assert.match(css, /:not\(\[data-contrast="high"\]\)/);
    await m.click(m.byText("Cancel preview"));
    assert.equal(document.documentElement.getAttribute("data-palette"), "solenta");
    assert.equal(document.getElementById("solenta-palette-colors")?.textContent, "");
    await m.change(m.query("#theme-palette"), "forest");
    m.unmount();
    assert.equal(document.documentElement.getAttribute("data-palette"), "solenta");
  });

  it("applies and boots the saved choice, and exports valid JSON", async () => {
    const m = await mount(<PaletteSettings />);
    await m.change(m.query("#theme-palette"), "forest");
    await m.click(m.byText("Apply palette"));
    assert.equal(readPaletteLibrary().selected, "forest");
    const link = m.query("a[download]");
    assert.equal(link?.getAttribute("download"), "forest.json");
    assert.deepEqual(JSON.parse(decodeURIComponent(link?.getAttribute("href")?.split(",")[1] ?? "")), BUILTIN_PALETTES[2]);
    await m.change(m.query("#theme-palette"), "midnight");
    m.unmount();
    assert.equal(document.documentElement.getAttribute("data-palette"), "forest");
    const again = await mount(<PaletteSettings />);
    assert.equal(again.query("#theme-palette")?.getAttribute("id"), "theme-palette");
    assert.equal(selectedPalette(readPaletteLibrary()).id, "forest");
  });

  it("imports into a preview, preserves built-ins, and can cancel or remove custom palettes", async () => {
    const m = await mount(<PaletteSettings />);
    const custom = { ...BUILTIN_PALETTES[1], name: "My midnight" };
    await importFile(m, exportPalette(custom));
    assert.equal(document.documentElement.getAttribute("data-palette"), "custom:midnight");
    assert.equal(readPaletteLibrary().custom.length, 0);
    assert.equal(m.queryAll("option").length, 4);
    await m.click(m.byText("Cancel preview"));
    assert.equal(m.queryAll("option").length, 3);
    await importFile(m, exportPalette(custom));
    await m.click(m.byText("Apply palette"));
    assert.equal(readPaletteLibrary().custom[0].name, custom.name);
    await m.click(m.byText("Remove palette"));
    assert.equal(document.documentElement.getAttribute("data-palette"), "solenta");
    await m.click(m.byText("Apply palette"));
    assert.equal(readPaletteLibrary().custom.length, 0);
  });

  it("reports invalid or oversized imports and keeps the previous preview", async () => {
    const m = await mount(<PaletteSettings />);
    await m.change(m.query("#theme-palette"), "forest");
    await importFile(m, '{"css":"body{display:none}"}');
    assert.match(m.query('[role="alert"]')?.textContent ?? "", /version 1 Solenta palette/);
    await importFile(m, "unused", 20_000);
    assert.match(m.query('[role="alert"]')?.textContent ?? "", /16 KB/);
    assert.equal(document.documentElement.getAttribute("data-palette"), "forest");
    assert.equal(readPaletteLibrary().selected, "solenta");
  });

  it("keeps storage failures visible and lets Cancel restore the saved palette", async () => {
    const m = await mount(<PaletteSettings />);
    await m.change(m.query("#theme-palette"), "forest");
    const prototype = Object.getPrototypeOf(window.localStorage);
    const setItem = prototype.setItem;
    try {
      prototype.setItem = function (key: string, value: string) {
        if (key === PALETTE_STORAGE_KEY) throw new Error("quota");
        return setItem.call(this, key, value);
      };
      await m.click(m.byText("Apply palette"));
      assert.match(m.query('[role="alert"]')?.textContent ?? "", /Could not save palettes/);
      assert.equal(readPaletteLibrary().selected, "solenta");
      await m.click(m.byText("Cancel preview"));
      assert.equal(document.documentElement.getAttribute("data-palette"), "solenta");
    } finally { prototype.setItem = setItem; }
  });

  it("adopts a saved choice from another window and discards a conflicting preview", async () => {
    const m = await mount(<PaletteSettings />);
    await m.change(m.query("#theme-palette"), "midnight");
    window.localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify({ version: 1, selected: "forest", custom: [] }));
    await inAct(() => window.dispatchEvent(new window.StorageEvent("storage", { key: PALETTE_STORAGE_KEY })));
    assert.equal(document.documentElement.getAttribute("data-palette"), "forest");
    assert.equal(m.byText("Cancel preview"), null);
  });

  it("bounds new imports while allowing replacement of an existing custom id", async () => {
    const m = await mount(<PaletteSettings />);
    const custom = Array.from({ length: 20 }, (_, i) => ({ ...BUILTIN_PALETTES[1], id: `palette-${i}` }));
    window.localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify({ version: 1, selected: "solenta", custom }));
    await inAct(() => window.dispatchEvent(new window.StorageEvent("storage", { key: PALETTE_STORAGE_KEY })));
    await importFile(m, exportPalette({ ...BUILTIN_PALETTES[1], id: "new-palette" }));
    assert.match(m.query('[role="alert"]')?.textContent ?? "", /limit 20/);
    assert.equal(m.queryAll("option").length, 23);
    await importFile(m, exportPalette({ ...custom[0], name: "Updated" }));
    await m.click(m.byText("Apply palette"));
    assert.equal(readPaletteLibrary().custom.length, 20);
    assert.equal(selectedPalette(readPaletteLibrary()).name, "Updated");
  });

  it("ignores an import completed after cancellation or unmount", async () => {
    let complete: (text: string) => void = () => {};
    const pending = new Promise<string>((resolve) => { complete = resolve; });
    const m = await mount(<PaletteSettings />);
    await m.change(m.query("#theme-palette"), "forest");
    await importFile(m, pending);
    await m.click(m.byText("Cancel preview"));
    await inAct(() => complete(exportPalette(BUILTIN_PALETTES[1])));
    await m.flush();
    assert.equal(document.documentElement.getAttribute("data-palette"), "solenta");
    assert.equal(m.queryAll("option").length, 3);
    const pending2 = new Promise<string>((resolve) => { complete = resolve; });
    await importFile(m, pending2);
    m.unmount();
    await inAct(() => complete(exportPalette(BUILTIN_PALETTES[2])));
    assert.equal(readPaletteLibrary().selected, "solenta");
    assert.equal(document.documentElement.getAttribute("data-palette"), "solenta");
  });
});
