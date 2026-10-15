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
const INITIAL_LOAD_WAIT_MS = 2000;

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

function dataUrlFromImage(image, maxWidth = MAX_SHOT_WIDTH, maxHeight = Infinity) {
  if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
    throw new Error("Screenshot failed: the preview is empty");
  }
  let img = image;
  if (typeof image.getSize === "function" && typeof image.resize === "function") {
    const size = image.getSize();
    const w = Number(size && size.width) || 0;
    const h = Number(size && size.height) || 0;
    if (w > maxWidth || h > maxHeight) {
      // Electron keeps the aspect ratio when only one edge is given.
      img = w / maxWidth >= h / maxHeight
        ? image.resize({ width: maxWidth })
        : image.resize({ height: maxHeight });
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
 * A guest binds on did-attach while its initial about:blank is still
 * loading. loadURL issued then resolves on THAT load's did-finish-load, so
 * navigate would report about:blank before the real page commits. Wait
 * (bounded) for the initial load to stop first.
 * @param {object} wc
 */
function initialLoadSettled(wc) {
  if (typeof wc.isLoading !== "function" || !wc.isLoading()) return;
  const url = typeof wc.getURL === "function" ? String(wc.getURL() || "") : "";
  if (url && url !== "about:blank") return;
  if (typeof wc.once !== "function") return;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (typeof wc.removeListener === "function") {
        wc.removeListener("did-stop-loading", done);
      }
      resolve();
    };
    const timer = setTimeout(done, INITIAL_LOAD_WAIT_MS);
    wc.once("did-stop-loading", done);
  });
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
  await initialLoadSettled(wc);
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

/**
 * Element inspector (#1193). Runs INSIDE the guest page, in an isolated
 * world so page scripts cannot read or patch it. Stringified, so it must not
 * close over anything. Resolves once with { cancelled } or the picked
 * element's description; a second call (cancel or a new pick) settles the
 * pending one as cancelled. Every page activation event is swallowed while
 * picking, so selecting a submit button does not submit its form.
 * @param {{ cancel?: boolean, htmlCap: number, textCap: number }} opts
 */
