// Real sandboxed <webview>: registration before page scripts, discovery,
// mutation, stale refs, policy denial, cancellation and bounded output.
// Run: npx electron scripts/verify-browser-webmcp.js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { app, BrowserWindow, ipcMain } = require("electron");
const preview = require("../electron/preview.js");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "solenta-webmcp-verify-")));
const PAGE = `<!doctype html><title>WebMCP verification</title>
<body style="font:24px system-ui;padding:40px"><h1>Local WebMCP tools</h1><p id="counter">Count: 0</p>
<script>
globalThis.registration = new AbortController();
globalThis.count = 0;
document.modelContext?.registerTool({name:'counter', description:'Update the counter',
 inputSchema:{type:'object',properties:{increment:{type:'number'}}}, annotations:{readOnlyHint:true},
 execute({increment=0}) {count+=increment;document.querySelector('#counter').textContent='Count: '+count;return {count};}
}, {signal:registration.signal});
document.modelContext?.registerTool({name:'read', description:'Read the counter', inputSchema:{type:'object'}, execute:()=>count});
document.modelContext?.registerTool({name:'slow', description:'Wait for cancellation', inputSchema:{type:'object'},
 execute(_args,{signal}) {globalThis.executionSignal=signal;return new Promise(()=>{});}});
document.modelContext?.registerTool({name:'huge', description:'Oversized result', inputSchema:{type:'object'}, execute:()=>'x'.repeat(70000)});
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/denied") res.setHeader("Permissions-Policy", "tools=()");
  res.setHeader("Content-Type", "text/html"); res.end(PAGE);
});
ipcMain.on("preview:webmcpPolicy", (event) => {
  const frame = event.senderFrame;
  event.returnValue = Boolean(frame && !frame.parent && preview.webMcpPolicyAllowed(event.sender, frame.url));
});

let win;
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  win = new BrowserWindow({ show: false, width: 900, height: 650,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on("will-attach-webview", (event, prefs, params) => {
    if (!preview.guestWebviewPolicy(prefs, params).allow) event.preventDefault();
  });
  const guestReady = new Promise((resolve) => win.webContents.once("did-attach-webview", (_event, wc) => {
    preview.attachGuestPolicy(wc);
    preview.bind({ threadId: "verify-webmcp", webContentsId: wc.id }); resolve(wc);
  }));
  await win.loadURL("data:text/html,<body style='margin:0'><webview partition='solenta-preview:verify-webmcp' src='about:blank' style='width:900px;height:650px'></webview>");
  const wc = await guestReady;
  win.showInactive();
  const base = { threadId: "verify-webmcp" };
  const url = `http://127.0.0.1:${server.address().port}`;
  const load = (suffix = "") => preview.navigate({ ...base, url: url + suffix });
  const tools = async () => (await preview.webmcpTools(base)).tools;
  await load();
  let list = await tools();
  assert.equal(list.length, 4, "registered before discovery");
  const ref = list.find((t) => t.name === "counter").ref;
  await assert.rejects(preview.webmcpInvoke({ ...base, ref, arguments: { increment: "2" } }), /must be number/);
  const result = await preview.webmcpInvoke({ ...base, ref, arguments: { increment: 2 } });
  assert.deepEqual(result.result, { count: 2 });
  assert.equal(await wc.executeJavaScript("document.querySelector('#counter').textContent"), "Count: 2");
  assert.equal((await preview.webmcpInvoke({ ...base, ref: list.find((t) => t.name === "read").ref })).result, 2);
  await wc.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  // The compositor can lag behind DOM/rAF readiness when a hidden window opens.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const screenshot = await win.webContents.capturePage();
  assert.ok(screenshot.toBitmap()[0] > 200, "page has painted a white background");
  fs.writeFileSync("/tmp/solenta-webmcp.png", screenshot.toPNG());
  console.log("ok: initial registrations, read and mutation callbacks; screenshot /tmp/solenta-webmcp.png");

  await wc.executeJavaScript("registration.abort()");
  assert.equal((await preview.webmcpInvoke({ ...base, ref })).ok, false);
  list = await tools();
  const pending = preview.webmcpInvoke({ ...base, ref: list.find((t) => t.name === "slow").ref, invocationId: "slow" });
  // Readiness comes from the actual page, not a fixed delay.
  for (let i = 0; i < 50 && !await wc.executeJavaScript("!!globalThis.executionSignal"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  preview.webmcpCancel({ ...base, invocationId: "slow" });
  assert.equal((await pending).completion, "uncertain");
  assert.equal(await wc.executeJavaScript("executionSignal.aborted"), true);
  list = await tools();
  assert.equal((await preview.webmcpInvoke({ ...base, ref: list.find((t) => t.name === "huge").ref })).ok, false);
  const oldRef = list[0].ref;
  await load();
  await assert.rejects(preview.webmcpInvoke({ ...base, ref: oldRef }), /stale/);
  await wc.executeJavaScript("history.pushState({}, '', '/spa-route')");
  assert.equal((await tools()).length, 4, "same-document pushState keeps the response policy");
  await load("/denied");
  assert.equal((await preview.webmcpTools(base)).available, false);
  assert.equal(await wc.executeJavaScript("typeof document.modelContext"), "undefined");
  await load();
  assert.equal((await tools()).length, 4, "policy resets per response");
  assert.equal(await wc.executeJavaScript("typeof require"), "undefined");
  assert.equal(await wc.executeJavaScript("typeof globalThis.coder"), "undefined");
  console.log("ok: tool replacement, cancellation, output limit, reload fencing, response policy and guest isolation");
}).then(() => finish(0)).catch((error) => {
  console.error(error); finish(1);
});

function finish(code) {
  preview.resetForTests(); server.close(); win?.destroy(); app.exit(code);
}
