"use strict";

/**
 * Embedded Browser pane (issue #155): one guest webContents per thread.
 *
 * The renderer hosts a <webview>; bind() maps threadId → webContentsId so
 * IPC and the coder-threads `preview` tool can screenshot / navigate /
 * click the same visible page the user is looking at. Navigation policy
 * lives in links.js and is the guest's outer boundary: loopback only.
 *
 * Issue #1191 adds read-only evidence on the same session: a bounded
 * semantic snapshot whose refs die with the document, bounded console and
 * network rings, and explicit viewport presets. Page scripts are fixed
 * functions below run in an isolated world; nothing evaluates caller code.
 * WebMCP uses a separate sandboxed preload and fixed main-world calls to the
 * page's own registered tools. No host API is exposed to that page.
 */

const { previewNavigateAction } = require("./links.js");
const { randomUUID } = require("node:crypto");

const PREVIEW_PARTITION_PREFIX = "solenta-preview:";
const PANE_CLOSED =
  "Browser pane is not open on this thread. Open Views → Browser, then retry.";
const MAX_SHOT_WIDTH = 1600;
// #1940: the un-resized capture behind the latest screenshot, kept only for
// an explicit user save. One per thread, in memory, dropped on expiry,
// the next shot, or pane close. It never goes to the agent.
const ORIGINAL_TTL_MS = 10 * 60_000;
const NO_ORIGINAL =
  "No screenshot to save. Take a screenshot first (originals are kept for 10 minutes).";
const INITIAL_LOAD_WAIT_MS = 2000;
// Fallback only: Electron >=27 emits `audio-state-changed` itself, so this
// timer never starts on a real build (issue #1807).
const AUDIO_POLL_MS = 1000;
// Our page scripts run here: the page cannot see or patch them, and the
// world's globals (snapshot refs) die with the document.
const ISOLATED_WORLD_ID = 1191;
const ACTION_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 5000;
const SNAPSHOT_LIMITS = { maxNodes: 250, maxDepth: 48, maxBytes: 32_000, maxName: 80 };
const CONSOLE_RING = 100;
const NETWORK_RING = 100;
const MAX_TEXT = 500;
const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};
// Successful static assets would flood the ring on a dev server (Vite loads
// hundreds of modules); they are kept only when they fail.
const NETWORK_KEEP_TYPES = new Set(["mainFrame", "subFrame", "xhr", "webSocket"]);
const CONSOLE_LEVELS = ["debug", "info", "warning", "error"];

/**
 * @typedef {{
 *   webContentsId: number,
 *   docGeneration: number,
 *   snapshotSeq: number,
 *   snapshot: { id: number, docGeneration: number } | null,
 *   webmcp: { refs: Set<string>, pending: Map<string, () => void> },
 *   console: object[],
 *   network: object[],
 *   dropped: { console: number, network: number },
 *   seq: number,
 *   emulation: { preset: string, width: number, height: number, scale: number } | null,
 *   natural: { width: number, height: number } | null,
 *   audible: boolean,
 *   muted: boolean,
 *   original: { image: object, timer: ReturnType<typeof setTimeout> } | null,
 *   detach: () => void,
 * }} Session
 */

/** @type {Map<string, Session>} threadId → bound guest */
const sessions = new Map();

/** @type {WeakSet<object>} */
const policyAttached = new WeakSet();
const webMcpPolicies = new WeakMap();

function webMcpHeadersAllowed(headers) {
  // shortcut: old Chromium cannot parse the draft tools policy; reject every
  // explicit tools directive until native Permissions-Policy support is used.
  return !Object.entries(headers || {}).some(([name, values]) =>
    name.toLowerCase() === "permissions-policy" && /(?:^|,)\s*tools\b/i.test([values].flat().join(",")),
  );
}

function webMcpPolicyAllowed(wc, url) {
  const policy = webMcpPolicies.get(wc);
  return Boolean(policy?.allowed && policy.url === String(url).split("#")[0] && previewNavigateAction(url).allow);
}

/** @type {(id: number) => object | null} */
let lookupWebContents = defaultLookup;

/** @type {(url: string) => void} */
let openExternal = defaultOpenExternal;

/**
 * Pushed on every audible/muted change (#1807). main.js wires this to
 * broadcast("preview:audioChanged", ...); tests read the raw calls.
 * @type {(threadId: string, state: { audible: boolean, muted: boolean }) => void}
 */
let audioPush = () => {};

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

/**
 * @param {(threadId: string, state: { audible: boolean, muted: boolean }) => void} fn
 */
function setAudioPush(fn) {
  audioPush = typeof fn === "function" ? fn : () => {};
}

function resetForTests() {
  for (const s of sessions.values()) s.detach();
  sessions.clear();
  lookupWebContents = defaultLookup;
  openExternal = defaultOpenExternal;
  audioPush = () => {};
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
  // Paint the browser canvas, so guest screenshots don't depend on the host backdrop.
  wp.transparent = false;
  const partition = String(
    (params && params.partition) || wp.partition || "",
  );
  if (!partition.startsWith(PREVIEW_PARTITION_PREFIX)) {
    return { allow: false };
  }
  wp.partition = partition;
  wp.preload = require("node:path").join(__dirname, "preview-webmcp-preload.js");
  return { allow: true };
}

/**
 * Deny window.open; send disallowed http(s) to the OS browser.
 * @param {object} wc
 */
function attachGuestPolicy(wc) {
  if (!wc || policyAttached.has(wc)) return;
  policyAttached.add(wc);
  // This partition belongs to one guest; keep response policy outside the page.
  wc.session?.webRequest?.onHeadersReceived?.((details, callback) => {
    if (details.resourceType === "mainFrame" && details.webContentsId === wc.id) {
      webMcpPolicies.set(wc, {
        url: String(details.url).split("#")[0],
        allowed: webMcpHeadersAllowed(details.responseHeaders),
      });
    }
    callback({});
  });
  wc.on?.("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) webMcpPolicies.delete(wc);
  });
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

