"use strict";

/**
 * Embedded Browser pane (issue #155): one guest webContents per thread.
 *
 * The renderer hosts a <webview>; bind() maps threadId → webContentsId so
 * IPC and the coder-threads `preview` tool can screenshot / navigate /
 * click the same visible page the user is looking at. Navigation policy
 * lives in links.js and is the guest's outer boundary: loopback only.
 */

const { previewNavigateAction } = require("./links.js");

const PREVIEW_PARTITION_PREFIX = "solenta-preview:";
const PANE_CLOSED =
  "Browser pane is not open on this thread. Open Views → Browser, then retry.";
const MAX_SHOT_WIDTH = 1600;

/** @type {Map<string, number>} threadId → webContentsId */
const sessions = new Map();

/** @type {WeakSet<object>} */
const policyAttached = new WeakSet();

/** @type {(id: number) => object | null} */
let lookupWebContents = defaultLookup;

/** @type {(url: string) => void} */
let openExternal = defaultOpenExternal;

function defaultLookup(id) {
  try {
    const { webContents } = require("electron");
    if (!webContents || typeof webContents.fromId !== "function") return null;
    const wc = webContents.fromId(id);
    return wc && !wc.isDestroyed() ? wc : null;
  } catch {
    return null;
  }
}

function defaultOpenExternal(url) {
  try {
    const { shell } = require("electron");
    if (shell && typeof shell.openExternal === "function") {
      void shell.openExternal(url);
    }
  } catch {
    // tests / no electron
  }
}

/**
 * @param {(id: number) => object | null} fn
 */
function setWebContentsLookup(fn) {
  lookupWebContents = typeof fn === "function" ? fn : defaultLookup;
}

/**
 * @param {(url: string) => void} fn
 */
function setOpenExternal(fn) {
  openExternal = typeof fn === "function" ? fn : defaultOpenExternal;
}

function resetForTests() {
  sessions.clear();
  lookupWebContents = defaultLookup;
  openExternal = defaultOpenExternal;
}

/**
 * Partition name the renderer <webview> must use. will-attach-webview
 * refuses any other partition so a compromised renderer cannot spawn a
 * node-integrated guest.
 * @param {unknown} threadId
 */
function partitionForThread(threadId) {
  const tid = String(threadId || "");
  if (!/^[A-Za-z0-9_-]+$/.test(tid)) {
    throw new Error("Invalid thread id");
  }
  return PREVIEW_PARTITION_PREFIX + tid;
}

/**
 * Mutates guest webPreferences in place. Caller preventDefaults when
 * `{ allow: false }`.
 * @param {object} webPreferences
 * @param {{ partition?: string }} [params]
 */
function guestWebviewPolicy(webPreferences, params) {
  const wp = webPreferences && typeof webPreferences === "object"
    ? webPreferences
    : {};
  delete wp.preload;
  delete wp.preloadURL;
  wp.nodeIntegration = false;
  wp.nodeIntegrationInSubFrames = false;
  wp.contextIsolation = true;
  wp.sandbox = true;
  const partition = String(
    (params && params.partition) || wp.partition || "",
  );
  if (!partition.startsWith(PREVIEW_PARTITION_PREFIX)) {
    return { allow: false };
  }
  wp.partition = partition;
  return { allow: true };
}

/**
 * Deny window.open; send disallowed http(s) to the OS browser.
 * @param {object} wc
 */
function attachGuestPolicy(wc) {
  if (!wc || policyAttached.has(wc)) return;
  policyAttached.add(wc);
  if (typeof wc.setWindowOpenHandler === "function") {
    wc.setWindowOpenHandler(({ url }) => {
      const decision = previewNavigateAction(url);
      if (decision.external) openExternal(url);
      return { action: "deny" };
    });
  }
  const onNav = (event, url) => {
    const decision = previewNavigateAction(url);
    if (decision.allow) return;
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (decision.external) openExternal(url);
  };
  if (typeof wc.on === "function") {
    wc.on("will-navigate", onNav);
    wc.on("will-redirect", onNav);
  }
}

function threadIdOf(input) {
  const tid = String((input && input.threadId) || "");
  if (!/^[A-Za-z0-9_-]+$/.test(tid)) {
    throw new Error(tid ? `Unknown thread: ${tid}` : "Unknown thread");
  }
  return tid;
}

function requireBound(threadId) {
  const id = sessions.get(threadId);
  if (id == null) throw new Error(PANE_CLOSED);
  const wc = lookupWebContents(id);
  if (!wc) {
    sessions.delete(threadId);
    throw new Error(PANE_CLOSED);
  }
  return wc;
}

function snapshot(wc) {
  return {
    url: typeof wc.getURL === "function" ? String(wc.getURL() || "") : "",
    title: typeof wc.getTitle === "function" ? String(wc.getTitle() || "") : "",
    canGoBack: Boolean(wc.canGoBack && wc.canGoBack()),
    canGoForward: Boolean(wc.canGoForward && wc.canGoForward()),
  };
}

function dataUrlFromImage(image) {
  if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
    throw new Error("Screenshot failed: the preview is empty");
  }
  let img = image;
  if (typeof image.getSize === "function" && typeof image.resize === "function") {
    const size = image.getSize();
    if (size && Number(size.width) > MAX_SHOT_WIDTH) {
      img = image.resize({ width: MAX_SHOT_WIDTH });
    }
  }
  if (typeof img.toDataURL === "function") {
    const url = img.toDataURL();
    if (typeof url === "string" && url.startsWith("data:image/")) return url;
  }
  if (typeof img.toPNG === "function") {
    const buf = img.toPNG();
    if (Buffer.isBuffer(buf) && buf.length) {
      return `data:image/png;base64,${buf.toString("base64")}`;
    }
  }
  throw new Error("Screenshot failed");
}

