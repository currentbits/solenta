"use strict";

/**
 * Browser pane evidence against a real guest (issue #1191). The unit tests
 * fake webContents; this proves the page-side snapshot, console, network,
 * ref and viewport paths on Chromium. A local fixture serves a page with a
 * failed fetch, a console error, an uncaught exception and an invalid form.
 *
 *   ./node_modules/.bin/electron electron/preview-smoke.js
 *
 * scripts/test-smoke.js runs it after electron/smoke.js.
 */

const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const assert = require("node:assert/strict");
const preview = require("./preview.js");

process.on("uncaughtException", (err) => {
  console.error(JSON.stringify({ step: "uncaught", ok: false, error: String(err && err.stack) }));
  process.exit(1);
});

const FORM_PAGE = (refusedPort) => `<!doctype html><title>Fixture</title>
<h1>Signup</h1>
<form>
  <label for=email>Email</label><input id=email type=email required>
  <input id=pw type=password aria-label="Password" value="hunter2">
  <label><input type=checkbox id=remember> Remember me</label>
  <button type=submit>Create account</button>
  <button style="display:none">Hidden action</button>
  <div aria-hidden="true"><button>Decorative</button></div>
</form>
<button id=blocker onclick="alert('blocked')">Blocking dialog</button>
<a href="/next">Next page</a>
<script>
console.error("boom from fixture");
fetch("/api/missing?token=abc123").catch(() => {});
fetch("http://127.0.0.1:${refusedPort}/down").catch(() => {});
setTimeout(() => { throw new Error("uncaught kaboom"); }, 0);
</script>`;

const BIG_PAGE = `<!doctype html><title>Big</title><main>${"<button>b</button>".repeat(600)}</main>
<div id=deep></div><script>
let n = document.getElementById("deep");
for (let i = 0; i < 80; i++) { const d = document.createElement("div"); n.appendChild(d); n = d; }
n.innerHTML = "<button>Deepest</button>";
</script>`;