const TIMED_OUT = Symbol("timed out");

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip credentials, query values and the fragment: diagnostics keep where
 * a request went, never the secrets riding along with it.
 * @param {unknown} raw
 */
function redactUrl(raw) {
  const text = String(raw || "");
  let u;
  try {
    u = new URL(text);
  } catch {
    return text.split(/[?#]/)[0].slice(0, MAX_TEXT);
  }
  u.username = "";
  u.password = "";
  u.hash = "";
  for (const key of new Set(u.searchParams.keys())) {
    u.searchParams.set(key, "redacted");
  }
  return u.toString().slice(0, MAX_TEXT);
}

/** Console text can quote URLs too; drop their userinfo and query strings. */
function redactText(raw) {
  return String(raw || "")
    .replace(/(\w+:\/\/)[^\s/@"'`]*@/g, "$1")
    .replace(/(\w+:\/\/[^\s?#"'`]*)[?#][^\s"'`]*/g, "$1?…")
    .slice(0, MAX_TEXT);
}

/**
 * Subscribe the console / navigation / network listeners for one bound
 * guest. Everything is undone by the returned session's detach().
 * @param {string} threadId
 * @param {any} wc
 * @param {number} webContentsId
 * @returns {Session}
 */
function attachSession(threadId, wc, webContentsId) {
  /** @type {Session} */
  const s = {
    webContentsId,
    docGeneration: 0,
    snapshotSeq: 0,
    snapshot: null,
    webmcp: { refs: new Set(), pending: new Map() },
    console: [],
    network: [],
    dropped: { console: 0, network: 0 },
    seq: 0,
    emulation: null,
    natural: null,
    audible: typeof wc.isCurrentlyAudible === "function" ? Boolean(wc.isCurrentlyAudible()) : false,
    muted: typeof wc.isAudioMuted === "function" ? Boolean(wc.isAudioMuted()) : false,
    original: null,
    detach: () => {},
  };
  const push = (/** @type {"console" | "network"} */ kind, cap, entry) => {
    const list = s[kind];
    list.push({ seq: ++s.seq, at: Date.now(), doc: s.docGeneration, ...entry });
    if (list.length > cap) {
      list.shift();
      s.dropped[kind] += 1;
    }
  };

  // Electron 35 puts these on the event; older builds pass them positionally.
  const onConsole = (event, ...pos) => {
    const e = event || {};
    const level =
      typeof e.level === "string" ? e.level : CONSOLE_LEVELS[Number(pos[0])] || "info";
    const source = String(e.sourceId ?? pos[3] ?? "");
    // Electron's own dev-mode security banner is not page evidence.
    if (level === "debug" || level === "verbose" || source.startsWith("node:electron")) {
      return;
    }
    push("console", CONSOLE_RING, {
      level,
      text: redactText(e.message ?? pos[1]),
      source: source ? `${redactUrl(source)}:${Number(e.lineNumber ?? pos[2]) || 0}` : "",
    });
  };
  const onNavigate = () => {
    clearWebMcp(s, wc);
    s.docGeneration += 1;
  };
  const onStart = (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) onNavigate();
  };
  const onInPage = (_event, _url, isMainFrame) => {
    const main = _event && typeof _event.isMainFrame === "boolean" ? _event.isMainFrame : isMainFrame;
    if (main !== false) {
      clearWebMcp(s, wc);
      s.docGeneration += 1;
      void runInGuest(wc, inspectScript(true)).catch(() => {});
    }
  };
  const onDestroyed = () => {
    if (sessions.get(threadId) === s) sessions.delete(threadId);
    s.detach();
  };

  const started = new Map();
  const own = (d) => d && (d.webContentsId == null || d.webContentsId === webContentsId);
  const onSend = (d) => {
    if (!own(d)) return;
    started.set(d.id, d.timestamp);
    if (started.size > 500) started.delete(started.keys().next().value);
  };
  const finish = (d, failure) => {
    if (!own(d)) return;
    const t0 = started.get(d.id);
    started.delete(d.id);
    const status = Number(d.statusCode) || 0;
    if (!failure && status < 400 && !NETWORK_KEEP_TYPES.has(d.resourceType)) return;
    push("network", NETWORK_RING, {
      method: String(d.method || "GET"),
      url: redactUrl(d.url),
      type: String(d.resourceType || "other"),
      ...(status ? { status } : {}),
      ...(failure ? { error: String(failure) } : {}),
      durationMs:
        t0 != null && Number(d.timestamp) ? Math.max(0, Math.round(d.timestamp - t0)) : null,
      ...(d.fromCache ? { fromCache: true } : {}),
    });
  };

  if (typeof wc.on === "function") {
    wc.on("console-message", onConsole);
    wc.on("did-navigate", onNavigate);
    wc.on("did-start-navigation", onStart);
    wc.on("did-navigate-in-page", onInPage);
  }
  if (typeof wc.once === "function") wc.once("destroyed", onDestroyed);
  // The partition (one per thread) owns this webRequest, and Electron keeps
  // one listener per event, so a rebind replaces rather than stacks.
  const web = wc.session && wc.session.webRequest;
  if (web) {
    web.onSendHeaders(onSend);
    web.onCompleted((d) => finish(d, null));
    web.onErrorOccurred((d) => finish(d, d.error || "failed"));
  }
  const audioOff = attachAudio(threadId, wc, s);

  s.detach = () => {
    s.detach = () => {};
    audioOff();
    clearWebMcp(s, wc);
    try { void runInGuest(wc, inspectScript(true)).catch(() => {}); } catch { /* guest already gone */ }
    if (typeof wc.removeListener === "function") {
      wc.removeListener("console-message", onConsole);
      wc.removeListener("did-navigate", onNavigate);
      wc.removeListener("did-start-navigation", onStart);
      wc.removeListener("did-navigate-in-page", onInPage);
      wc.removeListener("destroyed", onDestroyed);
    }
    if (web) {
      try {
        web.onSendHeaders(null);
        web.onCompleted(null);
        web.onErrorOccurred(null);
      } catch {
        // session already gone
      }
    }
    if (s.emulation) {
      s.emulation = null;
      try {
        if (!(wc.isDestroyed && wc.isDestroyed())) wc.disableDeviceEmulation();
      } catch {
        // guest already gone
      }
    }
    s.console.length = 0;
    s.network.length = 0;
    started.clear();
    keepOriginal(s, null);
  };
  return s;
}

function notifyAudio(threadId, s) {
  audioPush(threadId, { audible: s.audible, muted: s.muted });
}

/**
 * Sidebar audio indicator (#1807). Electron >=27 emits `audio-state-changed`
 * on the guest webContents whenever media starts or stops playing; a host
 * that cannot deliver that event (older Electron, a test double without
 * `.on`) falls back to polling isCurrentlyAudible(). Pushes once immediately
 * so a rebind mid-playback (pane reopened) reports the current state right
 * away rather than waiting for the next change.
 * @param {string} threadId
 * @param {any} wc
 * @param {Session} s
 * @returns {() => void} detach
 */
function attachAudio(threadId, wc, s) {
  const hasEvents = typeof wc.on === "function";
  const onAudioState = (_event, audible) => {
    s.audible = Boolean(audible);
    notifyAudio(threadId, s);
  };
  if (hasEvents) wc.on("audio-state-changed", onAudioState);
  let pollTimer = null;
  if (!hasEvents && typeof wc.isCurrentlyAudible === "function") {
    pollTimer = setInterval(() => {
      const next = Boolean(wc.isCurrentlyAudible());
      if (next !== s.audible) {
        s.audible = next;
        notifyAudio(threadId, s);
      }
    }, AUDIO_POLL_MS);
  }
  notifyAudio(threadId, s);
  return () => {
    if (hasEvents && typeof wc.removeListener === "function") {
      wc.removeListener("audio-state-changed", onAudioState);
    }
    if (pollTimer) clearInterval(pollTimer);
  };
}

function requireSession(threadId) {
  const s = sessions.get(threadId);
  if (!s) throw new Error(PANE_CLOSED);
  const wc = lookupWebContents(s.webContentsId);
  if (!wc) {
    sessions.delete(threadId);
    s.detach();
    throw new Error(PANE_CLOSED);
  }
  return { s, wc };
}

function requireBound(threadId) {
  return requireSession(threadId).wc;
}

function navState(wc) {
  return {
    url: typeof wc.getURL === "function" ? String(wc.getURL() || "") : "",
    title: typeof wc.getTitle === "function" ? String(wc.getTitle() || "") : "",
    canGoBack: Boolean(wc.canGoBack && wc.canGoBack()),
    canGoForward: Boolean(wc.canGoForward && wc.canGoForward()),
  };
}

function encodeImage(image, maxWidth = MAX_SHOT_WIDTH, maxHeight = Infinity) {
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
  const size = typeof img.getSize === "function" ? img.getSize() : null;
  if (typeof img.toDataURL === "function") {
    const url = img.toDataURL();
    if (typeof url === "string" && url.startsWith("data:image/")) {
      return { dataUrl: url, size };
    }
  }
  if (typeof img.toPNG === "function") {
    const buf = img.toPNG();
    if (Buffer.isBuffer(buf) && buf.length) {
      return { dataUrl: `data:image/png;base64,${buf.toString("base64")}`, size };
    }
  }
  throw new Error("Screenshot failed");
}

/**
 * Run one of the fixed page functions below in the isolated world. Only
 * JSON arguments cross over; there is no caller-supplied code path.
 */
function pageCall(wc, fn, arg) {
  if (typeof wc.executeJavaScriptInIsolatedWorld !== "function") {
    return Promise.reject(new Error("The preview cannot inspect this page"));
  }
  return wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
    { code: `(${fn.toString()})(${JSON.stringify(arg ?? null)})` },
  ]);
}

/** @returns {Promise<{ width: number, height: number, devicePixelRatio: number } | null>} */
async function measureViewport(wc) {
  try {
    const v = await withTimeout(pageCall(wc, pageViewport), 1000);
    return v === TIMED_OUT ? null : v;
  } catch {
    return null;
  }
}

function viewportInfo(s, measured) {
  const e = s.emulation;
  return {
    preset: e ? e.preset : "fill",
    ...(measured || {}),
    ...(e && e.scale !== 1 ? { displayScale: e.scale } : {}),
  };
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
  attachGuestPolicy(wc);
  const current = sessions.get(threadId);
  if (current && current.webContentsId === webContentsId) return navState(wc);
  if (current) current.detach();
  sessions.set(threadId, attachSession(threadId, wc, webContentsId));
  return navState(wc);
}

/**
 * @param {{ threadId?: string, webContentsId?: number }} input
 */
function unbind(input) {
  const threadId = threadIdOf(input);
  const current = sessions.get(threadId);
  const specified = Number(input && input.webContentsId);
  if (current == null) return { ok: true };
  if (
    Number.isInteger(specified) &&
    specified > 0 &&
    specified !== current.webContentsId
  ) {
    return { ok: true };
  }
  sessions.delete(threadId);
  current.detach();
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
  return navState(wc);
}

/**
 * @param {{ threadId?: string }} input
 */
async function reload(input) {
  const wc = requireBound(threadIdOf(input));
  if (typeof wc.reload === "function") wc.reload();
  return navState(wc);
}

/**
 * @param {{ threadId?: string }} input
 */
async function goBack(input) {
  const wc = requireBound(threadIdOf(input));
  if (wc.canGoBack && wc.canGoBack() && typeof wc.goBack === "function") {
    wc.goBack();
  }
  return navState(wc);
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
  return navState(wc);
}

/**
 * @param {{ threadId?: string }} input
 */
async function info(input) {
  const { s, wc } = requireSession(threadIdOf(input));
  return { ...navState(wc), viewportPreset: s.emulation ? s.emulation.preset : "fill" };
}

function keepOriginal(s, image) {
  if (s.original) clearTimeout(s.original.timer);
  s.original = null;
  if (!image) return;
  const timer = setTimeout(() => {
    if (s.original && s.original.timer === timer) s.original = null;
  }, ORIGINAL_TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
  s.original = { image, timer };
}

/**
 * The PNG carries the viewport it was taken at: CSS size and DPR measured
 * in the page, plus the image's own pixel size.
 * @param {{ threadId?: string }} input
 */
async function screenshot(input) {
  const { s, wc } = requireSession(threadIdOf(input));
  if (typeof wc.capturePage !== "function") {
    throw new Error("Screenshot failed");
  }
  const e = s.emulation;
  // Under a preset the page is drawn at displayScale in the pane's top-left
  // corner; capture exactly that rectangle, not the blank pane around it.
  const image = await (e
    ? wc.capturePage({
        x: 0,
        y: 0,
        width: Math.round(e.width * e.scale),
        height: Math.round(e.height * e.scale),
      })
    : wc.capturePage());
  const shot = encodeImage(image);
  keepOriginal(s, image);
  return {
    dataUrl: shot.dataUrl,
    ...navState(wc),
    viewport: viewportInfo(s, await measureViewport(wc)),
    ...(shot.size ? { image: { width: shot.size.width, height: shot.size.height } } : {}),
  };
}

/**
 * Full-resolution PNG of the latest screenshot, for the user's Save button
 * only (#1940). The agent tool never calls this.
 * @param {{ threadId?: string }} input
 */
async function originalScreenshot(input) {
  const { s } = requireSession(threadIdOf(input));
  if (!s.original) throw new Error(NO_ORIGINAL);
  const shot = encodeImage(s.original.image, Infinity, Infinity);
  return {
    dataUrl: shot.dataUrl,
    ...(shot.size ? { image: { width: shot.size.width, height: shot.size.height } } : {}),
  };
}

/**
 * Bounded, read-only semantic snapshot. Its refs act only on this exact
 * document: a later snapshot or any navigation makes them stale.
 * @param {{ threadId?: string }} input
 */
async function snapshot(input) {
  const { s, wc } = requireSession(threadIdOf(input));
  // did-navigate can reach main after the new document already answered
  // (seen on macOS CI right after navigate). Reading is safe to repeat, so
  // retry once; a page that keeps navigating is still refused.
  for (let attempt = 0; ; attempt++) {
    const id = ++s.snapshotSeq;
    const docGeneration = s.docGeneration;
    const page = await withTimeout(
      pageCall(wc, pageSnapshot, { snapshotId: id, ...SNAPSHOT_LIMITS }),
      READ_TIMEOUT_MS,
    );
    if (page === TIMED_OUT) {
      throw new Error(
        `The page did not answer within ${READ_TIMEOUT_MS / 1000}s; a dialog or busy script may be blocking it. Take a screenshot to see it.`,
      );
    }
    if (s.docGeneration !== docGeneration) {
      if (attempt === 0) continue;
      throw new Error("The page navigated during the snapshot. Take a new snapshot.");
    }
    return snapshotResult(s, wc, id, docGeneration, page);
  }
}

function snapshotResult(s, wc, id, docGeneration, page) {
  s.snapshot = { id, docGeneration };
  return {
    ...navState(wc),
    snapshotId: id,
    documentGeneration: docGeneration,
    viewport: viewportInfo(s, page.viewport),
    nodes: page.nodes,
    truncated: page.truncated,
    limits: {
      maxNodes: SNAPSHOT_LIMITS.maxNodes,
      maxDepth: SNAPSHOT_LIMITS.maxDepth,
      maxBytes: SNAPSHOT_LIMITS.maxBytes,
    },
  };
}

/**
 * Console messages and request outcomes since bind, oldest first. Network
 * rows carry method, redacted URL, status, error and timing; never headers
 * or bodies.
 * @param {{ threadId?: string }} input
 */
async function diagnostics(input) {
  const { s, wc } = requireSession(threadIdOf(input));
  return {
    ...navState(wc),
    viewportPreset: s.emulation ? s.emulation.preset : "fill",
    documentGeneration: s.docGeneration,
    console: s.console.slice(),
    network: s.network.slice(),
    dropped: { ...s.dropped },
  };
}

/**
 * Explicit viewport presets via device emulation. A preset larger than the
 * pane is drawn scaled down to fit; the page still lays out at full size.
 * @param {{ threadId?: string, preset?: string }} input
 */
async function viewport(input) {
  const { s, wc } = requireSession(threadIdOf(input));
  const preset = String((input && input.preset) || "");
  let expectedWidth = null;
  if (preset === "fill") {
    if (s.emulation && typeof wc.disableDeviceEmulation === "function") {
      wc.disableDeviceEmulation();
    }
    s.emulation = null;
    expectedWidth = s.natural ? s.natural.width : null;
  } else {
    if (!Object.hasOwn(VIEWPORTS, preset)) {
      throw new Error("Unknown viewport preset. Use mobile, tablet, desktop, or fill.");
    }
    const size = VIEWPORTS[/** @type {keyof typeof VIEWPORTS} */ (preset)];
    if (typeof wc.enableDeviceEmulation !== "function") {
      throw new Error("Viewport presets are not available");
    }
    if (!s.emulation) s.natural = await measureViewport(wc);
    const nat = s.natural;
    // ponytail: scale is fixed when the preset is applied; a pane resized
    // afterwards keeps it until a preset is applied again.
    const scale =
      nat && nat.width > 0 && nat.height > 0
        ? Math.min(1, nat.width / size.width, nat.height / size.height)
        : 1;
    wc.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: size,
      viewSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      scale,
    });
    s.emulation = { preset, ...size, scale };
    expectedWidth = size.width;
  }
  // Emulation reaches the guest renderer asynchronously; report what the
  // page measures, not what was requested.
  let measured = await measureViewport(wc);
  for (let i = 0; i < 20 && measured && expectedWidth != null && measured.width !== expectedWidth; i++) {
    await sleep(50);
    measured = await measureViewport(wc);
  }
  return { ...navState(wc), viewport: viewportInfo(s, measured) };
}

function parseRef(s, ref) {
  const raw = String(ref || "").trim();
  const m = /^s(\d+)e(\d+)$/.exec(raw);
  if (!m) {
    throw new Error(`Unknown ref "${raw}". Use a ref from the latest snapshot, like s3e12.`);
  }
  const snapshotId = Number(m[1]);
  if (
    !s.snapshot ||
    s.snapshot.id !== snapshotId ||
    s.snapshot.docGeneration !== s.docGeneration
  ) {
    throw new Error(
      `Ref ${raw} is stale: the page changed or a newer snapshot replaced it. Take a new snapshot and use its refs.`,
    );
  }
  return { snapshotId, index: Number(m[2]) };
}

/**
 * click / type by CSS selector (kept for compatibility) or snapshot ref.
 * A page that does not answer in time (an alert, a busy loop) yields
 * completion "uncertain": the action may have run, so observe before
 * retrying anything that mutates.
 * @param {{ threadId?: string, selector?: string, ref?: string, text?: string }} input
 * @param {"click" | "type"} kind
 */
async function act(input, kind) {
  const { s, wc } = requireSession(threadIdOf(input));
  const selector = String((input && input.selector) || "").trim();
  const ref = String((input && input.ref) || "").trim();
  if (!selector && !ref) throw new Error("selector or ref is required");
  if (selector && ref) throw new Error("Pass selector or ref, not both");
  const target = ref ? parseRef(s, ref) : { selector };
  const result = await withTimeout(
    pageCall(wc, pageAction, {
      ...target,
      kind,
      text: kind === "type" ? String((input && input.text) ?? "") : null,
    }),
    ACTION_TIMEOUT_MS,
  );
  if (result === TIMED_OUT) {
    return {
      ...navState(wc),
      ok: false,
      completion: "uncertain",
      message:
        `No answer from the page within ${ACTION_TIMEOUT_MS / 1000}s, so the ${kind} may or may not have happened ` +
        "(a dialog or busy script can block the page). Take a snapshot or screenshot before retrying.",
    };
  }
  if (!result || result.ok !== true) {
    throw new Error((result && result.reason) || `${kind === "click" ? "Click" : "Type"} failed`);
  }
  return { ...navState(wc), ...result, completion: "done" };
}

/**
 * @param {{ threadId?: string, selector?: string, ref?: string }} input
 */
function click(input) {
  return act(input, "click");
}

/**
 * @param {{ threadId?: string, selector?: string, ref?: string, text?: string }} input
 */
function type(input) {
  return act(input, "type");
}

// WebMCP deliberately enters the page's main world: the API and its callbacks
// are page-owned. Only these fixed bridge operations and JSON data cross over.
function webMcpCall(wc, method, args = []) {
  const code = `(() => { const b = globalThis.__solentaWebMcp; return b ? b[${JSON.stringify(method)}](...${JSON.stringify(args)}) : null; })()`;
  return wc.executeJavaScript(code);
}

function clearWebMcp(s, wc) {
  s.webmcp.refs.clear();
  for (const [id, cancel] of s.webmcp.pending) {
    cancel();
    try { void webMcpCall(wc, "cancel", [id]).catch(() => {}); } catch { /* guest gone */ }
  }
  s.webmcp.pending.clear();
}

function webMcpJson(raw, maxBytes, maxDepth = 20) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > maxBytes) throw new Error("Invalid or oversized WebMCP response");
  const result = JSON.parse(raw);
  const checkDepth = (value, depth) => {
    if (depth > maxDepth) throw new Error("WebMCP response is too deep");
    if (value && typeof value === "object") for (const child of Object.values(value)) checkDepth(child, depth + 1);
  };
  checkDepth(result, 0);
  return result;
}

async function webmcpTools(input) {
  const threadId = threadIdOf(input);
  const { s, wc } = requireSession(threadId);
  if (!previewNavigateAction(wc.getURL()).allow) throw new Error("WebMCP requires a local Browser page");
  s.webmcp.refs.clear();
  const generation = s.docGeneration;
  const raw = await withTimeout(webMcpCall(wc, "tools"), READ_TIMEOUT_MS);
  if (raw === TIMED_OUT) throw new Error("WebMCP discovery timed out");
  if (sessions.get(threadId) !== s || generation !== s.docGeneration) throw new Error("WebMCP document changed; discover tools again");
  if (raw === null) return { available: false, tools: [], skipped: 0, untrusted: true };
  const data = webMcpJson(raw, 36_864, 23);
  if (typeof data.documentId !== "string" || data.documentId.length > 128 ||
      typeof data.available !== "boolean" || !Array.isArray(data.tools) || data.tools.length > 128) {
    throw new Error("Invalid WebMCP discovery response");
  }
  const tools = data.tools.map((tool) => {
    if (typeof tool.ref !== "string" || !/^w[A-Za-z0-9-]{1,180}$/.test(tool.ref) ||
        typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
        typeof tool.description !== "string" || Buffer.byteLength(tool.description) > 4096 ||
        !tool.inputSchema || tool.inputSchema.type !== "object" || Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 16_384) {
      throw new Error("Invalid WebMCP tool descriptor");
    }
    return {
      ref: tool.ref, name: tool.name, description: tool.description,
      inputSchema: webMcpJson(JSON.stringify(tool.inputSchema), 16_384),
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint === true,
        consequentialHint: tool.annotations?.consequentialHint === true,
        untrustedContentHint: true,
      },
    };
  });
  s.webmcp.refs = new Set(tools.map((t) => t.ref));
  return { available: data.available, tools, skipped: Math.max(0, Math.min(10000, Number(data.skipped) || 0)), untrusted: true };
}

