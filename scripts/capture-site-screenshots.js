// Capture the four public website screenshots from deterministic browser fixtures.
// Usage:
//   VITE_TRAILER=1 npm run dev:browser
//   npx electron scripts/capture-site-screenshots.js
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_SCREENSHOT_URL || "http://localhost:5173";
const OUT = path.join(__dirname, "..", "site", "assets");
const WIDTH = 1680;
const HEIGHT = 1050;
const THREAD_ID = "thread-1";

app.commandLine.appendSwitch("force-device-scale-factor", "1");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(win, source) {
  return win.webContents.executeJavaScript(source);
}

async function waitFor(win, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await run(win, `Boolean(${expression})`)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function click(win, selector, label) {
  const clicked = await run(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`could not click ${label}`);
  await sleep(250);
}

async function clickTab(win, label) {
  const clicked = await run(
    win,
    `(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent.trim() === ${JSON.stringify(label)} &&
          candidate.hasAttribute("data-active") &&
          !candidate.hasAttribute("data-drawer-open")
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`could not click ${label} tab`);
  await waitFor(
    win,
    `[...document.querySelectorAll("button")].some((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)} && candidate.getAttribute("data-active") === "true")`,
    `${label} tab active`,
  );
  await sleep(250);
}

async function selectThread(win) {
  await click(
    win,
    `[data-thread-card="${THREAD_ID}"] button`,
    `thread ${THREAD_ID}`,
  );
  await waitFor(
    win,
    `document.body.textContent.includes("Modernize Per-Device Provider Settings")`,
    "selected seeded thread",
  );
}

async function forceLightTheme(win) {
  await run(
    win,
    `document.documentElement.setAttribute("data-theme", "light");
     document.documentElement.style.colorScheme = "light";
     localStorage.setItem("solenta-theme", "light");
     "ok"`,
  );
  await waitFor(
    win,
    `document.documentElement.getAttribute("data-theme") === "light" && getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#f3f5f8"`,
    "light theme tokens",
  );
}

async function dismissOnboarding(win) {
  const skipped = await run(
    win,
    `(() => {
      const el = document.querySelector("[data-onboarding-skip]");
      if (!el) return false;
      el.click();
      return true;
    })()`,
  );
  if (!skipped) return;
  await waitFor(
    win,
    `!document.querySelector("[data-onboarding]")`,
    "onboarding dismissed",
  );
}

async function freezeFixture(win) {
  await run(
    win,
    `(() => {
      const highest = setInterval(() => {}, 1e9);
      for (let i = 1; i <= highest; i++) {
        clearInterval(i);
        clearTimeout(i);
      }
      return "frozen";
    })()`,
  );
}

async function pinUserPrompt(win) {
  const pinned = await run(
    win,
    `(() => {
      const body = document.querySelector("[data-thread-body]");
      const header = document.querySelector("[data-thread-header]");
      if (!body) return "no-body";
      const bubble = [...body.querySelectorAll("[class*='userBubble']")].find((el) =>
        (el.textContent || "").includes("Modernize per-device provider settings storage"),
      );
      if (!bubble) return "no-bubble";
      const pad = parseFloat(getComputedStyle(body).paddingTop) || 24;
      const bodyRect = body.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      body.scrollTop += bubbleRect.top - bodyRect.top - pad;
      const after = bubble.getBoundingClientRect();
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      if (after.top < headerBottom + 4) return "overlap";
      if (after.bottom > body.getBoundingClientRect().bottom) return "clipped";
      return "ok";
    })()`,
  );
  if (pinned !== "ok") throw new Error(`could not pin seeded user prompt (${pinned})`);
}

async function capture(win, name, expectedSelector) {
  await waitFor(win, `document.querySelector(${JSON.stringify(expectedSelector)})`, name);
  await forceLightTheme(win);
  await run(
    win,
    `document.activeElement && document.activeElement.blur();
     for (const el of document.querySelectorAll("[title]")) el.removeAttribute("title");
     for (const el of document.querySelectorAll("[role='tooltip']")) el.remove();
     "ok"`,
  );
  win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
  await run(win, `document.fonts && document.fonts.ready`);
  await sleep(400);
  let image = await win.webContents.capturePage();
  const size = image.getSize();
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    image = image.resize({ width: WIDTH, height: HEIGHT, quality: "best" });
  }
  const target = path.join(OUT, name);
  fs.writeFileSync(target, image.toPNG());
  const written = image.getSize();
  if (written.width !== WIDTH || written.height !== HEIGHT) {
    throw new Error(`${name}: wrote ${written.width}x${written.height}`);
  }
  console.log(`wrote ${target}`);
}

async function prepare(win) {
  await win.loadURL(URL);
  await run(
    win,
    `localStorage.setItem("solenta-theme", "light"); location.reload(); "reloading"`,
  );
  await waitFor(
    win,
    `document.documentElement.getAttribute("data-theme") === "light"`,
    "light theme",
  );
  await run(win, `document.querySelector("[data-web-token-gate]")?.remove(); "ok"`);
  await waitFor(win, `document.querySelector("[data-thread-card]")`, "fixture threads");
  // settings.get() hydrates after first paint and overwrites localStorage
  // with the fixture default (dark + onboardingSeen=false).
  await dismissOnboarding(win);
  await forceLightTheme(win);
  await selectThread(win);
  await waitFor(
    win,
    `document.body.textContent.includes("Kicked off 5 subagents") && document.body.textContent.includes("Work Log") && document.body.textContent.includes("Modernize per-device provider settings storage.")`,
    "stable seeded transcript",
  );
  await freezeFixture(win);
  await pinUserPrompt(win);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    backgroundColor: "#f3f5f8",
    webPreferences: {
      offscreen: true,
      partition: `site-shots-${Date.now()}`,
    },
  });

  try {
    await prepare(win);

    await clickTab(win, "Environment");
    await pinUserPrompt(win);
    await capture(win, "screen-main.png", `[data-thread-card="${THREAD_ID}"]`);

    await clickTab(win, "Agents");
    await pinUserPrompt(win);
    await capture(win, "screen-agents.png", "[data-crew-tasks]");

    await click(win, "[data-panel-tab='pulse']", "Pulse tab");
    await click(win, "[data-view-nav='automations']", "Automations");
    await clickTab(win, "Environment");
    await capture(win, "screen-automations.png", "[data-automations]");

    await click(win, "[data-view-nav='kanban']", "Kanban");
    await clickTab(win, "Environment");
    await capture(win, "screen-kanban.png", "[data-kanban]");
  } catch (error) {
    console.error("site screenshot capture failed:", error?.stack || error);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
