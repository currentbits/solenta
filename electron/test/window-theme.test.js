/**
 * BrowserWindow background colour from persisted theme (issue #651).
 * Run: npm run test:electron -- --test-name-pattern window-theme
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  nativeThemeSource,
  WINDOW_BG_DARK,
  WINDOW_BG_LIGHT,
  windowBackgroundColor,
} = require("../theme");

describe("windowBackgroundColor (#651)", () => {
  it("light is always the light token, dark always the dark token", () => {
    assert.equal(windowBackgroundColor("light", true), WINDOW_BG_LIGHT);
    assert.equal(windowBackgroundColor("light", false), WINDOW_BG_LIGHT);
    assert.equal(windowBackgroundColor("dark", true), WINDOW_BG_DARK);
    assert.equal(windowBackgroundColor("dark", false), WINDOW_BG_DARK);
  });

  it("system follows nativeTheme.shouldUseDarkColors", () => {
    assert.equal(windowBackgroundColor("system", true), WINDOW_BG_DARK);
    assert.equal(windowBackgroundColor("system", false), WINDOW_BG_LIGHT);
    assert.equal(windowBackgroundColor("nope", true), WINDOW_BG_DARK);
    assert.equal(windowBackgroundColor(undefined, false), WINDOW_BG_LIGHT);
  });

  it("maps preference onto nativeTheme.themeSource", () => {
    assert.equal(nativeThemeSource("light"), "light");
    assert.equal(nativeThemeSource("dark"), "dark");
    assert.equal(nativeThemeSource("system"), "system");
    assert.equal(nativeThemeSource("nope"), "system");
    assert.equal(nativeThemeSource(undefined), "system");
  });

  it("window colours match the CSS --bg tokens", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const css = fs.readFileSync(
      path.join(__dirname, "../../src/index.css"),
      "utf8",
    );
    const darkBlock = css.split(':root[data-theme="light"]')[0];
    const lightBlock = css.split(':root[data-theme="light"]')[1];
    const darkBg = darkBlock.match(/--bg:\s*(#[0-9a-fA-F]+)/)[1];
    const lightBg = lightBlock.match(/--bg:\s*(#[0-9a-fA-F]+)/)[1];
    assert.equal(WINDOW_BG_DARK, darkBg);
    assert.equal(WINDOW_BG_LIGHT, lightBg);
  });
});
