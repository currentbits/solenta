"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const preview = require("../preview.js");

function fakeImage(over = {}) {
  const width = over.width ?? 800;
  return {
    isEmpty: () => over.empty === true,
    getSize: () => ({ width, height: 600 }),
    resize: ({ width: w }) => fakeImage({ ...over, width: w, resized: true }),
    toDataURL: () => over.dataUrl ?? "data:image/png;base64,aaa",
    toPNG: () => Buffer.from("png"),
  };
}

function fakeWebContents(over = {}) {
  const state = {
    url: over.url ?? "about:blank",
    title: over.title ?? "",
    destroyed: false,
    canBack: over.canBack === true,
    canForward: over.canForward === true,
    loads: [],
    scripts: [],
    handlers: {},
    ...over,
  };
  const wc = {
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    getTitle: () => state.title,
    canGoBack: () => state.canBack,
    canGoForward: () => state.canForward,
    loadURL: async (url) => {
      state.loads.push(url);
      state.url = url;
    },
    reload: () => {
      state.reloaded = true;
    },
    goBack: () => {
      state.wentBack = true;
    },
    goForward: () => {
      state.wentForward = true;
    },
    capturePage: async (rect) => {
      state.captures = [...(state.captures || []), rect || null];
      return fakeImage(over.image);
    },
    // Page functions arrive as `(function name(...){...})(<json>)`.
    executeJavaScriptInIsolatedWorld: async (worldId, [{ code }]) => {
      const fn = /^\(function (\w+)/.exec(code)[1];
      const arg = JSON.parse(code.slice(code.lastIndexOf("})(") + 3, -1));
      state.scripts.push({ worldId, fn, arg, code });
      if (typeof over.execute === "function") return over.execute(fn, arg);
      if (fn === "pageViewport") return state.viewport;
      if (fn === "pageSnapshot") {
        return {
          nodes: [{ ref: `s${arg.snapshotId}e0`, role: "button", name: "Save" }],
          truncated: null,
          viewport: state.viewport,
        };
      }
      return { ok: true, tag: "BUTTON", text: "Save" };
    },
    enableDeviceEmulation: (params) => {
      state.emulation = params;
      state.viewport = { ...params.viewSize, devicePixelRatio: 2 };
    },
    disableDeviceEmulation: () => {
      state.emulation = null;
      state.viewport = { width: 800, height: 600, devicePixelRatio: 2 };
    },
    session: { webRequest: {} },
    setWindowOpenHandler: (fn) => {
      state.windowOpen = fn;
    },
    on: (ev, fn) => {
      (state.handlers[ev] ||= []).push(fn);
    },
    once: (ev, fn) => {
      (state.handlers[ev] ||= []).push(fn);
    },
    removeListener: (ev, fn) => {
      state.handlers[ev] = (state.handlers[ev] || []).filter((f) => f !== fn);
    },
    emit: (ev, ...args) => {
      for (const fn of state.handlers[ev] || []) fn(...args);
    },
    _state: state,
  };
  state.viewport ??= { width: 800, height: 600, devicePixelRatio: 2 };
  for (const name of ["onSendHeaders", "onCompleted", "onErrorOccurred"]) {
    wc.session.webRequest[name] = (fn) => {
      state.web = { ...state.web, [name]: fn };
    };
  }
  return wc;
}

const count = (wc, ev) => (wc._state.handlers[ev] || []).length;

describe("preview session (issue #155)", () => {
  beforeEach(() => {
    preview.resetForTests();
  });

  it("names a per-thread partition and refuses a guest without that prefix", () => {
    assert.equal(
      preview.partitionForThread("t1"),
      "solenta-preview:t1",
    );
    assert.throws(() => preview.partitionForThread("../etc"));
    const wp = { preload: "/tmp/evil.js", nodeIntegration: true };
    assert.deepEqual(preview.guestWebviewPolicy(wp, { partition: "persist:x" }), {
      allow: false,
    });
    assert.equal(wp.nodeIntegration, false);
    assert.equal(wp.preload, undefined);
    const ok = { nodeIntegration: true };
    assert.deepEqual(
      preview.guestWebviewPolicy(ok, { partition: "solenta-preview:t1" }),
      { allow: true },
    );
    assert.equal(ok.sandbox, true);
    assert.equal(ok.partition, "solenta-preview:t1");
  });

  it("navigate waits for the guest's initial about:blank load to stop", async () => {
    // Electron resolves an early loadURL on the initial load's
    // did-finish-load, so the snapshot would still say about:blank.
    const wc = fakeWebContents({ url: "" });
    let loading = true;
    wc.isLoading = () => loading;
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });

    const pending = preview.navigate({
      threadId: "t1",
      url: "http://localhost:5173/",
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(wc._state.loads, []);

    loading = false;
    wc.emit("did-stop-loading");
    const nav = await pending;
    assert.deepEqual(wc._state.loads, ["http://localhost:5173/"]);
    assert.equal(nav.url, "http://localhost:5173/");
  });

  it("bind then screenshot / navigate / click / type", async () => {
    const wc = fakeWebContents({ url: "http://localhost:5173/" });
    preview.setWebContentsLookup((id) => (id === 7 ? wc : null));
    preview.bind({ threadId: "t1", webContentsId: 7 });

    const shot = await preview.screenshot({ threadId: "t1" });
    assert.equal(shot.dataUrl.startsWith("data:image/png"), true);
    assert.equal(shot.url, "http://localhost:5173/");

    const nav = await preview.navigate({
      threadId: "t1",
      url: "http://localhost:5173/app",
    });
    assert.equal(nav.url, "http://localhost:5173/app");
    assert.deepEqual(wc._state.loads, ["http://localhost:5173/app"]);

    const actions = () => wc._state.scripts.filter((s) => s.fn === "pageAction");
    const click = await preview.click({ threadId: "t1", selector: "button.save" });
    assert.equal(click.ok, true);
    assert.equal(click.completion, "done");
    assert.equal(actions().length, 1);
    assert.equal(actions()[0].arg.selector, "button.save");

    const typed = await preview.type({
      threadId: "t1",
      selector: "#q",
      text: "hello",
    });
    assert.equal(typed.ok, true);
    assert.equal(actions()[1].arg.text, "hello");
  });

  it("selector and text reach the page only as JSON data, never as code", async () => {
    const wc = fakeWebContents({ url: "http://localhost:5173/" });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    const evil = `"); fetch("http://evil/"); ("`;
    await preview.type({ threadId: "t1", selector: "#q", text: evil });
    const { code, arg } = wc._state.scripts.at(-1);
    assert.equal(arg.text, evil);
    assert.ok(code.endsWith(`)(${JSON.stringify(arg)})`));
    assert.notEqual(wc._state.scripts.at(-1).worldId, 0, "never the page's own world");
  });

  it("rebinding the same guest does not stack listeners; unbind removes them all", () => {
    const wc = fakeWebContents();
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    preview.bind({ threadId: "t1", webContentsId: 7 });
    for (const ev of ["console-message", "did-navigate", "did-navigate-in-page", "destroyed"]) {
      assert.equal(count(wc, ev), 1, ev);
    }
    assert.equal(typeof wc._state.web.onCompleted, "function");

    preview.unbind({ threadId: "t1", webContentsId: 7 });
    for (const ev of ["console-message", "did-navigate", "did-navigate-in-page", "destroyed"]) {
      assert.equal(count(wc, ev), 0, ev);
    }
    assert.deepEqual(wc._state.web, {
      onSendHeaders: null,
      onCompleted: null,
      onErrorOccurred: null,
    });
  });

  it("a new guest for the thread detaches the old one; destroy cleans up", async () => {
    const a = fakeWebContents();
    const b = fakeWebContents();
    preview.setWebContentsLookup((id) => (id === 1 ? a : id === 2 ? b : null));
    preview.bind({ threadId: "t1", webContentsId: 1 });
    preview.bind({ threadId: "t1", webContentsId: 2 });
    assert.equal(count(a, "console-message"), 0);
    assert.equal(count(b, "console-message"), 1);
    // A late unbind for the old guest must not tear down the new one.
    preview.unbind({ threadId: "t1", webContentsId: 1 });
    assert.equal(count(b, "console-message"), 1);

    b.emit("destroyed");
    assert.equal(count(b, "console-message"), 0);
    assert.equal(b._state.web.onCompleted, null);
    await assert.rejects(preview.diagnostics({ threadId: "t1" }), /Browser pane is not open/);
  });

  it("console is a bounded ring without Electron's own banner", async () => {
    const wc = fakeWebContents({ url: "http://localhost:5173/" });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    wc.emit("console-message", {
      level: "warning",
      message: "Electron Security Warning",
      lineNumber: 2,
      sourceId: "node:electron/js2c/sandbox_bundle",
    });
    wc.emit("console-message", {
      level: "error",
      message: "Uncaught Error: boom at http://u:p@localhost:5173/a?token=abc",
      lineNumber: 9,
      sourceId: "http://localhost:5173/app.js?t=secret",
    });
    // Positional args (pre-35 Electron) still land.
    wc.emit("console-message", {}, 1, "hello", 3, "http://localhost:5173/");
    let d = await preview.diagnostics({ threadId: "t1" });
    assert.equal(d.console.length, 2);
    assert.equal(d.console[0].level, "error");
    assert.equal(
      d.console[0].text,
      "Uncaught Error: boom at http://localhost:5173/a?…",
    );
    assert.equal(d.console[0].source, "http://localhost:5173/app.js?t=redacted:9");
    assert.equal(d.console[1].level, "info");

    for (let i = 0; i < 150; i++) {
      wc.emit("console-message", { level: "info", message: `m${i}`, sourceId: "" });
    }
    d = await preview.diagnostics({ threadId: "t1" });
    assert.equal(d.console.length, 100);
    assert.equal(d.console.at(-1).text, "m149");
    assert.equal(d.dropped.console, 52);
    const long = "x".repeat(5000);
    wc.emit("console-message", { level: "error", message: long, sourceId: "" });
    d = await preview.diagnostics({ threadId: "t1" });
    assert.equal(d.console.at(-1).text.length, 500);
  });

  it("network keeps failures and fetches with timing, no headers, no secrets", async () => {
    const wc = fakeWebContents({ url: "http://localhost:5173/" });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    const web = wc._state.web;
    const req = (id, url, resourceType, t0) => {
      web.onSendHeaders({
        id, url, resourceType, method: "GET", timestamp: t0,
        webContentsId: 7, requestHeaders: { Authorization: "Bearer x" },
      });
    };
    req(1, "http://localhost:5173/main.js", "script", 1000);
    web.onCompleted({ id: 1, url: "http://localhost:5173/main.js", resourceType: "script", statusCode: 200, timestamp: 1010, webContentsId: 7 });
    req(2, "http://user:pw@localhost:5173/api/missing?token=abc&page=2#frag", "xhr", 1000);
    web.onCompleted({
      id: 2, url: "http://user:pw@localhost:5173/api/missing?token=abc&page=2#frag",
      resourceType: "xhr", method: "POST", statusCode: 404, timestamp: 1042.4,
      webContentsId: 7, responseHeaders: { "set-cookie": ["s=1"] },
    });
    req(3, "http://127.0.0.1:9/x", "xhr", 2000);
    web.onErrorOccurred({ id: 3, url: "http://127.0.0.1:9/x", resourceType: "xhr", error: "net::ERR_CONNECTION_REFUSED", timestamp: 2005, webContentsId: 7 });
    web.onErrorOccurred({ id: 4, url: "http://localhost:5173/logo.png", resourceType: "image", error: "net::ERR_FAILED", timestamp: 1, webContentsId: 7 });
    // Another guest on the session is not ours.
    web.onErrorOccurred({ id: 5, url: "http://localhost:5173/z", resourceType: "xhr", error: "x", webContentsId: 99 });

    const d = await preview.diagnostics({ threadId: "t1" });
    assert.deepEqual(
      d.network.map(({ seq: _s, at: _a, ...rest }) => rest),
      [
        {
          doc: 0, method: "POST",
          url: "http://localhost:5173/api/missing?token=redacted&page=redacted",
          type: "xhr", status: 404, durationMs: 42,
        },
        {
          doc: 0, method: "GET", url: "http://127.0.0.1:9/x", type: "xhr",
          error: "net::ERR_CONNECTION_REFUSED", durationMs: 5,
        },
        {
          doc: 0, method: "GET", url: "http://localhost:5173/logo.png", type: "image",
          error: "net::ERR_FAILED", durationMs: null,
        },
      ],
    );
    assert.doesNotMatch(JSON.stringify(d), /Bearer|set-cookie|abc|pw@|frag/);
  });

  it("snapshot refs act on their own document only", async () => {
    const wc = fakeWebContents({ url: "http://localhost:5173/" });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    await assert.rejects(
      preview.click({ threadId: "t1", ref: "s1e0" }),
      /stale/,
      "no snapshot yet",
    );

    const snap = await preview.snapshot({ threadId: "t1" });
    assert.equal(snap.snapshotId, 1);
    assert.equal(snap.nodes[0].ref, "s1e0");
    assert.deepEqual(snap.limits, { maxNodes: 250, maxDepth: 48, maxBytes: 32000 });
    const arg = wc._state.scripts.at(-1).arg;
    assert.equal(arg.snapshotId, 1);
    assert.equal(arg.maxNodes, 250);

    const clicked = await preview.click({ threadId: "t1", ref: "s1e0" });
    assert.equal(clicked.completion, "done");
    assert.deepEqual(
      { ...wc._state.scripts.at(-1).arg },
      { snapshotId: 1, index: 0, kind: "click", text: null },
    );

    wc.emit("did-navigate", {}, "http://localhost:5173/next");
    const before = wc._state.scripts.length;
    await assert.rejects(preview.click({ threadId: "t1", ref: "s1e0" }), /stale/);
    await assert.rejects(preview.type({ threadId: "t1", ref: "s1e0", text: "x" }), /stale/);
    assert.equal(wc._state.scripts.length, before, "a stale ref never reaches the page");

    await preview.snapshot({ threadId: "t1" });
    await preview.click({ threadId: "t1", ref: "s2e0" });
    // A newer snapshot of the same document retires the older refs too.
    await preview.snapshot({ threadId: "t1" });
    await assert.rejects(preview.click({ threadId: "t1", ref: "s2e0" }), /stale/);
    wc.emit("did-navigate-in-page", {}, "http://localhost:5173/#x", true);
    await assert.rejects(preview.click({ threadId: "t1", ref: "s3e0" }), /stale/);

    await assert.rejects(preview.click({ threadId: "t1", ref: "button" }), /Unknown ref/);
    await assert.rejects(
      preview.click({ threadId: "t1", ref: "s3e0", selector: "b" }),
      /not both/,
    );
    await assert.rejects(preview.click({ threadId: "t1" }), /selector or ref/);
  });

  it("a snapshot that raced one late navigation event retries once", async () => {
    let calls = 0;
    const wc = fakeWebContents({
      url: "http://localhost:5173/",
      execute: (fn, arg) => {
        if (fn === "pageAction") return { ok: true, tag: "BUTTON" };
        if (fn === "pageSnapshot" && ++calls === 1) {
          wc.emit("did-navigate", {}, "http://localhost:5173/");
        }
        return { nodes: [{ ref: `s${arg.snapshotId}e0`, role: "button", name: "Go" }], truncated: null, viewport: null };
      },
    });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    const snap = await preview.snapshot({ threadId: "t1" });
    assert.equal(calls, 2);
    assert.equal(snap.snapshotId, 2);
    assert.equal((await preview.click({ threadId: "t1", ref: "s2e0" })).completion, "done");
  });

  it("a snapshot taken across a navigation is refused", async () => {
    const wc = fakeWebContents({
      url: "http://localhost:5173/",
      execute: (fn) => {
        wc.emit("did-navigate", {}, "http://localhost:5173/other");
        return { nodes: [], truncated: null, viewport: null };
      },
    });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    await assert.rejects(preview.snapshot({ threadId: "t1" }), /navigated/);
  });

  it("an action the page never answers reports uncertain completion", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wc = fakeWebContents({
      url: "http://localhost:5173/",
      execute: () => new Promise(() => {}), // alert() blocks the page
    });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });
    const pending = preview.click({ threadId: "t1", selector: "#pay" });
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(preview.ACTION_TIMEOUT_MS);
    const result = await pending;
    assert.equal(result.completion, "uncertain");
    assert.equal(result.ok, false);
    assert.match(result.message, /may or may not have happened/);
    assert.match(result.message, /snapshot or screenshot before retrying/);
  });

  it("viewport presets are explicit and screenshots record the real viewport", async () => {
    const wc = fakeWebContents({ url: "http://localhost:5173/" });
    preview.setWebContentsLookup(() => wc);
    preview.bind({ threadId: "t1", webContentsId: 7 });

    let shot = await preview.screenshot({ threadId: "t1" });
    assert.deepEqual(shot.viewport, { preset: "fill", width: 800, height: 600, devicePixelRatio: 2 });
    assert.deepEqual(shot.image, { width: 800, height: 600 });
    assert.equal(wc._state.captures.at(-1), null);

    const vp = await preview.viewport({ threadId: "t1", preset: "desktop" });
    assert.equal(wc._state.emulation.viewSize.width, 1440);
    assert.equal(wc._state.emulation.screenPosition, "desktop");
    const scale = Math.min(800 / 1440, 600 / 900);
    assert.equal(wc._state.emulation.scale, scale);
    assert.deepEqual(vp.viewport, {
      preset: "desktop", width: 1440, height: 900, devicePixelRatio: 2, displayScale: scale,
    });
    assert.equal((await preview.info({ threadId: "t1" })).viewportPreset, "desktop");

    shot = await preview.screenshot({ threadId: "t1" });
    assert.equal(shot.viewport.width, 1440);
    assert.deepEqual(wc._state.captures.at(-1), {
      x: 0, y: 0, width: Math.round(1440 * scale), height: Math.round(900 * scale),
    });

    // Switching presets keeps the pane's natural size, not the emulated one.
    await preview.viewport({ threadId: "t1", preset: "mobile" });
    assert.equal(wc._state.emulation.scale, Math.min(1, 600 / 844));

    const fill = await preview.viewport({ threadId: "t1", preset: "fill" });
    assert.equal(wc._state.emulation, null);
    assert.equal(fill.viewport.preset, "fill");
    assert.equal(fill.viewport.width, 800);

    await assert.rejects(
      preview.viewport({ threadId: "t1", preset: "toString" }),
      /Unknown viewport preset/,
    );

    await preview.viewport({ threadId: "t1", preset: "tablet" });
    preview.unbind({ threadId: "t1" });
    assert.equal(wc._state.emulation, null, "unbind restores the pane's own size");
  });

  it("redactUrl strips credentials, query values and fragments", () => {
    assert.equal(
      preview.redactUrl("https://a:b@localhost:3000/cb?code=xyz&state=1#access_token=t"),
      "https://localhost:3000/cb?code=redacted&state=redacted",
    );
    assert.equal(preview.redactUrl("not a url?secret=1"), "not a url");
  });

  it("refuses navigate to the open web", async () => {
    const wc = fakeWebContents();
    preview.setWebContentsLookup((id) => (id === 1 ? wc : null));
    preview.bind({ threadId: "t1", webContentsId: 1 });
    await assert.rejects(
      preview.navigate({ threadId: "t1", url: "https://example.com/" }),
      /local URLs/,
    );
    assert.equal(wc._state.loads.length, 0);
  });

  it("throws a pane-closed error when unbound", async () => {
    await assert.rejects(
      preview.screenshot({ threadId: "t1" }),
      new RegExp(preview.PANE_CLOSED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("guest policy sends a non-loopback window.open to the OS and denies the window", () => {
    const wc = fakeWebContents();
    const opened = [];
    preview.setOpenExternal((url) => opened.push(url));
    preview.attachGuestPolicy(wc);
    const decision = wc._state.windowOpen({ url: "https://github.com/x" });
    assert.deepEqual(decision, { action: "deny" });
    assert.deepEqual(opened, ["https://github.com/x"]);
  });

  it("unbind forgets the session so the next shot fails closed", async () => {
    const wc = fakeWebContents();
    preview.setWebContentsLookup((id) => (id === 3 ? wc : null));
    preview.bind({ threadId: "t1", webContentsId: 3 });
    preview.unbind({ threadId: "t1", webContentsId: 3 });
    await assert.rejects(preview.info({ threadId: "t1" }), /Browser pane is not open/);
  });
});