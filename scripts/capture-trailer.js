// Capture the three Solenta proof beats for the launch trailer.
// Usage:
//   VITE_TRAILER=1 npx vite --port 5173 --strictPort
//   npx electron scripts/capture-trailer.js
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const URL = process.env.TRAILER_URL || "http://localhost:5173";
const OUT_DIR = path.join(__dirname, "..", "trailer", "public", "footage");
const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1080;

const SHOTS = [
  {
    name: "sidebar",
    seconds: 8,
    select: "thread-2",
    delayBeforeSelectMs: 1500,
    tab: null,
  },
  {
    name: "pipeline",
    seconds: 12,
    select: "thread-1",
    delayBeforeSelectMs: 200,
    tab: "Agents",
  },
  {
    name: "pr",
    seconds: 6,
    select: "thread-2",
    delayBeforeSelectMs: 200,
    tab: null,
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReady(win) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript(`
      (() => {
        document.querySelector("[data-web-token-gate]")?.remove();
        return Boolean(document.querySelector("[data-thread-card]"));
      })()
    `);
    if (ready) return;
    await sleep(200);
  }
  throw new Error("UI never showed a thread card");
}

async function selectThread(win, threadId) {
  const ok = await win.webContents.executeJavaScript(`
    (() => {
      const card = document.querySelector('[data-thread-card="${threadId}"]');
      const btn = card && card.querySelector("button");
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!ok) throw new Error(`could not click ${threadId}`);
}

async function selectTab(win, label) {
  if (!label) return;
  const ok = await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === ${JSON.stringify(label)},
      );
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!ok) throw new Error(`could not click tab ${label}`);
}

async function captureShot(win, shot, tmpRoot) {
  const dir = path.join(tmpRoot, shot.name);
  fs.mkdirSync(dir, { recursive: true });
  const total = shot.seconds * FPS;
  const interval = 1000 / FPS;
  let wrote = 0;
  const start = Date.now();
  let selected = false;

  for (let i = 0; i < total; i++) {
    const elapsed = Date.now() - start;
    if (!selected && elapsed >= shot.delayBeforeSelectMs) {
      await selectThread(win, shot.select);
      await selectTab(win, shot.tab);
      selected = true;
    }
    const img = await win.webContents.capturePage();
    const jpeg = img.toJPEG(82);
    fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(4, "0")}.jpg`), jpeg);
    wrote += 1;
    const target = start + (i + 1) * interval;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
  }

  if (wrote < total * 0.8) {
    throw new Error(`${shot.name}: only ${wrote}/${total} frames`);
  }

  const out = path.join(OUT_DIR, `${shot.name}.mp4`);
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      path.join(dir, "%04d.jpg"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "18",
      out,
    ],
    { encoding: "utf8" },
  );
  if (ff.status !== 0) {
    throw new Error(`ffmpeg ${shot.name} failed: ${ff.stderr}`);
  }
  console.log("wrote", out, `(${wrote} frames)`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-trailer-"));
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    backgroundColor: "#0a0d13",
    webPreferences: { offscreen: true, partition: `trailer-${Date.now()}` },
  });
  try {
    await win.loadURL(URL);
    await sleep(4000);
    await waitForReady(win);
    for (const shot of SHOTS) {
      await captureShot(win, shot, tmpRoot);
    }
    console.log("done", tmpRoot);
  } catch (err) {
    console.error("capture failed:", err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
