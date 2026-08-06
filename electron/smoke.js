"use strict";

/**
 * Scripted end-to-end smoke of the real preload bridge (window.coder).
 * Run with the real Electron binary (not node):
 *   ./node_modules/.bin/electron electron/smoke.js
 *
 * Uses a temp userData path so it never touches real app state.
 * Expects dist/index.html (run `npx vite build` first) and core/dist.
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { Store } = require("./store.js");
const { createRunner } = require("./runner.js");
const { registerIpc } = require("./ipc.js");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "coder-smoke-"));
app.setPath("userData", userData);

function logStep(step, data) {
  console.log(JSON.stringify({ step, ...data }));
}

function fail(step, err) {
  const message = err && err.message ? err.message : String(err);
  console.error(JSON.stringify({ step, ok: false, error: message }));
  app.exit(1);
}

function assertCoreBuilt() {
  const coreIndex = path.join(__dirname, "../core/dist/index.js");
  if (!fs.existsSync(coreIndex)) {
    throw new Error(
      "Missing core/dist. Build with: cd core && npm install && npm run build",
    );
  }
  return coreIndex;
}

function assertDistBuilt() {
  const indexHtml = path.join(__dirname, "../dist/index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      "Missing dist/index.html. Build with: npx vite build",
    );
  }
  return indexHtml;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import('electron').WebContents} webContents
 * @param {string} expression async-capable JS expression in the renderer
 */
function evalInRenderer(webContents, expression) {
  return webContents.executeJavaScript(expression, true);
}

app
  .whenReady()
  .then(async () => {
    const coreIndex = assertCoreBuilt();
    const distIndex = assertDistBuilt();
    const core = await import(pathToFileURL(coreIndex).href);

    const store = new Store(path.join(app.getPath("userData"), "coder-store.json"));

    function broadcast(channel, payload) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    }

    const runner = createRunner({
      store,
      core,
      pushFn: (channel, payload) => broadcast(channel, payload),
      tickMs: 700,
    });

    registerIpc({
      ipcMain,
      dialog,
      store,
      runner,
      broadcast,
    });

    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    await win.loadFile(distIndex);

    // Wait until preload has exposed window.coder
    await waitForCoder(win.webContents);

    const projectPath = process.cwd();

    // (1) projects.add
    const project = await evalInRenderer(
      win.webContents,
      `window.coder.projects.add(${JSON.stringify(projectPath)})`,
    );
    if (!project || !project.id || !project.path) {
      throw new Error(`projects.add returned unexpected: ${JSON.stringify(project)}`);
    }
    logStep("projects.add", { ok: true, project });

    // (2) threads.create
    const thread = await evalInRenderer(
      win.webContents,
      `window.coder.threads.create(${JSON.stringify({
        projectId: project.id,
        title: "New Thread",
      })})`,
    );
    if (!thread || !thread.id) {
      throw new Error(`threads.create returned unexpected: ${JSON.stringify(thread)}`);
    }
    logStep("threads.create", { ok: true, thread });

    // (3) runs.start
    const started = await evalInRenderer(
      win.webContents,
      `window.coder.runs.start(${JSON.stringify({
        threadId: thread.id,
        prompt: "Smoke test prompt for workflow",
      })})`,
    );
    if (!started || !started.workflowId) {
      throw new Error(`runs.start returned unexpected: ${JSON.stringify(started)}`);
    }
    logStep("runs.start", { ok: true, started });

    // (4) wait ~3s, threads.get → working + 13 agents
    await sleep(3000);
    const workingDetail = await evalInRenderer(
      win.webContents,
      `window.coder.threads.get(${JSON.stringify(thread.id)})`,
    );
    if (!workingDetail || workingDetail.thread.status !== "working") {
      throw new Error(
        `expected status working after ~3s, got ${JSON.stringify({
          status: workingDetail && workingDetail.thread && workingDetail.thread.status,
        })}`,
      );
    }
    if (!workingDetail.workflow) {
      throw new Error("expected non-null workflow while working");
    }
    if (workingDetail.workflow.total !== 13) {
      throw new Error(
        `expected workflow.total === 13, got ${workingDetail.workflow.total}`,
      );
    }
    logStep("threads.get.working", {
      ok: true,
      status: workingDetail.thread.status,
      workflowTotal: workingDetail.workflow.total,
      workflowName: workingDetail.workflow.name,
      settled: workingDetail.workflow.settled,
    });

    // (5) runs.stop
    await evalInRenderer(
      win.webContents,
      `window.coder.runs.stop(${JSON.stringify({ threadId: thread.id })})`,
    );
    logStep("runs.stop", { ok: true });

    // (6) threads.get → idle + Run stopped event
    const idleDetail = await evalInRenderer(
      win.webContents,
      `window.coder.threads.get(${JSON.stringify(thread.id)})`,
    );
    if (!idleDetail || idleDetail.thread.status !== "idle") {
      throw new Error(
        `expected status idle after stop, got ${JSON.stringify(
          idleDetail && idleDetail.thread && idleDetail.thread.status,
        )}`,
      );
    }
    const hasStopped = (idleDetail.messages || []).some(
      (m) => m.role === "event" && /Run stopped/i.test(m.text),
    );
    if (!hasStopped) {
      throw new Error(
        `expected "Run stopped" event message, messages=${JSON.stringify(
          idleDetail.messages,
        )}`,
      );
    }
    logStep("threads.get.idle", {
      ok: true,
      status: idleDetail.thread.status,
      hasRunStoppedEvent: true,
      messageCount: idleDetail.messages.length,
    });

    logStep("smoke", { ok: true });
    app.exit(0);
  })
  .catch((err) => {
    fail("smoke", err);
  });

/**
 * @param {import('electron').WebContents} webContents
 */
async function waitForCoder(webContents) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const ready = await webContents.executeJavaScript(
        `typeof window.coder === "object" && window.coder !== null && typeof window.coder.projects?.add === "function"`,
        true,
      );
      if (ready) return;
    } catch {
      // page may still be loading
    }
    await sleep(50);
  }
  throw new Error("window.coder never became available in the renderer");
}
