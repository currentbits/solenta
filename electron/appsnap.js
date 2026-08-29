"use strict";

/**
 * AppSnap (issue #381): list on-screen windows and capture one into a PNG
 * buffer. desktopCapturer is injected so tests do not load Electron.
 */

/** @type {(opts: object) => Promise<Array<{ id: string, name: string, thumbnail?: { toPNG: () => Buffer } }>>} */
let getSourcesImpl = null;

function defaultGetSources(opts) {
  const { desktopCapturer } = require("electron");
  return desktopCapturer.getSources(opts);
}

function getSources(opts) {
  return (getSourcesImpl || defaultGetSources)(opts);
}

/** Test hook. Pass null to restore the Electron implementation. */
function setGetSources(fn) {
  getSourcesImpl = fn;
}

/**
 * @returns {Promise<{ windows: Array<{ id: string, name: string }> }>}
 */
async function listWindows() {
  const sources = await getSources({
    types: ["window"],
    thumbnailSize: { width: 1, height: 1 },
  });
  const windows = [];
  for (const src of sources || []) {
    const id = String(src && src.id ? src.id : "");
    const name = String(src && src.name ? src.name : "").trim();
    if (!id || !name) continue;
    windows.push({ id, name });
  }
  return { windows };
}

/**
 * Capture one window's current pixels as a PNG buffer.
 * @param {string} sourceId
 * @returns {Promise<Buffer>}
 */
async function captureWindowPng(sourceId) {
  const id = String(sourceId || "");
  if (!id) throw new Error("No window selected");
  const sources = await getSources({
    types: ["window"],
    thumbnailSize: { width: 2560, height: 1600 },
  });
  const src = (sources || []).find((s) => s && s.id === id);
  if (!src || !src.thumbnail || typeof src.thumbnail.toPNG !== "function") {
    throw new Error("Window is no longer available");
  }
  const buf = src.thumbnail.toPNG();
  if (!buf || !buf.length) throw new Error("Failed to capture the window");
  return buf;
}

module.exports = {
  listWindows,
  captureWindowPng,
  setGetSources,
};