function log(step, data) {
  console.log(JSON.stringify({ step, ok: true, ...data }));
}

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  // A port that refuses connections: bind, read it, close.
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const refusedPort = closed.address().port;
  await new Promise((r) => closed.close(r));

  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    res.setHeader("content-type", "text/html");
    if (path === "/") return res.end(FORM_PAGE(refusedPort));
    if (path === "/next") return res.end("<!doctype html><title>Next</title><h1>Next</h1>");
    if (path === "/big") return res.end(BIG_PAGE);
    res.statusCode = 404;
    res.end("missing");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
  });
  const attached = new Promise((resolve) => {
    win.webContents.once("did-attach-webview", (_e, guest) => resolve(guest));
  });
  await win.loadURL(
    "data:text/html," +
      encodeURIComponent(
        `<body style="margin:0"><webview partition="${preview.partitionForThread("t1")}" src="about:blank" style="display:inline-flex;width:800px;height:600px"></webview>`,
      ),
  );
  const guest = await attached;
  const threadId = "t1";
  // Electron's <webview> plumbing keeps its own listener; count ours on top.
  const baseline = guest.listenerCount("console-message");
  preview.bind({ threadId, webContentsId: guest.id });
  preview.bind({ threadId, webContentsId: guest.id });
  assert.equal(guest.listenerCount("console-message"), baseline + 1, "rebind must not stack listeners");

  await preview.navigate({ threadId, url: `${base}/` });

  // Diagnostics: console error, uncaught exception, 404 and refused fetch.
  const diag = await until(async () => {
    const d = await preview.diagnostics({ threadId });
    const refused = d.network.find((n) => n.url.includes(`:${refusedPort}/`));
    const missing = d.network.find((n) => n.status === 404);
    const uncaught = d.console.find((c) => /Uncaught Error: uncaught kaboom/.test(c.text));
    return refused && missing && uncaught ? d : null;
  }, "fixture diagnostics");
  const missing = diag.network.find((n) => n.status === 404);
  assert.equal(missing.url, `${base}/api/missing?token=redacted`);
  assert.equal(missing.type, "xhr");
  assert.equal(typeof missing.durationMs, "number");
  const refused = diag.network.find((n) => n.url.includes(`:${refusedPort}/`));
  assert.match(refused.error, /ERR_CONNECTION_REFUSED/);
  assert.ok(diag.network.some((n) => n.type === "mainFrame" && n.status === 200));
  assert.ok(diag.console.some((c) => c.level === "error" && c.text === "boom from fixture"));
  assert.ok(!diag.console.some((c) => /Electron Security Warning/.test(c.text)));
  assert.doesNotMatch(JSON.stringify(diag), /abc123|hunter2/);
  log("diagnostics", { console: diag.console.length, network: diag.network.length });

  // Snapshot: roles, names, states; hidden and aria-hidden controls absent.
  const snap = await preview.snapshot({ threadId });
  const by = (role, name) => snap.nodes.find((n) => n.role === role && n.name === name);
  assert.deepEqual(by("heading", "Signup") && by("heading", "Signup").level, 1);
  const email = by("textbox", "Email");
  assert.ok(email, JSON.stringify(snap.nodes));
  assert.equal(email.required, true);
  assert.equal(email.invalid, true);
  assert.ok(email.validationMessage, "the browser's own validation message");
  const pw = by("textbox", "Password");
  assert.equal(pw.filled, true);
  assert.equal("value" in pw, false, "password values never leave the page");
  assert.ok(by("checkbox", "Remember me"));
  assert.ok(by("button", "Create account"));
  assert.ok(by("link", "Next page"));
  assert.ok(by("form", ""));
  assert.equal(by("button", "Hidden action"), undefined);
  assert.equal(by("button", "Decorative"), undefined);
  assert.equal(snap.truncated, null);
  assert.equal(snap.viewport.width, 800);
  log("snapshot", { nodes: snap.nodes });

  // Refs drive the form, and the page reports the new state.
  const typed = await preview.type({ threadId, ref: email.ref, text: "a@b.co" });
  assert.equal(typed.completion, "done");
  await preview.click({ threadId, ref: by("checkbox", "Remember me").ref });
  const snap2 = await preview.snapshot({ threadId });
  const email2 = snap2.nodes.find((n) => n.role === "textbox" && n.name === "Email");
  assert.equal(email2.value, "a@b.co");
  assert.equal(email2.invalid, undefined);
  assert.equal(snap2.nodes.find((n) => n.role === "checkbox").checked, true);
  await assert.rejects(preview.click({ threadId, ref: email.ref }), /stale/);

  // Navigation retires every ref, even one the old snapshot still names.
  const next = snap2.nodes.find((n) => n.role === "link");
  await preview.click({ threadId, ref: next.ref });
  await until(() => guest.getURL().endsWith("/next"), "navigation to /next");
  await assert.rejects(preview.click({ threadId, ref: next.ref }), /stale/);
  log("refs", {});

  // Limits.
  await preview.navigate({ threadId, url: `${base}/big` });
  const big = await preview.snapshot({ threadId });
  assert.equal(big.nodes.length, 250);
  assert.deepEqual(big.truncated, { nodes: true });
  assert.ok(JSON.stringify(big.nodes).length <= 32_000);
  await guest.executeJavaScript('document.querySelector("main").remove()');
  const deep = await preview.snapshot({ threadId });
  assert.equal(deep.truncated && deep.truncated.depth, true);
  assert.ok(!deep.nodes.some((n) => n.name === "Deepest"));
  log("limits", {});

  // Viewport presets: explicit, measured in the page, carried by the PNG.
  await preview.navigate({ threadId, url: `${base}/` });
  const mobile = await preview.viewport({ threadId, preset: "mobile" });
  assert.equal(mobile.viewport.width, 390);
  assert.equal(mobile.viewport.height, 844);
  const shot = await preview.screenshot({ threadId });
  assert.equal(shot.viewport.preset, "mobile");
  assert.equal(shot.viewport.width, 390);
  const dpr = shot.viewport.devicePixelRatio;
  const scale = mobile.viewport.displayScale;
  assert.ok(Math.abs(shot.image.width - Math.round(390 * scale) * dpr) <= dpr, JSON.stringify(shot.image));
  const fill = await preview.viewport({ threadId, preset: "fill" });
  assert.equal(fill.viewport.width, 800);
  log("viewport", { mobile: mobile.viewport, image: shot.image });

  // A blocking dialog: the action cannot be confirmed either way.
  const s3 = await preview.snapshot({ threadId });
  const blocker = s3.nodes.find((n) => n.name === "Blocking dialog");
  const started = Date.now();
  const blocked = await preview.click({ threadId, ref: blocker.ref });
  assert.equal(blocked.completion, "uncertain");
  assert.ok(Date.now() - started >= preview.ACTION_TIMEOUT_MS - 50);
  log("uncertain", {});

  preview.unbind({ threadId, webContentsId: guest.id });
  assert.equal(guest.listenerCount("console-message"), baseline);
  server.close();
  log("done", {});
}

app.whenReady().then(() =>
  main().then(
    () => app.exit(0),
    (err) => {
      console.error(JSON.stringify({ step: "preview-smoke", ok: false, error: String(err && err.stack) }));
      app.exit(1);
    },
  ),
);
