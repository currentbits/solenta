// Record a feature tour of the app with AppVideo, driving the real cursor.
//
// Usage:
//   npx vite --port 5173 --strictPort          # dev build, devCoder mock data
//   npx electron scripts/demo-video.js
//
// Why one script owns both halves: AppVideo records the real screen and moves
// the real pointer, so every click needs a *screen* coordinate, and the only
// honest source for those is the live element rect plus the window's current
// position. Splitting the recorder from the window would mean guessing one of
// them. Here the same process asks the page where a button is and tells the
// recorder where to click.
//
// The tour is written as selectors, not coordinates, so it survives a layout
// change or a different window size.
"use strict";

const { app, BrowserWindow, screen } = require("electron");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");

const URL = process.env.DEMO_URL || "http://localhost:5173";
const MCP =
  process.env.APPVIDEO_MCP ||
  "/Users/willem/code/AppVideo/target/release/appvideo-mcp";
const WIDTH = 1440;
const HEIGHT = 840;
// Walk the tour with synthetic clicks and no recorder, to check the selectors
// still resolve before a real take takes over the machine's pointer.
const DRY = process.env.DEMO_DRY === "1";
// Whether a posted mouse click operates the UI — decided by probing, not by a
// flag, because the honest answer changes without anyone touching this repo.
//
// Two separate things can go wrong and they look identical from here. Posting
// a click at all needs an Accessibility grant, which macOS attributes to the
// responsible process (the app that launched the run, not appvideo-mcp — its
// entry is never read). And even with the grant, the posted event carries no
// click state, so Chromium raises pointerdown and stops: the window gets the
// event at the right coordinates and does nothing with it.
//
// Neither failure stops the cursor moving, so getting this wrong records 90s
// of a pointer drifting over a screen that never changed rather than failing.
let realClicks = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- MCP client */

// Newline-delimited JSON-RPC on stdio, one in-flight call at a time — the tour
// is strictly sequential and move_path blocks the server anyway.
function connect(bin) {
  const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let nextId = 1;

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray output is not ours to interpret
    }
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg);
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return {
    proc,
    async call(name, args = {}) {
      const msg = await send("tools/call", { name, arguments: args });
      const text = msg?.result?.content?.[0]?.text ?? "";
      if (msg?.result?.isError) throw new Error(`${name}: ${text}`);
      return text;
    },
    init: () =>
      send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "solenta-demo", version: "1" },
      }),
  };
}

/* -------------------------------------------------------------------- the page */

// Resolve a step to a rect in CSS pixels. Kept in one place so every step has
// the same lookup rules: explicit selector, aria-label, or visible text.
const RESOLVE = (spec) => `
  (() => {
    const spec = ${JSON.stringify(spec)};
    const scope = spec.within ? document.querySelector(spec.within) : document;
    if (!scope) return null;
    let el = null;
    if (spec.sel) el = scope.querySelector(spec.sel);
    else if (spec.aria) el = scope.querySelector('[aria-label=' + JSON.stringify(spec.aria) + ']');
    else if (spec.text) {
      el = [...scope.querySelectorAll(spec.tag || "button")].find(
        (b) => (b.textContent || "").trim() === spec.text,
      );
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`;

// Dry runs write a frame per step, so a tour that "resolved every selector"
// can still be checked against what it actually opened.
let shotN = 0;
async function shot(win, note) {
  if (!DRY) return;
  const img = await win.webContents.capturePage();
  const name = `${String(++shotN).padStart(2, "0")}-${(note || "step").replace(/\W+/g, "-")}.png`;
  require("node:fs").writeFileSync(path.join("/tmp/solenta-demo", name), img.toPNG());
}

/**
 * Does a posted click press anything? Click the composer for real and ask the
 * page whether focus moved.
 *
 * Focus is the cheapest unambiguous answer available: it needs no knowledge of
 * what any control does, it cannot be faked by the run's own streaming
 * updates, and it undoes itself. Anything richer would be reading the app's
 * behaviour to test the operating system's.
 */
