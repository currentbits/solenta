// One-off screenshot helper (not shipped): loads the Vite mock UI in a hidden
// Electron window and saves a PNG. Usage:
//   node_modules/.bin/electron scripts/capture-screenshot.js <url> <out.png>
"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const [, , url, out] = process.argv;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1680,
    height: 1050,
    show: false,
    backgroundColor: "#0b0e14",
    webPreferences: { offscreen: true, partition: `shot-${Date.now()}` },
  });
  try {
    await win.loadURL(url);
    // Let fonts settle and the mock data render.
    await new Promise((r) => setTimeout(r, 4000));
    // In the pure-Vite mock there is no server token, so the web token gate
    // covers the UI. Drop it for the shot.
    await win.webContents.executeJavaScript(
      `document.querySelector("[data-web-token-gate]")?.remove(); "ok"`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    console.log("wrote", out);
  } catch (err) {
    console.error("capture failed:", err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
