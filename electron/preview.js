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
 */

const { previewNavigateAction } = require("./links.js");

const PREVIEW_PARTITION_PREFIX = "solenta-preview:";
const PANE_CLOSED =
  "Browser pane is not open on this thread. Open Views → Browser, then retry.";
const MAX_SHOT_WIDTH = 1600;
const INITIAL_LOAD_WAIT_MS = 2000;
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
 *   console: object[],
 *   network: object[],
 *   dropped: { console: number, network: number },
 *   seq: number,
 *   emulation: { preset: string, width: number, height: number, scale: number } | null,
 *   natural: { width: number, height: number } | null,
 *   detach: () => void,
 * }} Session
 */

/** @type {Map<string, Session>} threadId → bound guest */
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
  for (const s of sessions.values()) s.detach();
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
    console: [],
    network: [],
    dropped: { console: 0, network: 0 },
    seq: 0,
    emulation: null,
    natural: null,
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
    s.docGeneration += 1;
  };
  const onInPage = (_event, _url, isMainFrame) => {
    if (isMainFrame !== false) s.docGeneration += 1;
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

  s.detach = () => {
    s.detach = () => {};
    if (typeof wc.removeListener === "function") {
      wc.removeListener("console-message", onConsole);
      wc.removeListener("did-navigate", onNavigate);
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
  };
  return s;
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

function encodeImage(image) {
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
  return {
    dataUrl: shot.dataUrl,
    ...navState(wc),
    viewport: viewportInfo(s, await measureViewport(wc)),
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
    throw new Error("The page navigated during the snapshot. Take a new snapshot.");
  }
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
  snapshot,
  diagnostics,
  viewport,
  click,
  type,
  redactUrl,
  setWebContentsLookup,
  setOpenExternal,
  resetForTests,
};
