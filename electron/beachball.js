"use strict";

/**
 * End-to-end beachball check for issue #124. Scratch harness, not committed.
 *
 *   ./node_modules/.bin/electron /tmp/beachball.js [threads] [seconds]
 *
 * Reproduces the issue's own repro against the REAL stack — real Electron main
 * process, real Store, real runner, real registerIpc, real preload bridge in a
 * real BrowserWindow:
 *
 *   1. Open N threads in one project.
 *   2. Start runs in all of them at once (CODER_SIMULATE=1, so free).
 *   3. Interact with the app while runs stream — the Git tab (git:diff,
 *      git:status, git:syncInfo) and @-mention autocomplete (files:list),
 *      driven from the renderer over real IPC.
 *
 * Meanwhile the MAIN process measures its own event-loop lag with the same
 * perf_hooks histogram the shipped CODER_LOOP_LAG probe uses, plus a 10ms
 * heartbeat. Missed heartbeats are the beachball: while the loop is blocked,
 * no window paints and no agent stream is serviced.
 *
 * Modelled on electron/smoke.js (same fake/simulated run plumbing).
 *
 * Needs dist/index.html and core/dist: `npm run build && (cd core && npm run build)`.
 *
 * Reference numbers on an M-series laptop, 4 threads / 15s, ~596 git IPC calls:
 *   before #124: lag p99 63.4ms, STARVED 60.4%
 *   after  #124: lag p99  2.0ms, STARVED  3.5%
 * A regression shows up as STARVED climbing back into the tens of percent.
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const REPO = process.env.BEACHBALL_REPO || path.resolve(__dirname, "..");
const THREADS = Number(process.env.BEACHBALL_THREADS || 4);
const SECONDS = Number(process.env.BEACHBALL_SECONDS || 12);

const { Store } = require(path.join(REPO, "electron", "store.js"));
const { createRunner } = require(path.join(REPO, "electron", "runner.js"));
const { registerIpc } = require(path.join(REPO, "electron", "ipc.js"));

function ms(ns) {
  return Number(ns) / 1e6;
}

/** Evaluate an expression in the renderer and return its resolved value. */
async function evalInRenderer(wc, expr) {
  return wc.executeJavaScript(`(async () => { return ${expr}; })()`, true);
}

async function waitForCoder(wc) {
  for (let i = 0; i < 200; i++) {
    const ok = await wc
      .executeJavaScript("!!(window.coder && window.coder.projects)", true)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("window.coder never appeared");
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "beachball-"));
  app.setPath("userData", userData);

  const store = new Store(path.join(userData, "coder-store.json"));
  const core = require(path.join(REPO, "core", "dist", "index.js"));
  const worktreeBase = path.join(userData, "worktrees");

  function broadcast(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  const runner = createRunner({
    store,
    core,
    pushFn: (channel, payload) => broadcast(channel, payload),
    tickMs: 120, // brisk streaming: many IPC ticks, like a real busy run
  });

  registerIpc({
    ipcMain,
    dialog,
    store,
    runner,
    broadcast,
    worktreeBase,
    userDataPath: userData,
  });

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(REPO, "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadFile(path.join(REPO, "dist", "index.html"));
  await waitForCoder(win.webContents);
  const wc = win.webContents;

  // ── set up: one project, N threads ────────────────────────────────
  const project = await evalInRenderer(
    wc,
    `window.coder.projects.add(${JSON.stringify(REPO)})`,
  );
  if (!project || !project.id) {
    throw new Error(`projects.add failed: ${JSON.stringify(project)}`);
  }

  const threads = [];
  for (let i = 0; i < THREADS; i++) {
    const t = await evalInRenderer(
      wc,
      `window.coder.threads.create({ projectId: ${JSON.stringify(project.id)}, title: ${JSON.stringify(`load ${i + 1}`)} })`,
    );
    threads.push(t);
  }
  console.log(
    `[setup] project=${project.id} threads=${threads.length} repo=${REPO}`,
  );

  // Simulated provider: free, no network, no CLI. Runner reads this per run.
  process.env.CODER_SIMULATE = "1";

  // ── measure ───────────────────────────────────────────────────────
  const h = monitorEventLoopDelay({ resolution: 1 });
  let beats = 0;
  h.enable();
  const beat = setInterval(() => {
    beats++;
  }, 10);

  const t0 = Date.now();

  // Start runs in ALL threads at once (step 2 of the repro).
  await Promise.all(
    threads.map((t) =>
      evalInRenderer(
        wc,
        `window.coder.runs.start({ threadId: ${JSON.stringify(t.id)}, prompt: "stream for a while please" })`,
      ).catch((e) => console.log(`[start] ${t.id} ${e.message}`)),
    ),
  );
  console.log(`[runs] ${threads.length} started concurrently`);

  // Simulated runs are short; restart any that finish so streaming genuinely
  // overlaps the whole measurement window (the issue is about SUSTAINED
  // concurrency, not one burst).
  let restarts = 0;
  const keepStreaming = setInterval(() => {
    for (const t of threads) {
      if (!runner.isRunning(t.id)) {
        restarts++;
        evalInRenderer(
          wc,
          `window.coder.runs.start({ threadId: ${JSON.stringify(t.id)}, prompt: "keep streaming" })`,
        ).catch(() => {});
      }
    }
  }, 250);

  // Step 3: interact with the app while runs stream. Each of these is a real
  // IPC round trip into the handlers this issue was about.
  let gitCalls = 0;
  let errors = 0;
  const interact = setInterval(() => {
    const t = threads[gitCalls % threads.length];
    const calls = [
      `window.coder.git.diff({ threadId: ${JSON.stringify(t.id)} })`,
      `window.coder.git.status(${JSON.stringify(project.id)})`,
      `window.coder.files.list({ threadId: ${JSON.stringify(t.id)}, query: "elec" })`,
      `window.coder.git.syncInfo({ threadId: ${JSON.stringify(t.id)} })`,
    ];
    for (const c of calls) {
      gitCalls++;
      evalInRenderer(wc, c).catch(() => {
        errors++;
      });
    }
  }, 100);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));

  clearInterval(interact);
  clearInterval(keepStreaming);
  clearInterval(beat);
  h.disable();
  const wall = Date.now() - t0;

  const running = threads.filter((t) => runner.isRunning(t.id)).length;
  const expected = Math.floor(wall / 10);
  const starved = expected > 0 ? 100 * (1 - beats / expected) : 0;

  console.log("\n──────── main-process event loop, under load ────────");
  console.log(`concurrent runs      : ${threads.length} (${running} streaming at end, ${restarts} restarts)`);
  console.log(`git/files IPC calls  : ${gitCalls} (${errors} errored)`);
  console.log(`wall                 : ${wall}ms`);
  console.log(`lag p50              : ${ms(h.percentile(50)).toFixed(1)}ms`);
  console.log(`lag p99              : ${ms(h.percentile(99)).toFixed(1)}ms`);
  console.log(`lag max              : ${ms(h.max).toFixed(1)}ms`);
  console.log(`heartbeats           : ${beats}/${expected}`);
  console.log(`STARVED              : ${starved.toFixed(1)}%`);
  console.log("────────────────────────────────────────────────────");
  console.log(
    "starved = share of 10ms heartbeats the main loop missed.\n" +
      "A beachball is a sustained run of missed heartbeats.",
  );

  try {
    runner.stopAll();
  } catch {
    /* best effort */
  }
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("HARNESS FAILED:", err);
    app.exit(1);
  }),
);
