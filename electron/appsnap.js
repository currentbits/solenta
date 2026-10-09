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
 * Find one window source and capture its current pixels as a PNG buffer.
 * @param {string} sourceId
 * @returns {Promise<{ png: Buffer, name: string }>}
 */
async function captureSource(sourceId) {
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
  const png = src.thumbnail.toPNG();
  if (!png || !png.length) throw new Error("Failed to capture the window");
  return { png, name: String(src.name || "").trim() };
}

/**
 * Capture one window's current pixels as a PNG buffer.
 * @param {string} sourceId
 * @returns {Promise<Buffer>}
 */
async function captureWindowPng(sourceId) {
  return (await captureSource(sourceId)).png;
}

/**
 * JXA walker for one window's AX tree (#1531). Prints JSON
 * `{ tree, truncated }` or `{ error: "untrusted" | "nowindow" }`. The AX
 * functions are rebound with `id` types: JXA's default CF typing cannot pass
 * an element taken out of an AXChildren array back into AX calls.
 * argv: CGWindowID, window title, node cap.
 */
const AX_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
ObjC.bindFunction("AXUIElementCreateApplication", ["id", ["int"]]);
ObjC.bindFunction("AXUIElementSetMessagingTimeout", ["int", ["id", "float"]]);
ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["id", "id", "id *"]]);
function run(argv) {
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ error: "untrusted" });
  var wid = Number(argv[0]);
  var want = String(argv[1] || "");
  var maxNodes = Number(argv[2]) || 3000;
  var info = ObjC.deepUnwrap(ObjC.castRefToObject(
    $.CGWindowListCopyWindowInfo($.kCGWindowListOptionIncludingWindow, wid)));
  if (!info || !info.length) return JSON.stringify({ error: "nowindow" });
  var app = $.AXUIElementCreateApplication(info[0].kCGWindowOwnerPID);
  $.AXUIElementSetMessagingTimeout(app, 0.5);
  function attr(el, name) {
    var ref = Ref();
    return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ref[0] : null;
  }
  function text(el, name) {
    var v = attr(el, name);
    if (!v || !(v.isKindOfClass($.NSString) || v.isKindOfClass($.NSNumber))) return "";
    return String(v.js);
  }
  function list(el, name) {
    var arr = attr(el, name);
    var out = [];
    if (!arr || !arr.isKindOfClass($.NSArray)) return out;
    for (var i = 0; i < Number(arr.count); i++) out.push(arr.objectAtIndex(i));
    return out;
  }
  var wins = list(app, "AXWindows");
  var win = null;
  for (var i = 0; i < wins.length && want && !win; i++) {
    if (text(wins[i], "AXTitle") === want) win = wins[i];
  }
  if (!win) win = attr(app, "AXFocusedWindow") || wins[0];
  if (!win) return JSON.stringify({ error: "nowindow" });
  var count = 0;
  var truncated = false;
  function walk(el, depth) {
    count++;
    var node = { r: text(el, "AXRole"), t: text(el, "AXTitle"),
      v: text(el, "AXValue"), d: text(el, "AXDescription"), c: [] };
    if (depth >= 40) return node;
    var kids = list(el, "AXChildren");
    for (var k = 0; k < kids.length; k++) {
      if (count >= maxNodes) { truncated = true; break; }
      node.c.push(walk(kids[k], depth + 1));
    }
    return node;
  }
  return JSON.stringify({ tree: walk(win, 0), truncated: truncated });
}
`;

const AX_TIMEOUT_MS = 5000;
const AX_MAX_NODES = 3000;
const AX_MAX_CHARS = 20000;

/** @type {typeof import("node:child_process").execFile | null} */
let execFileImpl = null;

/** Test hook. Pass null to restore node's execFile. */
function setExecFile(fn) {
  execFileImpl = fn;
}

/**
 * Flatten an AX tree into indented `role "text"` lines. Nodes with no text
 * add no line and do not indent their children, so layout groups vanish.
 * Pure: the tree is `{ r, t, v, d, c }` as printed by AX_SCRIPT.
 * @param {{ r?: string, t?: string, v?: string, d?: string, c?: any[] } | null} tree
 * @param {{ maxChars?: number, truncated?: boolean }} [opts]
 * @returns {string}
 */
function flattenAxTree(tree, opts = {}) {
  const maxChars = opts.maxChars || AX_MAX_CHARS;
  const lines = [];
  let used = 0;
  let full = false;
  const visit = (node, depth) => {
    if (!node || full) return;
    const parts = [];
    for (const key of ["t", "v", "d"]) {
      const s = String(node[key] || "").trim();
      if (s && !parts.includes(s)) parts.push(s);
    }
    let childDepth = depth;
    if (parts.length) {
      const pad = "  ".repeat(depth);
      const role = String(node.r || "").replace(/^AX/, "").toLowerCase();
      const body = parts.map((p) => JSON.stringify(p)).join(" ");
      const line = `${pad}${role || "element"} ${body}`;
      if (used + line.length + 1 > maxChars) {
        full = true;
        return;
      }
      lines.push(line);
      used += line.length + 1;
      childDepth = depth + 1;
    }
    for (const child of node.c || []) visit(child, childDepth);
  };
  visit(tree, 0);
  if (full || opts.truncated) {
    lines.push(`[truncated: window text capped at ${maxChars} characters]`);
  }
  return lines.join("\n");
}

function runAxScript(windowNumber, title) {
  const exec = execFileImpl || require("node:child_process").execFile;
  return new Promise((resolve, reject) => {
    exec(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", AX_SCRIPT, String(windowNumber), title, String(AX_MAX_NODES)],
      { timeout: AX_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ""))),
    );
  });
}

/**
 * Accessibility text for a desktopCapturer window (`window:<CGWindowID>:0`).
 * null off macOS; `{ skipped }` carries a one-line reason when the read fails
 * (most often a missing Accessibility permission).
 * @param {string} sourceId
 * @param {string} title
 * @param {{ platform?: string }} [opts]
 * @returns {Promise<{ text: string } | { skipped: string } | null>}
 */
async function readWindowText(sourceId, title, opts = {}) {
  if ((opts.platform || process.platform) !== "darwin") return null;
  const m = /^window:(\d+):/.exec(String(sourceId || ""));
  if (!m) return { skipped: "Window text skipped: not a native window" };
  let out;
  try {
    out = JSON.parse(await runAxScript(m[1], String(title || "")));
  } catch (err) {
    return {
      skipped:
        err && err.killed
          ? "Window text skipped: the accessibility read timed out"
          : "Window text skipped: the accessibility read failed",
    };
  }
  if (out && out.error === "untrusted") {
    return {
      skipped:
        "Window text skipped: allow Solenta in System Settings > Privacy & Security > Accessibility",
    };
  }
  if (!out || !out.tree) {
    return { skipped: "Window text skipped: window not found" };
  }
  const text = flattenAxTree(out.tree, { truncated: out.truncated });
  if (!text) {
    return { skipped: "Window text skipped: the window exposes no text" };
  }
  return { text };
}

/**
 * Accessibility text of one window, read separately from the PNG so the
 * screenshot chip never waits on it. The window title (to pick the right AX
 * window of a multi-window app) comes from the capturer's source list.
 * @param {string} sourceId
 * @param {{ platform?: string }} [opts]
 * @returns {Promise<{ name: string, text: string } | { skipped: string } | null>}
 */
async function captureWindowText(sourceId, opts = {}) {
  if ((opts.platform || process.platform) !== "darwin") return null;
  const id = String(sourceId || "");
  const { windows } = await listWindows();
  const win = windows.find((w) => w.id === id);
  if (!win) return { skipped: "Window text skipped: window not found" };
  const ax = await readWindowText(id, win.name, opts);
  if (!ax || "skipped" in ax) return ax;
  return { name: win.name, text: ax.text };
}

module.exports = {
  listWindows,
  captureWindowPng,
  captureWindowText,
  readWindowText,
  flattenAxTree,
  setGetSources,
  setExecFile,
};
