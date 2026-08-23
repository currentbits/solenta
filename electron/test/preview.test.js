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
    capturePage: async () => fakeImage(over.image),
    executeJavaScript: async (code) => {
      state.scripts.push(code);
      if (typeof over.execute === "function") return over.execute(code);
      return { ok: true, tag: "BUTTON", text: "Save" };
    },
    setWindowOpenHandler: (fn) => {
      state.windowOpen = fn;
    },
    on: (ev, fn) => {
      state.handlers[ev] = fn;
    },
    once: (ev, fn) => {
      state.handlers[ev] = fn;
    },
    _state: state,
  };
  return wc;
}

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

    const click = await preview.click({ threadId: "t1", selector: "button.save" });
    assert.equal(click.ok, true);
    assert.equal(wc._state.scripts.length, 1);
    assert.match(wc._state.scripts[0], /button\.save/);

    const typed = await preview.type({
      threadId: "t1",
      selector: "#q",
      text: "hello",
    });
    assert.equal(typed.ok, true);
    assert.match(wc._state.scripts[1], /hello/);
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