async function webmcpInvoke(input) {
  const threadId = threadIdOf(input);
  const { s, wc } = requireSession(threadId);
  const ref = input?.ref;
  if (!s.webmcp.refs.has(ref)) throw new Error("WebMCP tool is stale; discover tools again");
  if (!previewNavigateAction(wc.getURL()).allow) throw new Error("WebMCP requires a local Browser page");
  const args = webMcpJson(JSON.stringify(input.arguments ?? {}), 16_384);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("WebMCP arguments must be an object");
  const id = input.invocationId ?? randomUUID();
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid WebMCP invocationId");
  if (s.webmcp.pending.size >= 8 || s.webmcp.pending.has(id)) throw new Error("WebMCP invocation already active or concurrency limit reached");
  const generation = s.docGeneration;
  let cancel;
  const cancelled = new Promise((resolve) => { cancel = () => resolve(TIMED_OUT); });
  s.webmcp.pending.set(id, cancel);
  try {
    const raw = await withTimeout(Promise.race([webMcpCall(wc, "invoke", [ref, args, id]), cancelled]), ACTION_TIMEOUT_MS);
    if (raw === TIMED_OUT || sessions.get(threadId) !== s || generation !== s.docGeneration) {
      s.webmcp.refs.clear();
      void webMcpCall(wc, "cancel", [id]).catch(() => {});
      return { ok: false, completion: "uncertain", invocationId: id, untrusted: true,
        message: "WebMCP call timed out, was cancelled, or its document changed. It may have run; observe the page before retrying." };
    }
    const data = webMcpJson(raw, 65_560, 21);
    return { ok: true, completion: "done", invocationId: id, untrusted: true, result: data.result };
  } catch (error) {
    // Page errors are untrusted and bounded just like successful results.
    return { ok: false, completion: "uncertain", invocationId: id, untrusted: true,
      message: String(error?.message || "WebMCP call failed").slice(0, 500) };
  } finally {
    if (s.webmcp.pending.get(id) === cancel) s.webmcp.pending.delete(id);
  }
}

