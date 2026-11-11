"use strict";

// Run with Electron. Uses actual App/components/CSS and an isolated in-memory
// API; never opens the installed app or invokes a provider. Optional argument:
// directory for reviewable PNG evidence (otherwise only assertions run).
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { windowGeometry } = require("../electron/windowGeometry");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-window-layout-"));
app.setPath("userData", profile);
// The gap between main and detached fixtures must not quit Electron.
app.on("window-all-closed", () => {});
const output = process.argv[2] && path.resolve(process.argv[2]);
if (output) fs.mkdirSync(output, { recursive: true });
let server;
let win;
const delay = () => new Promise((resolve) => setTimeout(resolve, 150));
async function evaluate(fn, ...args) {
  return win.webContents.executeJavaScript(`(${fn})(${args.map((a) => JSON.stringify(a)).join(",")})`);
}
async function until(fn, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (await evaluate(fn)) return;
    await delay();
  }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name) {
  await delay();
  if (output) fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function visible(selector) {
  await evaluate(() => new Promise(requestAnimationFrame));
  const result = await evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return "missing";
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
      const ancestors = [];
      for (let p = el; p; p = p.parentElement) ancestors.push({ tag: p.tagName, class: p.className, top: p.getBoundingClientRect().top, h: p.clientHeight, sh: p.scrollHeight, st: p.scrollTop, overflow: getComputedStyle(p).overflow, visibility: getComputedStyle(p).visibility });
      return JSON.stringify({ rect: r, html: el.outerHTML, ancestors });
    }
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/auto|scroll|hidden/.test(getComputedStyle(p).overflow)) {
        const c = p.getBoundingClientRect();
        if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) return `clipped by ${p.className}`;
      }
    }
    return "visible";
  }, selector);
  assert.equal(result, "visible", selector);
}
async function key(key) {
  await evaluate((key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ctrlKey: key !== "Escape" })), key);
  await delay();
}