async function canClickForReal(win, av) {
  const rect = await win.webContents.executeJavaScript(
    RESOLVE({ sel: '[data-pane="thread"] textarea' }),
  );
  if (!rect) return false;
  const b = win.getContentBounds();
  await av.call("click", { x: b.x + rect.x, y: b.y + rect.y });
  await sleep(300);
  const focused = await win.webContents.executeJavaScript(
    `document.activeElement?.tagName === "TEXTAREA"`,
  );
  await win.webContents.executeJavaScript(`document.activeElement?.blur()`);
  return Boolean(focused);
}

async function waitForApp(win) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript(`
      (() => {
        document.querySelector("[data-web-token-gate]")?.remove();
        return Boolean(document.querySelector("[data-thread-card]"));
      })()`);
    if (ready) return;
    await sleep(150);
  }
  throw new Error("the UI never rendered a thread card");
}

/* ---------------------------------------------------------------------- tour */

// Read-only steps only. Nothing here settles, snoozes, archives or removes —
// the mock store is in-memory, but a demo that mutates its own set dressing
// records worse on the second take.
const TOUR = [
  { dwell: 3000, note: "live thread: work log streaming" },

  // Orchestration first: the fan-out is only live for the run's first ~30s.
  { text: "Agents", within: '[data-pane="agents"]', dwell: 1500, note: "orchestration" },
  { expandPhases: true, dwell: 10000, note: "fan-out across phases" },

  { text: "Memory", within: '[data-pane="agents"]', dwell: 3500, note: "memory" },
  { text: "Skills", within: '[data-pane="agents"]', dwell: 3500, note: "skills" },
  { text: "Environment", within: '[data-pane="agents"]', dwell: 2500, note: "environment" },
  { text: "View changes", within: '[data-pane="agents"]', dwell: 5000, note: "diff" },
  // Escape does not close this panel — it has its own control, and leaving it
  // open buries every later step under a diff.
  { text: "Close", within: '[data-pane="thread"]', dwell: 800, note: "close diff" },

  { sel: '[data-thread-card="thread-2"] button', dwell: 4000, note: "another thread" },
  { sel: '[data-view-nav="kanban"]', dwell: 4000, note: "kanban" },
  { sel: '[data-view-nav="planboard"]', dwell: 4000, note: "planboard" },
  { sel: '[data-view-nav="prs"]', dwell: 4000, note: "pull requests" },
  { sel: '[data-view-nav="automations"]', dwell: 4000, note: "automations" },
  { sel: '[data-view-nav="activity"]', dwell: 4000, note: "activity" },
  { sel: '[data-thread-card="thread-1"] button', dwell: 2500, note: "back to the run" },

  // Best of N stays disabled until the composer has a prompt, so type one.
  { sel: '[data-pane="thread"] textarea', dwell: 400, note: "composer" },
  { type: "Add per-device provider overrides, with a migration", dwell: 1200 },
  { aria: "Choose workflow template", dwell: 1500, note: "workflow picker" },
  { text: "Manage workflows…", dwell: 5000, note: "workflow templates" },
  { escape: true, dwell: 900 },
  { aria: "Best of N", dwell: 4500, note: "best of N" },
  { escape: true, dwell: 1500 },
];

