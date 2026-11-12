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
    // A same-document start alone is not a document replacement.
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

  it("settles a destroyed guest without reading its dead webContents", async () => {
    const wc = fakeGuest({ pick: () => new Promise(() => {}) });
    bindGuest(wc);
    const pending = preview.inspect({ threadId: "t1", sessionId: "s", annotationId: "a" });
    wc.getURL = () => { throw new Error("Object has been destroyed"); };
    wc.isDestroyed = () => true;
    wc._state.handlers.destroyed();
    assert.equal((await pending).cancelled, true);
  });

  it("refuses a capture after a same-URL document replacement", async () => {
    let release;
    const wc = fakeGuest({ pick: async () => PICK });
    wc.capturePage = () => new Promise((resolve) => { release = resolve; });
    bindGuest(wc);
    const pending = preview.inspect({ threadId: "t1", sessionId: "s", annotationId: "a" });
    await new Promise((resolve) => setImmediate(resolve));
    wc._state.handlers["did-navigate"]();
    release({ toDataURL: () => "data:image/png;base64,crop" });
    assert.equal((await pending).cancelled, true);
  });

  it("does not invalidate a capture when an iframe changes its route", async () => {
    let release;
    const wc = fakeGuest({ pick: async () => PICK });
    wc.capturePage = () => new Promise((resolve) => { release = resolve; });
    bindGuest(wc);
    const pending = preview.inspect({ threadId: "t1", sessionId: "s", annotationId: "a" });
    await new Promise((resolve) => setImmediate(resolve));
    wc._state.handlers["did-navigate-in-page"]({ isMainFrame: false });
    assert.equal(wc._state.scripts.length, 1);
    release({ toDataURL: () => "data:image/png;base64,crop" });
    assert.equal((await pending).cancelled, false);
  });

  it("validates marker updates and only sends bounded captured identities", async () => {
    const wc = fakeGuest(); bindGuest(wc);
    await assert.rejects(preview.annotations({ threadId: "t1", sessionId: "s", markers: [{ id: "#selector", number: 1 }] }), /Invalid annotation/);
    await assert.rejects(preview.annotations({ threadId: "t1", sessionId: "s", markers: Array(101).fill({ id: "a", number: 1 }) }), /Invalid annotation/);
    assert.deepEqual(await preview.annotations({ threadId: "t1", sessionId: "s", markers: [{ id: "a", number: 1 }] }), { ok: true });
    assert.match(wc._state.scripts.at(-1).code, /"markers":\[{"id":"a","number":1}\]/);
    await assert.rejects(preview.inspect({ threadId: "t1", sessionId: "bad id", annotationId: "a" }), /Invalid annotation identity/);
    delete wc.executeJavaScriptInIsolatedWorld;
    await assert.rejects(preview.inspect({ threadId: "t1", sessionId: "s", annotationId: "a" }), /isolated preview/);
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
  // jsdom has no trusted input source. Only this test-owned isolated script
  // substitutes the trust check; a separate case disables it for page events.
  window.__trustedForTest = true;
  let root;
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    root = attachShadow.call(this, options);
    return root;
  };
  const run = (cancel, options) => window.eval(preview.inspectScript(cancel, options).replaceAll("e.isTrusted", "(e.isTrusted || window.__trustedForTest)"));
  const start = (options) => run(false, options);
  const cancel = (options) => run(true, options);
  return { window, start, cancel, root: () => root, counts: () => ({ submitted, clicked }) };
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


describe("continuous guest annotations", () => {
  it("cannot restart a session stopped while main was saving the preceding pick", async () => {
    const g = guestPage();
    const first = g.start({ sessionId: "session-a", annotationId: "one" });
    g.window.document.getElementById("go").click();
    assert.equal((await first).cancelled, false);
    g.cancel({ sessionId: "session-a" });
    assert.equal((await g.start({ sessionId: "session-a", annotationId: "two" })).cancelled, true);
    const fresh = g.start({ sessionId: "session-b", annotationId: "three" });
    g.window.document.getElementById("pw").click();
    assert.equal((await fresh).password, true);
    g.cancel();
  });

  it("keeps activation blocked between picks, numbers captured references and fences old cancellation", async () => {
    const g = guestPage();
    const first = g.start({ sessionId: "session-a", annotationId: "one" });
    const button = g.window.document.getElementById("go");
    button.click();
    assert.equal((await first).tag, "button");
    button.click(); // While main captures/saves, this must not activate the page.
    assert.deepEqual(g.counts(), { submitted: 0, clicked: 0 });
    g.start({ sessionId: "session-a", markers: [{ id: "one", number: 1 }] });
    const second = g.start({ sessionId: "session-a", annotationId: "two" });
    g.window.document.getElementById("pw").click();
    assert.equal((await second).password, true);
    g.start({ sessionId: "session-a", markers: [{ id: "one", number: 1 }, { id: "two", number: 2 }] });
    const markers = () => [...g.root().querySelectorAll("div")].filter((el) => el.style.borderRadius === "50%");
    assert.deepEqual(markers().map((el) => el.textContent), ["1", "2"]);
    const third = g.start({ sessionId: "session-a", annotationId: "three" });
    g.start({ sessionId: "session-a", markers: [{ id: "two", number: 1 }] });
    assert.deepEqual(markers().map((el) => el.textContent), ["1"]);
    g.cancel({ sessionId: "old-session" });
    button.click();
    assert.equal((await third).tag, "button", "stale cancellation cannot stop the current session");
    const waiting = g.start({ sessionId: "session-a", annotationId: "four" });
    key(g.window, "keydown", "Escape");
    assert.equal((await waiting).cancelled, true);
    assert.equal(g.window.document.querySelectorAll("body > div[style]").length, 0);
  });

  it("rejects page-generated clicks, mouse movement and Enter", async () => {
    const g = guestPage();
    g.window.__trustedForTest = false;
    let settled = false;
    const pending = g.start({ sessionId: "session-a", annotationId: "one" }).then((value) => { settled = true; return value; });
    const button = g.window.document.getElementById("go");
    button.click();
    button.dispatchEvent(new g.window.MouseEvent("mouseover", { bubbles: true }));
    key(g.window, "keydown", "Enter");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);
    assert.deepEqual(g.counts(), { submitted: 0, clicked: 0 });
    g.cancel();
    assert.equal((await pending).cancelled, true);
  });
});