function webmcpCancel(input) {
  const { s, wc } = requireSession(threadIdOf(input));
  const id = input?.invocationId;
  const cancel = s.webmcp.pending.get(id);
  if (cancel) {
    s.webmcp.refs.clear();
    cancel();
    void webMcpCall(wc, "cancel", [id]).catch(() => {});
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Page functions. These are serialized with toString() and run inside the
// guest's isolated world, so they must not reference anything outside
// themselves.

function pageViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
}

/** @param {{ snapshotId: number, maxNodes: number, maxDepth: number, maxBytes: number, maxName: number }} opts */
function pageSnapshot(opts) {
  const INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button",
    file: "button", checkbox: "checkbox", radio: "radio", range: "slider",
    number: "spinbutton", search: "searchbox",
  };
  const TAG_ROLES = {
    BUTTON: "button", TEXTAREA: "textbox", SUMMARY: "button", DIALOG: "dialog",
    NAV: "navigation", MAIN: "main", FORM: "form", H1: "heading", H2: "heading",
    H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    OPTION: "option", PROGRESS: "progressbar", METER: "meter",
  };
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "treeitem", "alert", "status", "tooltip", "cell",
  ]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "svg"]);
  const clip = (v, n = opts.maxName) => {
    const t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit && !["presentation", "none", "generic"].includes(explicit)) return explicit;
    const tag = el.tagName;
    if (tag === "A" || tag === "AREA") return el.hasAttribute("href") ? "link" : "";
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "hidden") return "";
      return INPUT_ROLES[t] || "textbox";
    }
    if (tag === "SELECT") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "IMG") return el.getAttribute("alt") ? "img" : "";
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) {
      return "textbox";
    }
    return TAG_ROLES[tag] || "";
  };
  const nameOf = (el, role) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? n.textContent : "";
        })
        .join(" ");
      if (t.trim()) return clip(t);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clip(aria);
    if (el.labels && el.labels.length) {
      return clip(Array.from(el.labels, (l) => l.innerText || l.textContent).join(" "));
    }
    if (el.tagName === "IMG") return clip(el.getAttribute("alt"));
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type)) {
      return clip(el.value || el.type);
    }
    if (NAME_FROM_CONTENT.has(role)) return clip(el.innerText || el.textContent);
    return clip(el.getAttribute("placeholder") || el.getAttribute("title") || "");
  };
  const describe = (el, role, depth, ref) => {
    /** @type {Record<string, unknown>} */
    const n = { ref, role, name: nameOf(el, role) };
    if (depth) n.depth = depth;
    if (role === "heading") {
      n.level = Number(el.getAttribute("aria-level")) || Number(el.tagName.slice(1)) || undefined;
    }
    const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    if (isField && !["button", "checkbox", "radio"].includes(role)) {
      // Password values never leave the page; the agent only learns if it is filled.
      if (el.type === "password") n.filled = Boolean(el.value);
      else n.value = clip(el.value, opts.maxName);
    }
    const aria = (k) => el.getAttribute(`aria-${k}`);
    if (el.disabled || aria("disabled") === "true") n.disabled = true;
    if (el.checked === true || aria("checked") === "true") n.checked = true;
    if (aria("checked") === "mixed" || el.indeterminate === true) n.checked = "mixed";
    if (aria("expanded")) n.expanded = aria("expanded") === "true";
    if ((el.tagName === "OPTION" && el.selected) || aria("selected") === "true") n.selected = true;
    if (el.required || aria("required") === "true") n.required = true;
    if (el.readOnly === true || aria("readonly") === "true") n.readonly = true;
    const invalid = (el.willValidate && el.validity && !el.validity.valid) || aria("invalid") === "true";
    if (invalid) {
      n.invalid = true;
      if (el.validationMessage) n.validationMessage = clip(el.validationMessage, 160);
    }
    if (el === document.activeElement) n.focused = true;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
      n.offscreen = true;
    }
    return n;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return typeof el.checkVisibility !== "function" ||
      el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  };

  const els = [];
  const nodes = [];
  const truncated = {};
  let bytes = 0;
  const walk = (root, domDepth, depth) => {
    for (let el = root.firstElementChild; el; el = el.nextElementSibling) {
      if (truncated.nodes || truncated.bytes) return;
      if (SKIP.has(el.tagName) || el.hidden || el.getAttribute("aria-hidden") === "true") continue;
      // display:none subtrees cannot hold anything visible.
      if (typeof el.checkVisibility === "function" && !el.checkVisibility()) continue;
      let next = depth;
      const role = roleOf(el);
      if (role && shown(el)) {
        if (nodes.length >= opts.maxNodes) {
          truncated.nodes = true;
          return;
        }
        const node = describe(el, role, depth, `s${opts.snapshotId}e${els.length}`);
        const size = JSON.stringify(node).length + 1;
        if (bytes + size > opts.maxBytes) {
          truncated.bytes = true;
          return;
        }
        bytes += size;
        els.push(el);
        nodes.push(node);
        next += 1;
      }
      if (domDepth + 1 >= opts.maxDepth) {
        if (el.firstElementChild || el.shadowRoot) truncated.depth = true;
        continue;
      }
      walk(el, domDepth + 1, next);
      if (el.shadowRoot) walk(el.shadowRoot, domDepth + 1, next);
    }
  };
  if (document.body) walk(document.body, 0, 0);
  globalThis.__solentaSnapshot = { id: opts.snapshotId, els };
  return {
    nodes,
    truncated: Object.keys(truncated).length ? truncated : null,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
  };
}