async function run(win, av) {
  let cursor = null; // last screen point, so paths start where the cursor is

  for (const step of TOUR) {
    if (step.escape) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await sleep(step.dwell);
      continue;
    }

    if (step.type) {
      // Real keystrokes into the focused composer: React owns the value, so
      // setting it directly would leave the component's state behind.
      for (const ch of step.type) {
        win.webContents.sendInputEvent({ type: "char", keyCode: ch });
        await sleep(28);
      }
      await sleep(step.dwell);
      await shot(win, "typed");
      continue;
    }

    if (step.expandPhases) {
      // Phase groups collapse by default; open them so the fan-out is visible.
      await win.webContents.executeJavaScript(`
        (() => {
          for (const b of document.querySelectorAll("button[aria-expanded='false']")) b.click();
          return true;
        })()`);
      await sleep(step.dwell);
      continue;
    }

    if (step.dwell && !step.sel && !step.text && !step.aria) {
      await sleep(step.dwell);
      continue;
    }

    const rect = await win.webContents.executeJavaScript(RESOLVE(step));
    if (!rect) {
      console.warn("skip (not found):", step.note || JSON.stringify(step));
      continue;
    }

    // Screen coordinates are only valid against the window's position *now*.
    const b = win.getContentBounds();
    const target = { x: b.x + rect.x, y: b.y + rect.y };

    // A click outside the window would land on whatever else is on screen.
    // Refuse rather than let a stale rect drive the real pointer somewhere else.
    if (
      target.x < b.x ||
      target.x > b.x + b.width ||
      target.y < b.y ||
      target.y > b.y + b.height
    ) {
      console.warn("skip (outside window):", step.note, target);
      continue;
    }

    if (DRY) {
      // Prove every selector resolves without handing the real pointer over.
      win.webContents.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      console.log("·", step.note || JSON.stringify(step), "->", Math.round(rect.x), Math.round(rect.y));
      await sleep(700);
      await shot(win, step.note);
      continue;
    }

    if (cursor) {
      // Slight arc: a straight line between two buttons reads as a teleport
      // even when it is eased.
      const mid = {
        x: (cursor.x + target.x) / 2 + (target.y - cursor.y) * 0.08,
        y: (cursor.y + target.y) / 2 - (target.x - cursor.x) * 0.08,
      };
      await av.call("move_path", {
        points: [
          [cursor.x, cursor.y],
          [mid.x, mid.y],
          [target.x, target.y],
        ],
        duration_ms: 700,
      });
    } else {
      await av.call("move_cursor", target);
    }
    await sleep(180);
    // Always post the real click: the recorder's tap logs it, and every zoom
    // window in the export is derived from one. It costs nothing when the UI
    // ignores it.
    await av.call("click", {});
    if (!realClicks) {
      const opts = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
      win.webContents.sendInputEvent({ type: "mouseDown", ...opts });
      win.webContents.sendInputEvent({ type: "mouseUp", ...opts });
    }
    cursor = target;
    console.log("·", step.note || JSON.stringify(step));
    await sleep(step.dwell ?? 1500);
  }
}

/* ---------------------------------------------------------------------- main */

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: area.x + Math.round((area.width - WIDTH) / 2),
    y: area.y + Math.max(0, Math.round((area.height - HEIGHT) / 2)),
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    backgroundColor: "#0b0e14",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    title: "Solenta Demo",
    webPreferences: { partition: `demo-${Date.now()}` },
  });
  // The recorder finds the window by title; the page must not rename it.
  win.on("page-title-updated", (e) => e.preventDefault());

  const av = DRY ? null : connect(MCP);
  let dir = null;

  try {
    await win.loadURL(URL);
    await waitForApp(win);
    win.setTitle("Solenta Demo");
    // Clicks are real OS events: they go to whatever is frontmost.
    win.setAlwaysOnTop(true, "screen-saver");
    win.focus();
    await sleep(1200);

    if (DRY) {
      await run(win, null);
      app.quit();
      return;
    }

    await av.init();
    const targets = await av.call("list_targets");
    const line = targets
      .split("\n")
      .find((l) => l.includes("— Solenta Demo"));
    if (!line) throw new Error("recorder cannot see the demo window");
    const target = line.trim().split(" ")[0];
    console.log("recording", target);

    // Before the take: a lost grant is worth one probe, not a wasted 90s.
    realClicks = await canClickForReal(win, av);
    console.log(
      realClicks
        ? "posted clicks operate the UI"
        : "posted clicks reach the window but do not operate it — driving the UI in-page as well",
    );

    const started = await av.call("start_recording", { target });
    dir = started.match(/recording into (.+)$/m)?.[1]?.trim() ?? null;
    await sleep(1000);

    await run(win, av);

    await sleep(1200);
    const stopped = await av.call("stop_recording", { render: false });
    console.log(stopped);
    dir = stopped.match(/session at (.+)$/m)?.[1]?.trim() ?? dir;

    const out = await av.call("render", {
      dir,
      background: "indigo",
      zoom_max: 1.6,
      motion_blur: 0.4,
      max_height: 1080,
    });
    console.log(out);
  } catch (err) {
    console.error("demo failed:", err?.message ?? err);
    process.exitCode = 1;
    try {
      if (dir && av) console.error(await av.call("stop_recording", { render: false }));
    } catch {}
  } finally {
    av?.proc.kill();
    app.quit();
  }
});
