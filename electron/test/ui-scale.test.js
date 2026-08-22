/**
 * settings.uiScale clamp + persist + applyZoom (issue #652).
 * Run: node --test electron/test/ui-scale.test.js electron/test/menu.test.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, normalizeSettings } = require("../store");
const {
  clampUiScale,
  nudgeUiScale,
  applyZoom,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
} = require("../zoom");
const { appMenuTemplate } = require("../menu");
const services = require("../services");

describe("clampUiScale", () => {
  it("defaults junk and absent to 1", () => {
    assert.equal(clampUiScale(undefined), 1);
    assert.equal(clampUiScale(null), 1);
    assert.equal(clampUiScale("1.2"), 1);
    assert.equal(clampUiScale(NaN), 1);
    assert.equal(clampUiScale(Infinity), 1);
  });

  it("snaps to 0.1 between 0.8 and 1.6", () => {
    assert.equal(clampUiScale(1), 1);
    assert.equal(clampUiScale(1.3), 1.3);
    assert.equal(clampUiScale(1.34), 1.3);
    assert.equal(clampUiScale(1.35), 1.4);
    assert.equal(clampUiScale(0.75), UI_SCALE_MIN);
    assert.equal(clampUiScale(2), UI_SCALE_MAX);
    assert.equal(clampUiScale(0), UI_SCALE_MIN);
  });

  it("nudges by 0.1 without float smear", () => {
    assert.equal(nudgeUiScale(1.1, 1), 1.2);
    assert.equal(nudgeUiScale(1.1, -1), 1);
    assert.equal(nudgeUiScale(1.6, 1), 1.6);
    assert.equal(nudgeUiScale(0.8, -1), 0.8);
  });
});

describe("normalizeSettings uiScale", () => {
  it("absent/junk → 1; in-range kept; out-of-range clamped", () => {
    assert.equal(normalizeSettings({}).uiScale, 1);
    assert.equal(normalizeSettings({ uiScale: "1.2" }).uiScale, 1);
    assert.equal(normalizeSettings({ uiScale: 1.2 }).uiScale, 1.2);
    assert.equal(normalizeSettings({ uiScale: 1.7 }).uiScale, 1.6);
    assert.equal(normalizeSettings({ uiScale: 0.5 }).uiScale, 0.8);
  });
});

describe("setSettings uiScale", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-uiscale-"));
    filePath = path.join(dir, "store.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("persists a clamped value across reload", () => {
    const store = new Store(filePath);
    assert.equal(store.getSettings().uiScale, 1);
    const next = services.setSettings(store, { uiScale: 1.34 });
    assert.equal(next.uiScale, 1.3);
    store.saveNow();
    const reloaded = new Store(filePath);
    assert.equal(reloaded.getSettings().uiScale, 1.3);
  });

  it("clamps the top of the range and rejects non-numbers", () => {
    const store = new Store(filePath);
    assert.equal(services.setSettings(store, { uiScale: 2 }).uiScale, 1.6);
    assert.throws(
      () => services.setSettings(store, { uiScale: "1.2" }),
      /uiScale must be a number/,
    );
    assert.equal(store.getSettings().uiScale, 1.6);
  });
});

describe("applyZoom", () => {
  it("sets zoomFactor on the window and saves uiScale", () => {
    const factors = [];
    const saved = [];
    const win = {
      isDestroyed: () => false,
      webContents: { setZoomFactor: (f) => factors.push(f) },
    };
    const store = {
      setSettings(patch) {
        saved.push(patch);
        return { uiScale: patch.uiScale };
      },
      save() {
        saved.push("save");
      },
    };
    const next = applyZoom(win, 1.37, store, () => []);
    assert.equal(next, 1.4);
    assert.deepEqual(factors, [1.4]);
    assert.deepEqual(saved, [{ uiScale: 1.4 }, "save"]);
  });

  it("zooms every window from getAllWindows, not just the focused one", () => {
    const factors = [];
    const makeWin = () => ({
      isDestroyed: () => false,
      webContents: { setZoomFactor: (f) => factors.push(f) },
    });
    const focused = makeWin();
    const other = makeWin();
    applyZoom(focused, 1.2, { setSettings() {}, save() {} }, () => [other]);
    assert.deepEqual(factors, [1.2, 1.2]);
  });
});

describe("View menu zoom items (issue #652)", () => {
  it("routes Actual Size / Zoom In / Zoom Out through applyZoom", () => {
    const calls = [];
    const t = appMenuTemplate({
      platform: "darwin",
      applyZoom: (win, factor) => calls.push([win, factor]),
      getUiScale: () => 1.1,
    });
    const view = t.find((m) => m.label === "View");
    const fakeWin = { id: 1 };
    const actual = view.submenu.find((i) => i.label === "Actual Size");
    const zoomIn = view.submenu.find(
      (i) => i.label === "Zoom In" && i.visible !== false,
    );
    const zoomInEq = view.submenu.find(
      (i) => i.label === "Zoom In" && i.visible === false,
    );
    const zoomOut = view.submenu.find((i) => i.label === "Zoom Out");
    assert.equal(actual.accelerator, "CommandOrControl+0");
    assert.equal(zoomIn.accelerator, "CommandOrControl+Plus");
    assert.equal(zoomInEq.accelerator, "CommandOrControl+=");
    assert.equal(zoomOut.accelerator, "CommandOrControl+-");
    actual.click(null, fakeWin);
    zoomIn.click(null, fakeWin);
    zoomOut.click(null, fakeWin);
    assert.deepEqual(calls, [
      [fakeWin, 1],
      [fakeWin, 1.2],
      [fakeWin, 1],
    ]);
  });
});
