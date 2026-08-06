"use strict";

/**
 * Scripted end-to-end smoke of the real preload bridge (window.coder).
 * Run with the real Electron binary (not node):
 *   ./node_modules/.bin/electron electron/smoke.js
 *
 * Two passes in one invocation:
 *   A) CODER_SIMULATE=1 — simulated core ticker, new work-log shape
 *   B) CODER_AGENT_CMD = fake node -e agent — real spawn path to done
 *
 * Uses a temp userData path so it never touches real app state.
 * Expects dist/index.html (run `npx vite build` first) and core/dist.
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { Store } = require("./store.js");
const { createRunner } = require("./runner.js");
const { registerIpc } = require("./ipc.js");

/**
 * Resolve a Node binary whose path has no whitespace.
 * CODER_AGENT_CMD is split on spaces, so process.execPath under Electron
 * (…/Application Support/…) cannot be used as the command token.
 */
function resolveNodeBinary() {
  const candidates = [];
  try {
    const which = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    if (which) candidates.push(which);
  } catch {
    // ignore
  }
  candidates.push(
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    process.execPath,
  );
  for (const c of candidates) {
    if (c && !/\s/.test(c) && fs.existsSync(c)) return c;
  }
  throw new Error(
    "No space-free node binary found for CODER_AGENT_CMD fake agent",
  );
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "coder-smoke-"));
app.setPath("userData", userData);

/** Known string emitted by the pass-B fake agent (no spaces: CODER_AGENT_CMD split). */
const FAKE_AGENT_MARKER = "SMOKE_AGENT_OK";

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

/**
 * Assert new work-log shape: no "… started"/"… settled" labels; every item has runId.
 * @param {Array<{label: string, runId?: string, done: boolean}>} workLog
 * @param {string} [runId]
 */
function assertWorkLogShape(workLog, runId) {
  if (!Array.isArray(workLog)) {
    throw new Error("workLog is not an array");
  }
  for (const item of workLog) {
    if (!item.runId) {
      throw new Error(`work log item missing runId: ${JSON.stringify(item)}`);
    }
    if (runId && item.runId !== runId) {
      throw new Error(
        `work log runId mismatch: expected ${runId}, got ${item.runId}`,
      );
    }
    if (/ started$/i.test(item.label)) {
      throw new Error(`legacy "started" label: ${item.label}`);
    }
    if (/ settled$/i.test(item.label)) {
      throw new Error(`legacy "settled" label: ${item.label}`);
    }
  }
}

/**
 * @param {import('electron').WebContents} webContents
 * @param {string} projectId
 * @param {string} title
 */