function guestInspect(opts) {
  const KEY = "__solentaInspect";
  const pending = window[KEY];
  if (pending) pending.finish({ cancelled: true });
  if (opts.cancel) return { cancelled: true };

  const STYLE_PROPS = [
    "display", "position", "box-sizing", "width", "height", "margin",
    "padding", "border", "border-radius", "color", "background-color",
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
    "text-align", "gap", "flex-direction", "justify-content", "align-items",
    "grid-template-columns", "overflow", "opacity", "z-index", "box-shadow",
  ];
  const SECRET_ATTR = /token|secret|passw|csrf|xsrf|nonce|api[-_]?key|auth|session|cookie/i;
  const SECRET_VALUE = /^(eyJ[\w-]+\.[\w-]+\.|(?:sk|pk|ghp|gho|xox[abp])[-_][\w-]{8,})/;
  const SOURCE_ATTRS = [
    "data-source-file", "data-inspector-relative-path", "data-source",
    "data-loc", "data-sourcepos",
  ];
  const esc = (s) =>
    window.CSS && typeof window.CSS.escape === "function"
      ? window.CSS.escape(s)
      : String(s).replace(/[^\w-]/g, (c) => `\\${c}`);
  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };

  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return { nav: "navigation", main: "main", form: "form", ul: "list", ol: "list", li: "listitem", dialog: "dialog" }[tag] || "";
  };

  // Never reads a text field's value: only button-type inputs label with it.
  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria, opts.textCap);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent)
        .join(" ");
      if (text.trim()) return clip(text, opts.textCap);
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].includes(type)) {
      return clip(el.getAttribute("value") || type, opts.textCap);
    }
    if (["input", "textarea", "select"].includes(tag)) {
      const label = el.labels && el.labels[0];
      if (label) return clip(label.textContent, opts.textCap);
      return clip(el.getAttribute("placeholder") || el.getAttribute("name") || "", opts.textCap);
    }
    if (tag === "img") return clip(el.getAttribute("alt") || "", opts.textCap);
    return clip(el.getAttribute("title") || el.textContent || "", opts.textCap);
  };

  const unique = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const selectorFor = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id && unique(`#${esc(n.id)}`)) {
        parts.unshift(`#${esc(n.id)}`);
        break;
      }
      let part = n.tagName.toLowerCase();
      const testId = n.getAttribute("data-testid");
      if (testId) {
        part += `[data-testid="${esc(testId)}"]`;
      } else if (n.parentElement) {
        const same = Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      if (n === document.body) break;
    }
    return parts.join(" > ");
  };

  // Copy into an inert document (no fetches), then strip anything secret.
  const safeHtml = (el) => {
    const inert = document.implementation.createHTMLDocument("");
    const clone = inert.importNode(el, true);
    const all = [clone, ...clone.querySelectorAll("*")];
    for (const node of all) {
      const tag = node.tagName.toLowerCase();
      const type = (node.getAttribute("type") || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "template") node.textContent = "";
      if (tag === "input" && type !== "button" && type !== "submit" && type !== "reset") {
        if (node.hasAttribute("value")) node.setAttribute("value", "[redacted]");
      }
      for (const attr of Array.from(node.attributes)) {
        if (SECRET_ATTR.test(attr.name) || SECRET_VALUE.test(attr.value)) {
          node.setAttribute(attr.name, "[redacted]");
        }
      }
    }
    const html = clone.outerHTML;
    return html.length > opts.htmlCap
      ? { html: html.slice(0, opts.htmlCap), htmlTruncated: true }
      : { html, htmlTruncated: false };
  };

  const sourceFor = (el) => {
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 6; i += 1, n = n.parentElement) {
      for (const name of SOURCE_ATTRS) {
        const v = n.getAttribute(name);
        if (!v) continue;
        const line = n.getAttribute("data-inspector-line");
        return clip(line ? `${v}:${line}` : v, 300);
      }
    }
    return null;
  };

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const styles = {};
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) styles[p] = clip(v, 200);
    }
    const tag = el.tagName.toLowerCase();
    return {
      cancelled: false,
      tag,
      role: el.getAttribute("role") || implicitRole(el),
      name: accessibleName(el),
      selector: selectorFor(el),
      ...safeHtml(el),
      styles,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      source: sourceFor(el),
      frame: tag === "iframe" || tag === "frame",
      password: tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "password",
    };
  };

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;display:none;pointer-events:none;box-sizing:border-box;border:2px solid #2563eb;background:rgba(37,99,235,.14);border-radius:2px";
    const badge = document.createElement("div");
    badge.style.cssText = "position:fixed;display:none;pointer-events:none;font:11px/16px ui-monospace,Menlo,monospace;color:#fff;background:#1e3a8a;padding:0 5px;border-radius:2px;white-space:nowrap";
    root.append(box, badge);
    (document.body || document.documentElement).appendChild(host);

    let current = null;
    const pickable = (n) => n && n.nodeType === 1 && n !== host && n !== document.documentElement;
    const highlight = (el) => {
      if (!pickable(el)) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, {
        display: "block", left: `${r.left}px`, top: `${r.top}px`,
        width: `${r.width}px`, height: `${r.height}px`,
      });
      badge.textContent = `${el.tagName.toLowerCase()} ${Math.round(r.width)}×${Math.round(r.height)}`;
      Object.assign(badge.style, {
        display: "block", left: `${Math.max(0, r.left)}px`,
        top: `${r.top >= 18 ? r.top - 18 : r.bottom + 2}px`,
      });
    };

    const BLOCK = [
      "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick",
      "auxclick", "contextmenu", "touchstart", "touchend", "submit", "keypress",
    ];
    const swallow = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onBlocked = (e) => {
      swallow(e);
      if (e.type === "click" && e.button === 0 && pickable(e.target)) select(e.target);
    };
    const onMove = (e) => {
      if (e.target !== current) highlight(e.target);
    };
    const onFocus = (e) => highlight(e.target);
    const onKeyDown = (e) => {
      if (e.key === "Tab") return;
      swallow(e);
      if (e.key === "Escape") return finish({ cancelled: true });
      if (e.key === "ArrowUp" && current && pickable(current.parentElement)) {
        highlight(current.parentElement);
      } else if (e.key === "ArrowDown" && current && current.firstElementChild) {
        highlight(current.firstElementChild);
      } else if (e.key === "Enter" || e.key === " ") {
        const target = current || (pickable(document.activeElement) && document.activeElement !== document.body ? document.activeElement : null);
        if (target) {
          // A button activates on Space keyup; eat the trailing keyup too.
          const key = e.key;
          const eatUp = (u) => {
            if (u.key !== key) return;
            swallow(u);
            window.removeEventListener("keyup", eatUp, true);
          };
          window.addEventListener("keyup", eatUp, true);
          setTimeout(() => window.removeEventListener("keyup", eatUp, true), 1000);
          select(target);
        }
      }
    };
    const onKeyUp = (e) => {
      if (e.key !== "Tab") swallow(e);
    };

    const listen = (on) => {
      const fn = on ? "addEventListener" : "removeEventListener";
      for (const t of BLOCK) window[fn](t, onBlocked, true);
      window[fn]("mouseover", onMove, true);
      window[fn]("focusin", onFocus, true);
      window[fn]("keydown", onKeyDown, true);
      window[fn]("keyup", onKeyUp, true);
    };

    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      listen(false);
      host.remove();
      if (window[KEY] === state) delete window[KEY];
      // Two frames so the overlay is gone before main captures the crop.
      const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      raf(() => raf(() => resolve(result)));
    }
    function select(el) {
      let result;
      try {
        result = describe(el);
      } catch (err) {
        result = { cancelled: true, error: String((err && err.message) || err) };
      }
      finish(result);
    }
    const state = { finish };
    window[KEY] = state;
    listen(true);
    if (pickable(document.activeElement) && document.activeElement !== document.body) {
      highlight(document.activeElement);
    }
  });
}