/** @param {{ selector?: string, snapshotId?: number, index?: number, kind: string, text: string | null }} input */
function pageAction(input) {
  let el;
  if (input.selector != null) {
    el = document.querySelector(input.selector);
    if (!el) return { ok: false, reason: "No element matches selector" };
  } else {
    const st = globalThis.__solentaSnapshot;
    el = st && st.id === input.snapshotId ? st.els[input.index] : null;
    if (!el || !el.isConnected) {
      return {
        ok: false,
        reason: `Ref s${input.snapshotId}e${input.index} is stale: that element is gone from the page. Take a new snapshot.`,
      };
    }
  }
  if (input.kind === "click") {
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return {
      ok: true,
      tag: el.tagName,
      text: String(el.innerText || el.value || "").slice(0, 80),
    };
  }
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype
    : null;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
  if (!(desc && desc.set) && !el.isContentEditable) {
    return { ok: false, reason: `Cannot type into <${el.tagName.toLowerCase()}>` };
  }
  el.focus();
  // The prototype setter, so frameworks that shadow `value` (React) see a change.
  if (desc && desc.set) desc.set.call(el, input.text);
  else el.textContent = input.text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, tag: el.tagName };
}

/**
 * Element inspector (#1193). Runs INSIDE the guest page, in an isolated
 * world so page scripts cannot read or patch it. Stringified, so it must not
 * close over anything. Resolves once with { cancelled } or the picked
 * element's description. With a session identity, subsequent calls keep the
 * blocker and captured element references alive. Every page activation event is swallowed while
 * picking, so selecting a submit button does not submit its form.
 * @param {{ cancel?: boolean, htmlCap: number, textCap: number }} opts
 */
