"use strict";

/**
 * Trackpad pinch magnifies the window (#1807): webContents.setVisualZoomLevelLimits
 * is Chromium's compositor-level pinch zoom, separate from setZoomFactor
 * (uiScale / Cmd+±). Disabled is modeled as the locked range (1, 1).
 * Run: node --test electron/test/pinch-zoom.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { applyPinchZoom, PINCH_ZOOM_MAX } = require("../zoom.js");

function fakeWindow(over = {}) {
  const calls = [];
  const destroyed = over.destroyed === true;
  return {
    isDestroyed: () => destroyed,
    webContents:
      over.webContents === null
        ? null
        : {
            setVisualZoomLevelLimits: (min, max) => {
              calls.push([min, max]);
            },
            ...over.webContents,
          },
    _calls: calls,
  };
}

describe("applyPinchZoom (#1807)", () => {
  it("enables pinch with (1, PINCH_ZOOM_MAX) when on", () => {
    const win = fakeWindow();
    applyPinchZoom(win, true);
    assert.deepEqual(win._calls, [[1, PINCH_ZOOM_MAX]]);
  });

  it("locks the range to (1, 1) when off, disabling pinch", () => {
    const win = fakeWindow();
    applyPinchZoom(win, false);
    assert.deepEqual(win._calls, [[1, 1]]);
  });

  it("no-ops on a destroyed window", () => {
    const win = fakeWindow({ destroyed: true });
    applyPinchZoom(win, true);
    assert.deepEqual(win._calls, []);
  });

  it("no-ops when webContents is missing or lacks the API", () => {
    assert.doesNotThrow(() => applyPinchZoom(fakeWindow({ webContents: null }), true));
    assert.doesNotThrow(() => applyPinchZoom(null, true));
    const noApi = fakeWindow();
    delete noApi.webContents.setVisualZoomLevelLimits;
    assert.doesNotThrow(() => applyPinchZoom(noApi, true));
  });

  it("swallows a throw from a mid-call destroyed contents", () => {
    const win = fakeWindow({
      webContents: {
        setVisualZoomLevelLimits: () => {
          throw new Error("Object has been destroyed");
        },
      },
    });
    assert.doesNotThrow(() => applyPinchZoom(win, true));
  });
});