const INSPECT_WORLD_ID = 1193;
const INSPECT_HTML_CAP = 3_000;
const INSPECT_TEXT_CAP = 160;
const INSPECT_STYLE_CAP = 32;
const INSPECT_CROP_PAD = 8;
const MAX_CROP_EDGE = 800;

function inspectScript(cancel) {
  const opts = { cancel, htmlCap: INSPECT_HTML_CAP, textCap: INSPECT_TEXT_CAP };
  return `(${guestInspect.toString()})(${JSON.stringify(opts)})`;
}

function runInGuest(wc, code) {
  if (typeof wc.executeJavaScriptInIsolatedWorld === "function") {
    return wc.executeJavaScriptInIsolatedWorld(INSPECT_WORLD_ID, [{ code }], true);
  }
  return wc.executeJavaScript(code, true);
}

/**
 * The pick promise never settles if the page navigates away or the guest is
 * destroyed (pane closed, thread switched); settle it as cancelled then.
 */
function untilPageLeaves(wc, pending) {
  if (typeof wc.on !== "function") return pending;
  let off = () => {};
  const left = new Promise((resolve) => {
    // Electron passes details on the event; the positional args are deprecated.
    const onNav = (e, _url, isInPlace, isMainFrame) => {
      const main = e && typeof e.isMainFrame === "boolean" ? e.isMainFrame : isMainFrame;
      const same = e && typeof e.isSameDocument === "boolean" ? e.isSameDocument : isInPlace;
      if (main !== false && !same) resolve({ cancelled: true });
    };
    const onGone = () => resolve({ cancelled: true });
    wc.on("did-start-navigation", onNav);
    wc.on("destroyed", onGone);
    wc.on("render-process-gone", onGone);
    off = () => {
      if (typeof wc.removeListener !== "function") return;
      wc.removeListener("did-start-navigation", onNav);
      wc.removeListener("destroyed", onGone);
      wc.removeListener("render-process-gone", onGone);
    };
  });
  return Promise.race([pending, left]).finally(() => off());
}