function guestInspect(opts) {
  const KEY = "__solentaInspect";
  const pending = window[KEY];
  if (opts.markers) {
    if (pending && pending.sessionId === opts.sessionId) pending.markers(opts.markers);
    return { ok: true };
  }
  if (pending && opts.sessionId && pending.sessionId === opts.sessionId && !opts.cancel) {
    return pending.next(opts.annotationId);
  }
  if (opts.cancel && opts.sessionId && pending && pending.sessionId !== opts.sessionId) return { cancelled: true };
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

    let resolvePick = resolve;
    let annotationId = opts.annotationId;
    const markers = new Map();
    let paint = null;
    const redraw = () => {
      paint = null;
      // Read all bounds before writing marker styles.
      const rows = Array.from(markers.values(), (m) => ({ m, rect: m.el.isConnected ? m.el.getBoundingClientRect() : null }));
      for (const { m, rect } of rows) {
        m.badge.style.display = m.committed && rect && rect.width && rect.height ? "block" : "none";
        if (rect) Object.assign(m.badge.style, { left: `${Math.max(0, rect.left)}px`, top: `${Math.max(0, rect.top)}px` });
      }
    };
    const scheduleDraw = () => { paint ??= requestAnimationFrame(redraw); };
    const observer = new MutationObserver(scheduleDraw);
    if (opts.sessionId) {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      window.addEventListener("scroll", scheduleDraw, true);
      window.addEventListener("resize", scheduleDraw);
    }

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
      if (e.isTrusted && e.type === "click" && e.button === 0 && pickable(e.target)) select(e.target);
    };
    const onMove = (e) => {
      if (e.isTrusted && e.target !== current) highlight(e.target);
    };
    const onFocus = (e) => highlight(e.target);
    const onKeyDown = (e) => {
      if (e.key === "Tab") return;
      swallow(e);
      if (!e.isTrusted) return;
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
      observer.disconnect();
      window.removeEventListener("scroll", scheduleDraw, true);
      window.removeEventListener("resize", scheduleDraw);
      if (paint !== null) cancelAnimationFrame(paint);
      host.remove();
      markers.clear();
      current = null;
      // Keep a stopped session tombstone so an in-flight crop cannot restart it.
      if (window[KEY] === state && !opts.sessionId) delete window[KEY];
      // Two frames so the overlay is gone before main captures the crop.
      const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      const settle = resolvePick;
      resolvePick = null;
      raf(() => raf(() => settle?.(result)));
    }
    function select(el) {
      if (!resolvePick) return;
      if (opts.sessionId && markers.size >= 100) return finish({ cancelled: true });
      let result;
      try {
        result = describe(el);
      } catch (err) {
        result = { cancelled: true, error: String((err && err.message) || err) };
      }
      if (!opts.sessionId || result.cancelled) return finish(result);
      const marker = document.createElement("div");
      marker.style.cssText = "position:fixed;pointer-events:none;border-radius:50%;background:#2563eb;color:white;font:600 12px/22px system-ui;text-align:center;min-width:22px;box-shadow:0 0 0 2px white";
      root.append(marker);
      markers.set(annotationId, { el, badge: marker, committed: false });
      const settle = resolvePick;
      resolvePick = null;
      host.style.visibility = "hidden";
      const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
      raf(() => raf(() => settle(result)));
    }
    const state = {
      finish, sessionId: opts.sessionId,
      next(id) {
        if (done) return { cancelled: true };
        resolvePick?.({ cancelled: true });
        annotationId = id;
        host.style.visibility = "visible";
        box.style.display = badge.style.display = "none";
        scheduleDraw();
        return new Promise((next) => { resolvePick = next; });
      },
      markers(rows) {
        if (done) return;
        const wanted = new Map(rows.map((row) => [row.id, row.number]));
        for (const [id, marker] of markers) {
          if (!wanted.has(id) && marker.committed) { marker.badge.remove(); markers.delete(id); }
          else if (wanted.has(id)) { marker.committed = true; marker.badge.textContent = String(wanted.get(id)); }
        }
        scheduleDraw();
      },
    };
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

