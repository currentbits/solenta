"use strict";

/**
 * Browser pane element inspector (#1193): main-process plumbing with a fake
 * guest, plus the real guest script run inside jsdom.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const preview = require("../preview.js");

function fakeGuest(over = {}) {
  const state = { url: "http://localhost:5173/login", scripts: [], captures: [], handlers: {} };
  const wc = {
    isDestroyed: () => false,
    getURL: () => state.url,
    getTitle: () => "Login",
    canGoBack: () => false,
    canGoForward: () => false,
    getZoomFactor: () => over.zoom ?? 1,
    capturePage: async (rect) => {
      state.captures.push(rect);
      return {
        isEmpty: () => false,
        getSize: () => ({ width: rect.width, height: rect.height }),
        resize: (size) => ({ resized: size, toDataURL: () => "data:image/png;base64,small" }),
        toDataURL: () => "data:image/png;base64,crop",
      };
    },
    executeJavaScript: async () => ({}),
    executeJavaScriptInIsolatedWorld: (worldId, scripts) => {
      state.scripts.push({ worldId, code: scripts[0].code });
      return over.pick ? over.pick(scripts[0].code) : Promise.resolve({ cancelled: true });
    },
    on: (ev, fn) => {
      state.handlers[ev] = fn;
    },
    once: () => {},
    removeListener: (ev) => {
      delete state.handlers[ev];
    },
    _state: state,
  };
  return wc;
}

function bindGuest(wc) {
  preview.setWebContentsLookup(() => wc);
  preview.bind({ threadId: "t1", webContentsId: 5 });
}

const PICK = {
  cancelled: false,
  tag: "button",
  role: "button",
  name: "Sign in",
  selector: "form#login > button",
  html: '<button type="submit">Sign in</button>',
  htmlTruncated: false,
  styles: { display: "inline-flex", padding: "8px 12px" },
  rect: { x: 100, y: 50, width: 120, height: 40 },
  viewport: { width: 1280, height: 800 },
  source: null,
  frame: false,
  password: false,
};

describe("preview.inspect (#1193)", () => {
  beforeEach(() => preview.resetForTests());

  it("refuses a blank guest and an unbound pane", async () => {
    await assert.rejects(preview.inspect({ threadId: "t1" }), /Browser pane is not open/);
    const wc = fakeGuest();
    wc._state.url = "about:blank";
    bindGuest(wc);
    await assert.rejects(preview.inspect({ threadId: "t1" }), /Load a page/);
  });

  it("runs the picker in an isolated world and crops the element rect, zoom-scaled", async () => {
    const wc = fakeGuest({ zoom: 1.5, pick: async () => PICK });
    bindGuest(wc);
    const res = await preview.inspect({ threadId: "t1" });
    assert.equal(res.cancelled, false);
    assert.equal(wc._state.scripts[0].worldId > 0, true);
    assert.equal(res.url, "http://localhost:5173/login");
    assert.equal(typeof res.capturedAt, "number");
    assert.equal(res.element.selectorHint, "form#login > button");
    // 8px pad around (100,50,120,40), times zoom 1.5.
    assert.deepEqual(wc._state.captures, [{ x: 138, y: 63, width: 204, height: 84 }]);
    assert.deepEqual(res.cropRect, wc._state.captures[0]);
    assert.equal(res.crop, "data:image/png;base64,crop");
    assert.equal(res.cropNote, undefined);
  });

  it("re-caps everything the untrusted guest reports", async () => {
    const styles = {};
    for (let i = 0; i < 80; i += 1) styles[`p-${String.fromCharCode(97 + (i % 26))}${i}`] = "x".repeat(500);
    styles["BAD KEY"] = "1";
    const wc = fakeGuest({
      pick: async () => ({
        ...PICK,
        tag: "<script>",
        name: "n".repeat(10_000),
        html: "h".repeat(50_000),
        selector: "s".repeat(5_000),
        styles,
        rect: { x: "NaN", y: 1, width: -5, height: 2 },
      }),
    });
    bindGuest(wc);
    const res = await preview.inspect({ threadId: "t1" });
    const el = res.element;
    assert.equal(el.tag, "element");
    assert.ok(el.name.length <= 161);
    assert.ok(el.html.length <= 3_000);
    assert.ok(el.selectorHint.length <= 300);
    assert.ok(Object.keys(el.styles).length <= 32);
    assert.ok(Object.values(el.styles).every((v) => v.length <= 200));
    assert.equal("BAD KEY" in el.styles, false);
    assert.deepEqual(el.rect, { x: 0, y: 1, width: 0, height: 2 });
  });

  it("reports honestly when the element is off-screen", async () => {
    const wc = fakeGuest({
      pick: async () => ({ ...PICK, rect: { x: 10, y: 2000, width: 50, height: 20 } }),
    });
    bindGuest(wc);
    const res = await preview.inspect({ threadId: "t1" });
    assert.equal(res.crop, null);
    assert.equal(res.cropRect, null);
    assert.match(res.cropNote, /outside the visible viewport/);
    assert.deepEqual(wc._state.captures, []);
  });

  it("caps a large crop to 800px on its longest edge", async () => {
    const wc = fakeGuest({
      pick: async () => ({ ...PICK, rect: { x: 0, y: 0, width: 1280, height: 400 } }),
    });
    bindGuest(wc);
    const res = await preview.inspect({ threadId: "t1" });
    assert.equal(res.crop, "data:image/png;base64,small");
  });

  it("settles as cancelled when the page navigates mid-pick", async () => {
    const wc = fakeGuest({ pick: () => new Promise(() => {}) });
    bindGuest(wc);
    const pending = preview.inspect({ threadId: "t1" });
    await new Promise((r) => setImmediate(r));
    // A same-document (SPA) navigation keeps the picker alive.
    wc._state.handlers["did-start-navigation"]({ isMainFrame: true, isSameDocument: true });
    wc._state.handlers["did-start-navigation"]({ isMainFrame: true, isSameDocument: false });
    const res = await pending;
    assert.equal(res.cancelled, true);
    assert.equal(wc._state.handlers["did-start-navigation"], undefined, "listener removed");
  });

  it("cancelInspect runs the cancel script in the same world", async () => {
    const wc = fakeGuest();
    bindGuest(wc);
    assert.deepEqual(await preview.cancelInspect({ threadId: "t1" }), { ok: true });
    assert.match(wc._state.scripts[0].code, /"cancel":true/);
  });

  it("cropRect clamps to the viewport", () => {
    assert.deepEqual(
      preview.cropRect({ x: -20, y: 790, width: 100, height: 100 }, { width: 1280, height: 800 }),
      { x: 0, y: 782, width: 88, height: 18 },
    );
  });
});

const PAGE = `<!doctype html><body>
  <form id="login" action="/submit">
    <label for="pw">Password</label>
    <input id="pw" type="password" value="hunter2">
    <input type="hidden" name="csrf" value="abc123">
    <input type="text" name="email" value="me@example.com">
    <div class="actions" data-auth-token="eyJabc.def.ghi">
      <button type="submit" id="go" data-inspector-relative-path="src/Login.tsx" data-inspector-line="42">Sign in</button>
    </div>
  </form>
  <iframe src="about:blank" title="ads"></iframe>
</body>`;

function guestPage() {
  const dom = new JSDOM(PAGE, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  let submitted = 0;
  let clicked = 0;
  window.document.getElementById("login").addEventListener("submit", (e) => {
    submitted += 1;
    e.preventDefault();
  });
  window.document.getElementById("go").addEventListener("click", () => {
    clicked += 1;
  });
  const start = () => window.eval(preview.inspectScript(false));
  const cancel = () => window.eval(preview.inspectScript(true));
  return { window, start, cancel, counts: () => ({ submitted, clicked }) };
}

function key(window, type, k) {
  const target = window.document.activeElement || window.document.body;
  const e = new window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("guest inspect script (#1193)", () => {
  it("selecting a submit button does not click it or submit its form", async () => {
    const g = guestPage();
    const pending = g.start();
    const btn = g.window.document.getElementById("go");
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      btn.dispatchEvent(new g.window.MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    btn.dispatchEvent(new g.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    const res = await pending;
    assert.deepEqual(g.counts(), { submitted: 0, clicked: 0 });
    assert.equal(res.cancelled, false);
    assert.equal(res.tag, "button");
    assert.equal(res.role, "button");
    assert.equal(res.name, "Sign in");
    assert.equal(res.selector, "#go");
    assert.equal(res.source, "src/Login.tsx:42");
    assert.equal(g.window.document.querySelectorAll("body > div[style]").length, 0, "overlay removed");
    // After the pick the page behaves normally again.
    btn.click();
    assert.equal(g.counts().clicked, 1);
  });

  it("Escape exits inspection", async () => {
    const g = guestPage();
    const pending = g.start();
    const esc = key(g.window, "keydown", "Escape");
    assert.equal((await pending).cancelled, true);
    assert.equal(esc.defaultPrevented, true);
  });

  it("a new pick or cancel settles the pending one", async () => {
    const g = guestPage();
    const pending = g.start();
    assert.equal(g.cancel().cancelled, true);
    assert.equal((await pending).cancelled, true);
  });

  it("keyboard: Tab focus, ↑ widens to the parent, Enter picks without activating", async () => {
    const g = guestPage();
    const pending = g.start();
    const btn = g.window.document.getElementById("go");
    btn.focus();
    const up = key(g.window, "keydown", "ArrowUp");
    assert.equal(up.defaultPrevented, true);
    const enter = key(g.window, "keydown", "Enter");
    const res = await pending;
    assert.equal(enter.defaultPrevented, true);
    assert.equal(res.tag, "div");
    assert.match(res.selector, /#login > div/);
    // The trailing keyup (Space activates buttons on keyup) is swallowed too.
    assert.equal(key(g.window, "keyup", "Enter").defaultPrevented, true);
    assert.deepEqual(g.counts(), { submitted: 0, clicked: 0 });
    // Secret-looking attribute values are redacted from the parent's HTML.
    assert.doesNotMatch(res.html, /eyJabc/);
    assert.match(res.html, /data-auth-token="\[redacted\]"/);
  });

  it("never captures password, hidden or typed input values", async () => {
    const g = guestPage();
    const pending = g.start();
    g.window.document.getElementById("login").dispatchEvent(
      new g.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    const res = await pending;
    assert.equal(res.tag, "form");
    assert.doesNotMatch(res.html, /hunter2|abc123|me@example\.com/);
    assert.match(res.html, /value="\[redacted\]"/);
  });

  it("names a password field by its label and flags it", async () => {
    const g = guestPage();
    const pending = g.start();
    g.window.document.getElementById("pw").dispatchEvent(
      new g.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    const res = await pending;
    assert.equal(res.password, true);
    assert.equal(res.name, "Password");
    assert.doesNotMatch(JSON.stringify(res), /hunter2/);
  });

  it("flags a picked frame instead of pretending to inspect inside it", async () => {
    const g = guestPage();
    const pending = g.start();
    g.window.document.querySelector("iframe").dispatchEvent(
      new g.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    const res = await pending;
    assert.equal(res.frame, true);
    assert.equal(res.source, null);
  });
});