/**
 * @param {{ threadId?: string, webContentsId?: number }} input
 */
function bind(input) {
  const threadId = threadIdOf(input);
  const webContentsId = Number(input && input.webContentsId);
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    throw new Error("webContentsId is required");
  }
  const wc = lookupWebContents(webContentsId);
  if (!wc) throw new Error(PANE_CLOSED);
  sessions.set(threadId, webContentsId);
  attachGuestPolicy(wc);
  if (typeof wc.once === "function") {
    wc.once("destroyed", () => {
      if (sessions.get(threadId) === webContentsId) sessions.delete(threadId);
    });
  }
  return snapshot(wc);
}

/**
 * @param {{ threadId?: string, webContentsId?: number }} input
 */
function unbind(input) {
  const threadId = threadIdOf(input);
  const current = sessions.get(threadId);
  const specified = Number(input && input.webContentsId);
  if (current == null) return { ok: true };
  if (Number.isInteger(specified) && specified > 0 && specified !== current) {
    return { ok: true };
  }
  sessions.delete(threadId);
  return { ok: true };
}

/**
 * @param {{ threadId?: string, url?: string }} input
 */
async function navigate(input) {
  const threadId = threadIdOf(input);
  const wc = requireBound(threadId);
  const decision = previewNavigateAction(input && input.url);
  if (!decision.allow) {
    throw new Error(
      decision.external
        ? "Preview only loads local URLs (localhost). Open that link in your system browser."
        : "Blocked URL",
    );
  }
  const target = decision.url || "about:blank";
  if (typeof wc.loadURL === "function") {
    await wc.loadURL(target);
  }
  return snapshot(wc);
}

/**
 * @param {{ threadId?: string }} input
 */
async function reload(input) {
  const wc = requireBound(threadIdOf(input));
  if (typeof wc.reload === "function") wc.reload();
  return snapshot(wc);
}

/**
 * @param {{ threadId?: string }} input
 */
async function goBack(input) {
  const wc = requireBound(threadIdOf(input));
  if (wc.canGoBack && wc.canGoBack() && typeof wc.goBack === "function") {
    wc.goBack();
  }
  return snapshot(wc);
}

/**
 * @param {{ threadId?: string }} input
 */
async function goForward(input) {
  const wc = requireBound(threadIdOf(input));
  if (
    wc.canGoForward &&
    wc.canGoForward() &&
    typeof wc.goForward === "function"
  ) {
    wc.goForward();
  }
  return snapshot(wc);
}

/**
 * @param {{ threadId?: string }} input
 */
async function info(input) {
  return snapshot(requireBound(threadIdOf(input)));
}

/**
 * @param {{ threadId?: string }} input
 */
async function screenshot(input) {
  const wc = requireBound(threadIdOf(input));
  if (typeof wc.capturePage !== "function") {
    throw new Error("Screenshot failed");
  }
  const image = await wc.capturePage();
  const dataUrl = dataUrlFromImage(image);
  return { dataUrl, ...snapshot(wc) };
}

function selectorScript(selector, kind, text) {
  const sel = JSON.stringify(String(selector || ""));
  if (kind === "click") {
    return `(() => {
      const el = document.querySelector(${sel});
      if (!el) return { ok: false, reason: "No element matches selector" };
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return {
        ok: true,
        tag: el.tagName,
        text: String(el.innerText || el.value || "").slice(0, 80),
      };
    })()`;
  }
  const value = JSON.stringify(String(text || ""));
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return { ok: false, reason: "No element matches selector" };
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    );
    if (setter && setter.set) setter.set.call(el, ${value});
    else if ("value" in el) el.value = ${value};
    else el.textContent = ${value};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, tag: el.tagName };
  })()`;
}

/**
 * @param {{ threadId?: string, selector?: string }} input
 */
async function click(input) {
  const wc = requireBound(threadIdOf(input));
  const selector = String((input && input.selector) || "").trim();
  if (!selector) throw new Error("selector is required");
  if (typeof wc.executeJavaScript !== "function") {
    throw new Error("Click is not available");
  }
  const result = await wc.executeJavaScript(selectorScript(selector, "click"));
  if (!result || result.ok !== true) {
    throw new Error((result && result.reason) || "Click failed");
  }
  return { ...snapshot(wc), ...result };
}

/**
 * @param {{ threadId?: string, selector?: string, text?: string }} input
 */
async function type(input) {
  const wc = requireBound(threadIdOf(input));
  const selector = String((input && input.selector) || "").trim();
  if (!selector) throw new Error("selector is required");
  if (typeof wc.executeJavaScript !== "function") {
    throw new Error("Type is not available");
  }
  const result = await wc.executeJavaScript(
    selectorScript(selector, "type", input && input.text),
  );
  if (!result || result.ok !== true) {
    throw new Error((result && result.reason) || "Type failed");
  }
  return { ...snapshot(wc), ...result };
}

module.exports = {
  PREVIEW_PARTITION_PREFIX,
  PANE_CLOSED,
  partitionForThread,
  guestWebviewPolicy,
  attachGuestPolicy,
  bind,
  unbind,
  navigate,
  reload,
  goBack,
  goForward,
  info,
  screenshot,
  click,
  type,
  setWebContentsLookup,
  setOpenExternal,
  resetForTests,
};