function inspectScript(cancel, session = {}) {
  const opts = { ...session, cancel, htmlCap: INSPECT_HTML_CAP, textCap: INSPECT_TEXT_CAP };
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
 * @param {{ threadId?: string, sessionId?: string, annotationId?: string }} input
 */
async function inspect(input) {
  const threadId = threadIdOf(input);
  const { s, wc } = requireSession(threadId);
  const generation = s.docGeneration;
  const sessionId = input && input.sessionId;
  const annotationId = input && input.annotationId;
  if (sessionId != null || annotationId != null) {
    if (!inspectId(sessionId) || !inspectId(annotationId)) throw new Error("Invalid annotation identity");
    if (typeof wc.executeJavaScriptInIsolatedWorld !== "function") throw new Error("Annotations need an isolated preview");
  }
  const current = () => sessions.get(threadId) === s && s.docGeneration === generation
    && !(wc.isDestroyed && wc.isDestroyed()) && navState(wc).url === pageUrl;
  if (typeof wc.executeJavaScript !== "function") {
    throw new Error("Inspect is not available");
  }
  const initialSnapshot = navState(wc);
  const pageUrl = initialSnapshot.url;
  if (!pageUrl || pageUrl === "about:blank") {
    throw new Error("Load a page before inspecting");
  }
  const raw = await untilPageLeaves(wc, runInGuest(wc, inspectScript(false, { sessionId, annotationId })));
  if (!raw || raw.cancelled || !current()) {
    return { cancelled: true, ...initialSnapshot };
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
      crop = encodeImage(await wc.capturePage(rect), MAX_CROP_EDGE, MAX_CROP_EDGE).dataUrl;
    } catch (err) {
      cropNote = `Crop failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (!current()) return { cancelled: true, ...initialSnapshot };
  return {
    cancelled: false,
    ...navState(wc),
    url: pageUrl,
    capturedAt: Date.now(),
    ...(annotationId ? { annotationId } : {}),
    element,
    crop,
    cropRect: rect,
    ...(cropNote ? { cropNote } : {}),
  };
}

/**
 * Mute/unmute the bound guest's audio from the sidebar indicator (#1807).
 * Updates the session eagerly and pushes immediately, rather than waiting
 * for the next audio-state-changed tick.
 * @param {{ threadId?: string, muted?: boolean }} input
 */
function setAudioMuted(input) {
  const threadId = threadIdOf(input);
  const { s, wc } = requireSession(threadId);
  const muted = Boolean(input && input.muted);
  if (typeof wc.setAudioMuted === "function") wc.setAudioMuted(muted);
  s.muted = muted;
  notifyAudio(threadId, s);
  return { ok: true, muted };
}

/**
 * @param {{ threadId?: string }} input
 */
async function cancelInspect(input) {
  if (input && input.sessionId != null && !inspectId(input.sessionId)) throw new Error("Invalid annotation identity");
  const wc = requireBound(threadIdOf(input));
  if (typeof wc.executeJavaScript === "function") {
    await runInGuest(wc, inspectScript(true, { sessionId: input && input.sessionId })).catch(() => {});
  }
  return { ok: true };
}

function inspectId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

/** Update only references captured in this live session; never resolve selectors. */
async function annotations(input) {
  const wc = requireBound(threadIdOf(input));
  if (typeof wc.executeJavaScriptInIsolatedWorld !== "function") throw new Error("Annotations need an isolated preview");
  if (!inspectId(input.sessionId) || !Array.isArray(input.markers) || input.markers.length > 100) {
    throw new Error("Invalid annotations");
  }
  const markers = input.markers.map((row) => {
    if (!row || !inspectId(row.id) || !Number.isInteger(row.number) || row.number < 1 || row.number > 100) {
      throw new Error("Invalid annotation marker");
    }
    return { id: row.id, number: row.number };
  });
  await runInGuest(wc, inspectScript(false, { sessionId: input.sessionId, markers }));
  return { ok: true };
}

module.exports = {
  PREVIEW_PARTITION_PREFIX,
  PANE_CLOSED,
  ACTION_TIMEOUT_MS,
  VIEWPORTS,
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
  originalScreenshot,
  snapshot,
  diagnostics,
  viewport,
  click,
  type,
  webmcpTools,
  webmcpInvoke,
  webmcpCancel,
  webMcpHeadersAllowed,
  webMcpPolicyAllowed,
  redactUrl,
  inspect,
  cancelInspect,
  annotations,
  inspectScript,
  cropRect,
  setAudioMuted,
  setWebContentsLookup,
  setOpenExternal,
  setAudioPush,
  resetForTests,
};