async function createThread(webContents, projectId, title) {
  const thread = await evalInRenderer(
    webContents,
    `window.coder.threads.create(${JSON.stringify({ projectId, title })})`,
  );
  if (!thread || !thread.id) {
    throw new Error(`threads.create returned unexpected: ${JSON.stringify(thread)}`);
  }
  return thread;
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

    // Runner reads CODER_SIMULATE / CODER_AGENT_CMD at each startRun.
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
    await waitForCoder(win.webContents);

    const projectPath = process.cwd();

    // ── shared: projects.add ──────────────────────────────────────────
    const project = await evalInRenderer(
      win.webContents,
      `window.coder.projects.add(${JSON.stringify(projectPath)})`,
    );
    if (!project || !project.id || !project.path) {
      throw new Error(`projects.add returned unexpected: ${JSON.stringify(project)}`);
    }
    logStep("projects.add", { ok: true, project });

    // ── Pass A: simulated mode ────────────────────────────────────────
    process.env.CODER_SIMULATE = "1";
    delete process.env.CODER_AGENT_CMD;

    const threadA = await createThread(win.webContents, project.id, "New Thread");
    logStep("passA.threads.create", { ok: true, threadId: threadA.id });

    const startedA = await evalInRenderer(
      win.webContents,
      `window.coder.runs.start(${JSON.stringify({
        threadId: threadA.id,
        prompt: "Smoke test prompt for workflow",
      })})`,
    );
    if (!startedA || !startedA.workflowId) {
      throw new Error(`passA runs.start unexpected: ${JSON.stringify(startedA)}`);
    }
    logStep("passA.runs.start", { ok: true, started: startedA });

    await sleep(3000);
    const workingDetail = await evalInRenderer(
      win.webContents,
      `window.coder.threads.get(${JSON.stringify(threadA.id)})`,
    );
    if (!workingDetail || workingDetail.thread.status !== "working") {
      throw new Error(
        `passA expected status working after ~3s, got ${JSON.stringify({
          status: workingDetail && workingDetail.thread && workingDetail.thread.status,
        })}`,
      );
    }
    if (!workingDetail.workflow) {
      throw new Error("passA expected non-null workflow while working");
    }
    if (workingDetail.workflow.total !== 13) {
      throw new Error(
        `passA expected workflow.total === 13, got ${workingDetail.workflow.total}`,
      );
    }
    assertWorkLogShape(workingDetail.workLog, startedA.workflowId);
    logStep("passA.threads.get.working", {
      ok: true,
      status: workingDetail.thread.status,
      workflowTotal: workingDetail.workflow.total,
      workflowName: workingDetail.workflow.name,
      settled: workingDetail.workflow.settled,
      workLogCount: workingDetail.workLog.length,
    });

    await evalInRenderer(
      win.webContents,
      `window.coder.runs.stop(${JSON.stringify({ threadId: threadA.id })})`,
    );
    logStep("passA.runs.stop", { ok: true });

    const idleDetail = await evalInRenderer(
      win.webContents,
      `window.coder.threads.get(${JSON.stringify(threadA.id)})`,
    );
    if (!idleDetail || idleDetail.thread.status !== "idle") {
      throw new Error(
        `passA expected status idle after stop, got ${JSON.stringify(
          idleDetail && idleDetail.thread && idleDetail.thread.status,
        )}`,
      );
    }
    const hasStopped = (idleDetail.messages || []).some(
      (m) => m.role === "event" && /Run stopped/i.test(m.text),
    );
    if (!hasStopped) {
      throw new Error(
        `passA expected "Run stopped" event message, messages=${JSON.stringify(
          idleDetail.messages,
        )}`,
      );
    }
    assertWorkLogShape(idleDetail.workLog, startedA.workflowId);
    logStep("passA.threads.get.idle", {
      ok: true,
      status: idleDetail.thread.status,
      hasRunStoppedEvent: true,
      messageCount: idleDetail.messages.length,
      workLogCount: idleDetail.workLog.length,
    });
    logStep("passA", { ok: true });

    // ── Pass B: real agent with fake node -e ──────────────────────────
    delete process.env.CODER_SIMULATE;
    // No spaces inside the -e body or binary path so whitespace split stays valid.
    const nodeBin = resolveNodeBinary();
    const fakeScript = `process.stdout.write('${FAKE_AGENT_MARKER}');process.exit(0)`;
    process.env.CODER_AGENT_CMD = `${nodeBin} -e ${fakeScript}`;

    const threadB = await createThread(win.webContents, project.id, "New Thread");
    logStep("passB.threads.create", { ok: true, threadId: threadB.id });

    const startedB = await evalInRenderer(
      win.webContents,
      `window.coder.runs.start(${JSON.stringify({
        threadId: threadB.id,
        prompt: "Real agent smoke prompt",
      })})`,
    );
    if (!startedB || !startedB.workflowId) {
      throw new Error(`passB runs.start unexpected: ${JSON.stringify(startedB)}`);
    }
    logStep("passB.runs.start", { ok: true, started: startedB });

    // Wait until thread reaches done (fake agent is near-instant).
    const deadline = Date.now() + 15000;
    let doneDetail = null;
    while (Date.now() < deadline) {
      doneDetail = await evalInRenderer(
        win.webContents,
        `window.coder.threads.get(${JSON.stringify(threadB.id)})`,
      );
      if (doneDetail && doneDetail.thread.status === "done") break;
      if (doneDetail && doneDetail.thread.status === "failed") {
        throw new Error(
          `passB thread failed: ${JSON.stringify(doneDetail.messages)}`,
        );
      }
      await sleep(50);
    }
    if (!doneDetail || doneDetail.thread.status !== "done") {
      throw new Error(
        `passB expected status done, got ${JSON.stringify(
          doneDetail && doneDetail.thread && doneDetail.thread.status,
        )}`,
      );
    }

    const assistant = (doneDetail.messages || []).find(
      (m) => m.role === "assistant" && m.runId === startedB.workflowId,
    );
    if (!assistant || !String(assistant.text).includes(FAKE_AGENT_MARKER)) {
      throw new Error(
        `passB expected assistant message containing ${FAKE_AGENT_MARKER}, got ${JSON.stringify(
          doneDetail.messages,
        )}`,
      );
    }
    assertWorkLogShape(doneDetail.workLog, startedB.workflowId);
    logStep("passB.threads.get.done", {
      ok: true,
      status: doneDetail.thread.status,
      assistantText: assistant.text,
      workLogCount: doneDetail.workLog.length,
      workflowTotal: doneDetail.workflow && doneDetail.workflow.total,
    });
    logStep("passB", { ok: true });

    logStep("smoke", { ok: true, passes: ["A", "B"] });
    app.exit(0);
  })
  .catch((err) => {
    fail("smoke", err);
  });