app.whenReady().then(async () => {
  const { createServer } = await import("vite");
  server = await createServer({
    root: path.resolve(__dirname, ".."),
    // Worktrees share node_modules; their Vite optimizers must not share cache.
    cacheDir: path.join(profile, "vite-cache"),
    optimizeDeps: { entries: [path.resolve(__dirname, "../test/fixtures/window-layout.html")] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  const port = server.httpServer.address().port;
  for (const detached of [false, true]) {
    const geometry = windowGeometry(detached ? "layout-thread" : null);
    win = new BrowserWindow({ ...geometry, show: false, titleBarStyle: "hiddenInset", webPreferences: { offscreen: true, partition: `layout-${detached}`, contextIsolation: true, sandbox: true } });
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(`Renderer: ${event.message}`);
    });
    // Test the native minimum as well as the renderer viewport. Keep launch
    // sizes unchanged; explicitly resize each real BrowserWindow to its floor.
    win.setSize(geometry.minWidth, geometry.minHeight);
    assert.deepEqual(win.getSize(), [geometry.minWidth, geometry.minHeight]);
    for (const [width, height] of [[640, 480], [800, 480], [640, 700]]) {
      win.setSize(width, height);
      await win.loadURL(`http://127.0.0.1:${port}/test/fixtures/window-layout.html${detached ? "?thread=thread-2" : ""}`);
      await until(() => Boolean(document.querySelector("[data-composer-input]")), "composer");
      const name = `${detached ? "detached" : "main"}-${width}x${height}`;
      await visible("[data-composer-input]");
      await visible('[aria-label="Send"]');
      await visible('[data-drawer-open="agents"]');
      assert.equal(await evaluate(() => getComputedStyle(document.querySelector('[data-drawer-open="sidebar"]')).display === "none"), detached, "detached window hides Threads");
      if (process.platform === "darwin") {
        assert.equal(await evaluate(() => {
          const buttons = [...document.querySelectorAll('[data-narrow-chrome] button')].filter((el) => !el.hidden);
          return buttons.every((el) => el.getBoundingClientRect().left >= 84);
        }), true, "native traffic lights stay clear of toolbar controls");
      }
      if (await evaluate(() => Boolean(document.querySelector('[data-hero-project]')))) {
        await evaluate(() => document.querySelector('[data-hero-project]').click());
        await evaluate(() => [...document.querySelectorAll('[role="menu"][aria-label="Project"] [role="menuitem"]')].at(-1).scrollIntoView({ block: "nearest" }));
        await visible('[role="menu"][aria-label="Project"] [role="menuitem"]:last-child');
        await visible('[aria-label="Send"]');
        await evaluate(() => document.querySelector('[data-hero-project]').click());
      }
      if (!detached) {
        await evaluate(() => document.querySelector('[data-drawer-open="sidebar"]').click());
        await delay();
        await visible('[data-drawer="sidebar"] [title^="Settings"]');
        await evaluate(() => document.querySelector('[data-scrim="sidebar"]').click());
      }
      await shot(`${name}-composer`);

      await key("k");
      await until(() => Boolean(document.querySelector("[data-palette-mode]")), "settings command");
      await evaluate(() => [...document.querySelectorAll("[data-palette-index]")].find((el) => el.textContent.includes("Open settings")).click());
      await until(() => Boolean(document.querySelector("[data-settings]")), "settings");
      await visible('[data-settings] [aria-label="Close"]');
      await visible('[data-settings-search]');
      await shot(`${name}-settings-general`);
      // Every rendered General control must fit and be reachable by scrolling,
      // including fields at the bottom of this long pane.
      const controls = await evaluate(() => {
        for (const summary of document.querySelectorAll('[data-settings-pane="general"] details:not([open]) > summary')) summary.click();
        const controls = [...document.querySelectorAll('[data-settings-pane="general"] input, [data-settings-pane="general"] select, [data-settings-pane="general"] button, [data-settings-pane="general"] textarea')].filter((el) => el.checkVisibility());
        controls.forEach((el, i) => el.setAttribute("data-layout-setting-control", String(i)));
        return controls.length;
      });
      assert.ok(controls > 10, "dense General settings rendered");
      for (let i = 0; i < controls; i++) {
        await evaluate((i) => document.querySelector(`[data-layout-setting-control="${i}"]`).scrollIntoView({ block: "nearest", inline: "nearest" }), i);
        await visible(`[data-layout-setting-control="${i}"]`);
      }
      await visible('[data-settings] [aria-label="Close"]');
      await visible('[data-settings-search]');
      await shot(`${name}-settings-general-end`);
      // Exercise the combined folder-reuse controls and long model filename.
      await evaluate(() => document.querySelector('[data-speech-choose-folder]').scrollIntoView({ block: "center" }));
      await visible('[data-speech-choose-folder]');
      await visible('[data-speech-reset-location]');
      await visible('[data-settings] [aria-label="Close"]');
      await shot(`${name}-settings-speech`);
      // Navigate to the last section through its actual scrollable nav.
      await evaluate(() => {
        const items = document.querySelectorAll("[data-settings-nav]");
        items[items.length - 1].scrollIntoView({ block: "nearest", inline: "nearest" });
      });
      const last = await evaluate(() => [...document.querySelectorAll("[data-settings-nav]")].at(-1).dataset.settingsNav);
      await visible(`[data-settings-nav="${last}"]`);
      await evaluate((last) => document.querySelector(`[data-settings-nav="${last}"]`).click(), last);
      assert.equal(await evaluate(() => document.querySelector('[data-settings-pane]').dataset.settingsPane), last);
      await shot(`${name}-settings`);
      await evaluate(() => document.querySelector('[data-settings] [aria-label="Close"]').click());

      await key("k");
      await until(() => Boolean(document.querySelector("[data-palette-mode]")), "palette");
      await visible("[data-palette-mode] input");
      await evaluate(() => {
        const rows = document.querySelectorAll("[data-palette-index]");
        rows[rows.length - 1].scrollIntoView({ block: "nearest" });
      });
      const lastIndex = await evaluate(() => [...document.querySelectorAll("[data-palette-index]")].at(-1).dataset.paletteIndex);
      await visible(`[data-palette-index="${lastIndex}"]`);
      await shot(`${name}-palette`);
      await key("Escape");
      await delay();

      await evaluate(() => window.layoutFixture.approval());
      await until(() => Boolean(document.querySelector("[data-permission-card]")), "approval");
      await evaluate(() => document.querySelector('[data-permission-card] [aria-keyshortcuts="n"]').scrollIntoView({ block: "nearest" }));
      await visible('[data-permission-card] [aria-keyshortcuts="y"]');
      await visible('[data-permission-card] [aria-keyshortcuts="n"]');
      await visible('[aria-label="Send"]');
      await shot(`${name}-approval`);
      console.log(`${name} (content ${win.getContentSize().join("x")}): composer, all General controls, settings navigation, palette results and tall approval reachable`);
    }
    win.destroy();
    win = null;
  }
}).catch(async (err) => {
  if (win && !win.isDestroyed() && output) fs.writeFileSync(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy();
  if (server) await server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
