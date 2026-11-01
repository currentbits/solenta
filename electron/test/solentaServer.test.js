"use strict";

// Headless Solenta server (#1829): main.js in plain Node behind a stand-in
// electron module.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createElectronShim, DESKTOP_ONLY } = require("../server/electronShim.js");

describe("electron stand-in", () => {
  const shim = createElectronShim({ userData: "/data/solenta", appPath: "/app", version: "9.9.9" });

  it("gives main.js real paths and an app lifecycle", async () => {
    assert.equal(shim.app.getPath("userData"), "/data/solenta");
    assert.equal(shim.app.getPath("home"), os.homedir());
    assert.equal(shim.app.getVersion(), "9.9.9");
    assert.equal(shim.app.requestSingleInstanceLock(), true);
    let ready = false;
    shim.app.on("ready", () => { ready = true; });
    await shim.app.whenReady();
    assert.equal(ready, true);
    assert.deepEqual(shim.BrowserWindow.getAllWindows(), []);
    assert.equal(shim.safeStorage.isEncryptionAvailable(), false);
  });

  it("keeps GUI surfaces inert and says when something needs the desktop app", () => {
    // Unknown members chain and call without throwing (menus, tray, dock).
    shim.Menu.buildFromTemplate([]).popup();
    shim.app.dock.hide();
    new shim.Tray("x").setToolTip("y");
    assert.throws(() => shim.dialog.showOpenDialog({}), new RegExp(DESKTOP_ONLY.slice(0, 30)));
    assert.throws(() => shim.shell.openExternal("https://x"), /desktop app/);
    assert.throws(() => new shim.BrowserWindow({}), /desktop app/);
  });
});

describe("solenta-server boot", { skip: process.platform === "win32" && "no Windows server bundle" }, () => {
  it("serves Solenta Web from plain Node and writes the token SSH connect reads", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-server-"));
    const port = 47000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, [path.join(__dirname, "../server/index.js"), "--port", String(port), "--data-dir", path.join(tmp, "data")], {
      // Own HOME: the boot registers MCP servers in user-global CLI configs.
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CODER_SIMULATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    try {
      const deadline = Date.now() + 45_000;
      while (!/solenta-web: listening/.test(log)) {
        if (child.exitCode != null) assert.fail(`server exited ${child.exitCode}:\n${log}`);
        if (Date.now() > deadline) assert.fail(`server did not start:\n${log}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const token = fs.readFileSync(path.join(tmp, "data", "web-token"), "utf8").trim();
      assert.ok(token.length > 20);
      const status = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
      });
      assert.ok([200, 404].includes(status), `HTTP ${status}`);
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
