"use strict";

/**
 * Window chrome colours for issue #651. Keep WINDOW_BG_* in lockstep with
 * `src/index.css` `--bg` for the matching theme so the BrowserWindow does
 * not flash the other theme before the renderer paints.
 */
const WINDOW_BG_DARK = "#0a0d13";
const WINDOW_BG_LIGHT = "#f3f5f8";

/**
 * @param {unknown} preference
 * @returns {"system" | "light" | "dark"}
 */
function nativeThemeSource(preference) {
  return preference === "light" || preference === "dark" ? preference : "system";
}

/**
 * @param {unknown} preference
 * @param {boolean} shouldUseDarkColors
 * @returns {string}
 */
function windowBackgroundColor(preference, shouldUseDarkColors) {
  if (preference === "light") return WINDOW_BG_LIGHT;
  if (preference === "dark") return WINDOW_BG_DARK;
  return shouldUseDarkColors ? WINDOW_BG_DARK : WINDOW_BG_LIGHT;
}

module.exports = {
  WINDOW_BG_DARK,
  WINDOW_BG_LIGHT,
  nativeThemeSource,
  windowBackgroundColor,
};