function str(v, cap) {
  const s = typeof v === "string" ? v : "";
  return s.length > cap ? s.slice(0, cap) : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The guest is untrusted: re-type and re-cap everything it reports. */
function sanitizePick(raw) {
  const styles = {};
  const rawStyles = raw && typeof raw.styles === "object" && raw.styles ? raw.styles : {};
  for (const [k, v] of Object.entries(rawStyles).slice(0, INSPECT_STYLE_CAP)) {
    if (/^[a-z-]{1,40}$/.test(k) && typeof v === "string") styles[k] = str(v, 200);
  }
  const rect = (raw && raw.rect) || {};
  const viewport = (raw && raw.viewport) || {};
  const html = str(raw && raw.html, INSPECT_HTML_CAP);
  const tag = str(raw && raw.tag, 40).toLowerCase();
  return {
    tag: /^[a-z][a-z0-9-]*$/.test(tag) ? tag : "element",
    role: str(raw && raw.role, 40),
    name: str(raw && raw.name, INSPECT_TEXT_CAP + 1),
    selectorHint: str(raw && raw.selector, 300),
    html,
    htmlTruncated: Boolean(raw && raw.htmlTruncated),
    styles,
    rect: {
      x: num(rect.x),
      y: num(rect.y),
      width: Math.max(0, num(rect.width)),
      height: Math.max(0, num(rect.height)),
    },
    viewport: {
      width: Math.max(0, num(viewport.width)),
      height: Math.max(0, num(viewport.height)),
    },
    source: raw && typeof raw.source === "string" && raw.source
      ? str(raw.source, 300)
      : null,
    frame: Boolean(raw && raw.frame),
    password: Boolean(raw && raw.password),
  };
}

/**
 * Element rect (CSS px, viewport-relative) → capturePage rect (DIP). Page
 * zoom scales CSS px; clamp to the visible viewport plus a little padding.
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function cropRect(rect, viewport, zoom = 1) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x0 = Math.max(0, rect.x - INSPECT_CROP_PAD);
  const y0 = Math.max(0, rect.y - INSPECT_CROP_PAD);
  const x1 = Math.min(viewport.width, rect.x + rect.width + INSPECT_CROP_PAD);
  const y1 = Math.min(viewport.height, rect.y + rect.height + INSPECT_CROP_PAD);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return {
    x: Math.floor(x0 * z),
    y: Math.floor(y0 * z),
    width: Math.ceil((x1 - x0) * z),
    height: Math.ceil((y1 - y0) * z),
  };
}

/**
 * Start an element pick on the bound guest. Resolves when the user selects
 * (click, or Enter on the focused element) or cancels (Escape, cancelInspect,
 * navigation, pane closed).
 * @param {{ threadId?: string }} input
 */
async function inspect(input) {
  const threadId = threadIdOf(input);
  const wc = requireBound(threadId);
  if (typeof wc.executeJavaScript !== "function") {
    throw new Error("Inspect is not available");
  }
  const pageUrl = snapshot(wc).url;
  if (!pageUrl || pageUrl === "about:blank") {
    throw new Error("Load a page before inspecting");
  }
  const raw = await untilPageLeaves(wc, runInGuest(wc, inspectScript(false)));
  if (!raw || raw.cancelled || snapshot(wc).url !== pageUrl) {
    return { cancelled: true, ...snapshot(wc) };
  }
  const element = sanitizePick(raw);
  const zoom = typeof wc.getZoomFactor === "function" ? Number(wc.getZoomFactor()) : 1;
  const rect = cropRect(element.rect, element.viewport, zoom);
  let crop = null;
  let cropNote;
  if (!rect) {
    cropNote = "The element is outside the visible viewport, so there is no crop.";
  } else if (typeof wc.capturePage !== "function") {
    cropNote = "Screenshot capture is not available.";
  } else {
    try {
      crop = dataUrlFromImage(await wc.capturePage(rect), MAX_CROP_EDGE, MAX_CROP_EDGE);
    } catch (err) {
      cropNote = `Crop failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return {
    cancelled: false,
    ...snapshot(wc),
    url: pageUrl,
    capturedAt: Date.now(),
    element,
    crop,
    cropRect: rect,
    ...(cropNote ? { cropNote } : {}),
  };
}

/**
 * @param {{ threadId?: string }} input
 */
async function cancelInspect(input) {
  const wc = requireBound(threadIdOf(input));
  if (typeof wc.executeJavaScript === "function") {
    await runInGuest(wc, inspectScript(true)).catch(() => {});
  }
  return { ok: true };
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
  inspect,
  cancelInspect,
  inspectScript,
  cropRect,
  setWebContentsLookup,
  setOpenExternal,
  resetForTests,
};