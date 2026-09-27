/**
 * Desktop sidebar width preference. The narrow drawer does not use this.
 *
 * Run: node --import=./test/support/render.mjs --test test/sidebarWidth.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AGENTS_PANEL_WIDTH,
  AGENTS_RAIL_WIDTH,
  loadSidebarWidth,
  nextSidebarPreference,
  parseSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  sidebarFitCap,
  TRANSCRIPT_MIN_WIDTH,
} from "../src/sidebarWidth.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("sidebar width preference", () => {
  it("accepts only in-range integers and falls back to 300", () => {
    assert.equal(parseSidebarWidth(null), null);
    assert.equal(parseSidebarWidth(""), null);
    assert.equal(parseSidebarWidth("wide"), null);
    assert.equal(parseSidebarWidth("300px"), null);
    assert.equal(parseSidebarWidth("300.5"), null);
    assert.equal(parseSidebarWidth(" 320"), null);
    assert.equal(parseSidebarWidth("0280"), null);
    assert.equal(parseSidebarWidth("279"), null);
    assert.equal(parseSidebarWidth("481"), null);
    assert.equal(parseSidebarWidth("-1"), null);
    assert.equal(parseSidebarWidth("280"), 280);
    assert.equal(parseSidebarWidth("300"), SIDEBAR_WIDTH_DEFAULT);
    assert.equal(parseSidebarWidth("480"), 480);

    const storage = memoryStorage();
    assert.equal(loadSidebarWidth(storage), 300);
    storage.setItem(SIDEBAR_WIDTH_KEY, "nope");
    assert.equal(loadSidebarWidth(storage), 300);
    storage.setItem(SIDEBAR_WIDTH_KEY, "360");
    assert.equal(loadSidebarWidth(storage), 360);
    assert.equal(loadSidebarWidth(null), 300);
  });

  it("ignores a storage that throws", () => {
    const storage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
    };
    assert.equal(loadSidebarWidth(storage), 300);
    assert.doesNotThrow(() => saveSidebarWidth(420, storage));
  });

  it("refuses to persist a value outside the bounds", () => {
    const storage = memoryStorage();
    saveSidebarWidth(420, storage);
    assert.equal(storage.values.get(SIDEBAR_WIDTH_KEY), "420");
    saveSidebarWidth(999, storage);
    assert.equal(storage.values.get(SIDEBAR_WIDTH_KEY), "420");
    saveSidebarWidth(Number.NaN, storage);
    assert.equal(storage.values.get(SIDEBAR_WIDTH_KEY), "420");
  });

  it("keeps a wider preference while the agents panel caps the column", () => {
    assert.equal(sidebarFitCap(1400, false), SIDEBAR_WIDTH_MAX);
    assert.equal(sidebarFitCap(901, false), SIDEBAR_WIDTH_MAX);
    assert.equal(
      sidebarFitCap(1100, true),
      1100 - AGENTS_PANEL_WIDTH - TRANSCRIPT_MIN_WIDTH,
    );
    assert.equal(sidebarFitCap(1000, true), SIDEBAR_WIDTH_MIN);
    assert.equal(sidebarFitCap(0, true), SIDEBAR_WIDTH_MAX);

    const cap = sidebarFitCap(1100, true);
    assert.equal(nextSidebarPreference(480, 8, cap, "delta"), 480);
    assert.equal(nextSidebarPreference(480, -8, cap, "delta"), cap - 8);
    assert.equal(nextSidebarPreference(480, 400, cap, "absolute"), 480);
    assert.equal(nextSidebarPreference(480, 300, cap, "absolute"), 300);
    assert.equal(nextSidebarPreference(320, 8, 480, "delta"), 328);
    assert.equal(nextSidebarPreference(320, 900, 480, "absolute"), 480);
    assert.equal(nextSidebarPreference(300, -40, 480, "delta"), SIDEBAR_WIDTH_MIN);
    assert.equal(nextSidebarPreference(300, Number.NaN, 480, "absolute"), 300);
  });

  it("clamps keyboard growth at the fit cap", () => {
    assert.equal(nextSidebarPreference(360, 8, 360, "delta"), 360);
    assert.equal(nextSidebarPreference(356, 8, 360, "delta"), 360);
    assert.equal(nextSidebarPreference(480, 8, 360, "delta"), 480);
  });

  it("matches the layout tokens the grid and drawer already use", () => {
    const index = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const app = readFileSync(new URL("../src/App.module.css", import.meta.url), "utf8");
    assert.match(index, new RegExp(`--sidebar-width:\\s*${SIDEBAR_WIDTH_DEFAULT}px`));
    assert.match(index, new RegExp(`--agents-width:\\s*${AGENTS_PANEL_WIDTH}px`));
    assert.match(index, new RegExp(`--agents-rail-width:\\s*${AGENTS_RAIL_WIDTH}px`));
    const drawerWidths = app.match(/width:\s*min\(300px,\s*88vw\)/g) ?? [];
    assert.equal(drawerWidths.length, 2, "container and media drawers keep 300px");
    assert.equal((app.match(/\.sidebarResize \{\s*display:\s*none;/g) ?? []).length, 2);
    assert.doesNotMatch(
      app.slice(0, app.indexOf(".sidebarResize")),
      /grid-template-columns:[^;]*transition/,
    );
  });
});
