"use strict";

// Electron's View-menu zoom already scales every CSS px (borders, icons,
// type). Persist that factor as settings.uiScale (issue #652) instead of
// building a second rem/token scale.

const UI_SCALE_MIN = 0.8;
const UI_SCALE_MAX = 1.6;
const UI_SCALE_STEP = 0.1;
const UI_SCALE_DEFAULT = 1;

// Trackpad pinch (issue #1807): the visual zoom level cap, like a browser.
// This is Chromium's compositor-level pinch zoom, separate from
// webContents.setZoomFactor (uiScale/Cmd+±) which scales CSS px instead.
const PINCH_ZOOM_MAX = 3;

/**
 * Snap to 0.1 between 0.8 and 1.6. Junk (non-finite) → 1.
 * @param {unknown} raw
 * @returns {number}
 */
function clampUiScale(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return UI_SCALE_DEFAULT;
  const stepped = Math.round(raw / UI_SCALE_STEP) * UI_SCALE_STEP;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
  return Math.round(clamped * 10) / 10;
}

/** One 0.1 tick from `current`, already clamped. */
function nudgeUiScale(current, deltaSteps) {
  const n = Number.isFinite(deltaSteps) ? deltaSteps : 0;
  return clampUiScale(clampUiScale(current) + n * UI_SCALE_STEP);
}

function windowsToZoom(win, getAllWindows) {
  const list = [];
  const seen = new Set();
  const push = (w) => {
    if (!w || seen.has(w)) return;
    if (typeof w.isDestroyed === "function" && w.isDestroyed()) return;
    seen.add(w);
    list.push(w);
  };
  push(win);
  let extra = [];
  if (typeof getAllWindows === "function") {
    try {
      extra = getAllWindows() || [];
    } catch {
      extra = [];
    }
  } else {
    try {
      const electron = require("electron");
      const BW = electron && electron.BrowserWindow;
      if (BW && typeof BW.getAllWindows === "function") {
        extra = BW.getAllWindows() || [];
      }
    } catch {
      extra = [];
    }
  }
  for (const w of extra) push(w);
  return list;
}

/**
 * Set zoomFactor on `win` (and every other BrowserWindow) and persist
 * settings.uiScale. The Settings slider and the View menu both go through
 * this so they cannot disagree about the current scale.
 *
 * @param {import("electron").BrowserWindow | null | undefined} win
 * @param {unknown} factor
 * @param {{ setSettings?: Function, save?: Function } | null | undefined} store
 * @param {(() => unknown[]) | undefined} getAllWindows
 * @returns {number} clamped factor
 */
function applyZoom(win, factor, store, getAllWindows) {
  const next = clampUiScale(factor);
  if (store && typeof store.setSettings === "function") {
    store.setSettings({ uiScale: next });
    if (typeof store.save === "function") store.save();
  }
  for (const w of windowsToZoom(win, getAllWindows)) {
    try {
      if (w.webContents && typeof w.webContents.setZoomFactor === "function") {
        w.webContents.setZoomFactor(next);
      }
    } catch {
      // ignore a contents-destroyed race
    }
  }
  return next;
}

/**
 * Enable/disable trackpad pinch-to-magnify on one window (issue #1807).
 * Disabled is modeled as a locked range (1, 1): Electron has no on/off
 * switch for setVisualZoomLevelLimits, only a range. A pinch inside the
 * image lightbox still zooms the image instead of the window: Chromium
 * delivers the gesture as a ctrl+wheel event to the page first, and the
 * lightbox's onWheel already calls preventDefault (#1782) before this
 * visual-zoom path ever sees it.
 *
 * @param {import("electron").BrowserWindow | null | undefined} win
 * @param {unknown} enabled
 */
function applyPinchZoom(win, enabled) {
  const wc = win && !win.isDestroyed?.() ? win.webContents : null;
  if (!wc || typeof wc.setVisualZoomLevelLimits !== "function") return;
  try {
    wc.setVisualZoomLevelLimits(1, enabled ? PINCH_ZOOM_MAX : 1);
  } catch {
    // contents destroyed mid-call
  }
}

module.exports = {
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_STEP,
  UI_SCALE_DEFAULT,
  PINCH_ZOOM_MAX,
  clampUiScale,
  nudgeUiScale,
  applyZoom,
  applyPinchZoom,
};
