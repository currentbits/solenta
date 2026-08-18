"use strict";

// Electron stays alive after a load-time throw ("App threw an error during
// load"). Without this, a missing dep or a require() failure hangs the
// process and CI only dies on timeout-minutes.
process.on("uncaughtException", (err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(JSON.stringify({ step: "uncaught", ok: false, error: message }));
  process.exit(1);
});

/**
 * Scripted end-to-end smoke of the real preload bridge (window.coder).
 * Run with the real Electron binary (not node):
 *   ./node_modules/.bin/electron electron/smoke.js
 *
 * Five passes in one invocation:
 *   A) CODER_SIMULATE=1 — simulated core ticker, new work-log shape
 *   B) CODER_AGENT_CMD = fake node -e agent — real generic spawn path to done
 *   C) CODER_CLAUDE_BIN = fake stream-json script — session, tools, usage
 *   D) CODER_CODEX_BIN = fake codex JSONL — session, tool Command, status done
 *   E) two-phase mixed template (fake claude seed + fake text finalize) + dossiers
 *
 * Uses a temp userData path so it never touches real app state.
 * Expects dist/index.html (run `npx vite build` first) and core/dist.
 *
 * Win32: shebang fakes are not executable (CreateProcess). Each fake gets a
 * sibling .cmd that runs `node <script> %*` and that path is what CODER_*_BIN
 * points at. macOS still gets the shebang path, unchanged.
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { Store } = require("./store.js");
const { createRunner } = require("./runner.js");
const { registerIpc } = require("./ipc.js");
const { defaultWhich } = require("./providers.js");

/**
 * Resolve a Node binary whose path has no whitespace.
 * CODER_AGENT_CMD is split on spaces, so process.execPath under Electron
 * (…/Application Support/…) cannot be used as the command token.
 *
 * PATH lookup goes through defaultWhich so win32 uses `where`, not `which`
 * (same helper as providers.js / #442). `where` prints every match; we
 * still reject paths with whitespace.
 */
function resolveNodeBinary() {
  const candidates = [];
  const fromPath = defaultWhich("node");
  if (fromPath) candidates.push(fromPath);
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

/**
 * Node for the win32 .cmd wrapper. Spaces are fine here (the path is quoted),
 * and we must not fall back to process.execPath — that is electron.exe and
 * would boot another Electron per fake invocation.
 */
function resolveNodeForCmd() {
  const fromPath = defaultWhich("node");
  if (fromPath && fs.existsSync(fromPath)) return fromPath;
  throw new Error("No node binary found for smoke fake .cmd wrappers");
}

/**
 * Write a shebang node fake. On win32 also write a .cmd wrapper and return
 * that path so CODER_*_BIN stays one executable token.
 * @param {string} dir
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function writeFakeBin(dir, name, body) {
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  if (process.platform !== "win32") return scriptPath;
  const cmdPath = `${scriptPath}.cmd`;
  const nodeBin = resolveNodeForCmd();
  fs.writeFileSync(
    cmdPath,
    `@echo off\r\n"${nodeBin}" "${scriptPath}" %*\r\n`,
  );
  return cmdPath;
}

/**
 * Write a fake claude CLI that emits stream-json for smoke pass C.
 * @param {string} dir
 * @returns {string} absolute path to executable script
 */
function writeSmokeFakeClaude(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
(async () => {
  emit({ type: "system", subtype: "init", session_id: "smoke-sess-1", model: "smoke-model" });
  await delay(20);
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Smoke claude ok" }] } });
  await delay(20);
  emit({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "toolu_smoke", name: "Bash", input: { command: "echo hi" } }],
    },
  });
  await delay(20);
  emit({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_smoke",
        content: "hi",
        is_error: false,
      }],
    },
  });
  await delay(20);
  emit({
    type: "result",
    subtype: "success",
    result: "Smoke claude ok",
    usage: { input_tokens: 12, output_tokens: 8 },
    total_cost_usd: 0.002,
    num_turns: 1,
    session_id: "smoke-sess-1",
  });
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
`;
  return writeFakeBin(dir, "smoke-fake-claude", body);
}

/**
 * Write a fake claude for smoke pass E seed phase (stream-json).
 * @param {string} dir
 * @returns {string} absolute path to executable script
 */
function writeSmokeWorkflowFakeClaude(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const text = "SMOKE_SEED_PLAN: step one";
(async () => {
  emit({ type: "system", subtype: "init", session_id: "smoke-wf-sess", model: "smoke-wf-model" });
  await delay(10);
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  await delay(10);
  emit({
    type: "result",
    subtype: "success",
    result: text,
    usage: { input_tokens: 5, output_tokens: 7 },
    total_cost_usd: 0.001,
    session_id: "smoke-wf-sess",
  });
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
`;
  return writeFakeBin(dir, "smoke-wf-fake-claude", body);
}

/**
 * Write a fake grok (claude-stream) binary for smoke pass E finalize phase.
 * Emits streaming-messages-json NDJSON so the structured path can parse it.
 * @param {string} dir
 * @returns {string}
 */
function writeSmokeWorkflowFakeText(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const text = "SMOKE_TEXT_FINAL";
(async () => {
  emit({ type: "system", subtype: "init", session_id: "smoke-grok-sess", model: "grok-4.5" });
  await delay(10);
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  await delay(10);
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: { input_tokens: 4, output_tokens: 5 },
    total_cost_usd: 0.001,
    num_turns: 1,
    session_id: "smoke-grok-sess",
  });
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
`;
  return writeFakeBin(dir, "smoke-wf-fake-text", body);
}

/**
 * Write a fake codex CLI that emits JSONL for smoke pass D.
 * @param {string} dir
 * @returns {string} absolute path to executable script
 */
function writeSmokeFakeCodex(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
(async () => {
  emit({ type: "thread.started", thread_id: "smoke-codex-sess-1" });
  await delay(20);
  emit({
    type: "item.completed",
    item: { id: "msg1", type: "agent_message", text: "Smoke codex ok" },
  });
  await delay(20);
  emit({
    type: "item.started",
    item: { id: "cmd1", type: "command_execution", command: "echo smoke" },
  });
  await delay(20);
  emit({
    type: "item.completed",
    item: {
      id: "cmd1",
      type: "command_execution",
      command: "echo smoke",
      aggregated_output: "smoke\\n",
      exit_code: 0,
    },
  });
  await delay(20);
  emit({
    type: "turn.completed",
    usage: { input_tokens: 9, output_tokens: 4 },
  });
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
`;
  return writeFakeBin(dir, "smoke-fake-codex", body);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "coder-smoke-"));
app.setPath("userData", userData);
// Isolated boot: never migrate real userData into this throwaway dir.
process.env.SOLENTA_SKIP_USERDATA_MIGRATION = "1";

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
    const worktreeBase = path.join(app.getPath("userData"), "worktrees");

    function broadcast(channel, payload) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    }

    // Runner reads CODER_SIMULATE / CODER_AGENT_CMD / CODER_CLAUDE_BIN at each startRun.
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
      worktreeBase,
      userDataPath: userData,
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
    delete process.env.CODER_CLAUDE_BIN;

    const threadA = await createThread(win.webContents, project.id, "New Thread");
    logStep("passA.threads.create", { ok: true, threadId: threadA.id });

    const startedA = await evalInRenderer(
      win.webContents,
      `window.coder.runs.start(${JSON.stringify({
        threadId: threadA.id,
        prompt: "Smoke test prompt for workflow",
      })})`,
    );
    if (!startedA || !startedA.runId) {
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
    assertWorkLogShape(workingDetail.workLog, startedA.runId);
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
    assertWorkLogShape(idleDetail.workLog, startedA.runId);
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
    delete process.env.CODER_CLAUDE_BIN;
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
    if (!startedB || !startedB.runId) {
      throw new Error(`passB runs.start unexpected: ${JSON.stringify(startedB)}`);
    }
    logStep("passB.runs.start", { ok: true, started: startedB });

    // Wait until thread reaches done (fake agent is near-instant).
    const deadlineB = Date.now() + 15000;
    let doneDetail = null;
    while (Date.now() < deadlineB) {
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
      (m) => m.role === "assistant" && m.runId === startedB.runId,
    );
    if (!assistant || !String(assistant.text).includes(FAKE_AGENT_MARKER)) {
      throw new Error(
        `passB expected assistant message containing ${FAKE_AGENT_MARKER}, got ${JSON.stringify(
          doneDetail.messages,
        )}`,
      );
    }
    assertWorkLogShape(doneDetail.workLog, startedB.runId);
    logStep("passB.threads.get.done", {
      ok: true,
      status: doneDetail.thread.status,
      assistantText: assistant.text,
      workLogCount: doneDetail.workLog.length,
      workflow: doneDetail.workflow,
    });
    logStep("passB", { ok: true });

    // ── Pass C: claude adapter via fake stream-json binary ────────────
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    const fakeClaude = writeSmokeFakeClaude(userData);
    process.env.CODER_CLAUDE_BIN = fakeClaude;

    const threadC = await createThread(win.webContents, project.id, "Claude Smoke");
    logStep("passC.threads.create", {
      ok: true,
      threadId: threadC.id,
      provider: threadC.provider,
    });

    const startedC = await evalInRenderer(
      win.webContents,
      `window.coder.runs.start(${JSON.stringify({
        threadId: threadC.id,
        prompt: "Claude smoke prompt",
      })})`,
    );
    if (!startedC || !startedC.runId) {
      throw new Error(`passC runs.start unexpected: ${JSON.stringify(startedC)}`);
    }
    logStep("passC.runs.start", { ok: true, started: startedC });

    const deadlineC = Date.now() + 15000;
    let claudeDetail = null;
    while (Date.now() < deadlineC) {
      claudeDetail = await evalInRenderer(
        win.webContents,
        `window.coder.threads.get(${JSON.stringify(threadC.id)})`,
      );
      if (claudeDetail && claudeDetail.thread.status === "done") break;
      if (claudeDetail && claudeDetail.thread.status === "failed") {
        throw new Error(
          `passC thread failed: ${JSON.stringify(claudeDetail.messages)}`,
        );
      }
      await sleep(50);
    }
    if (!claudeDetail || claudeDetail.thread.status !== "done") {
      throw new Error(
        `passC expected status done, got ${JSON.stringify(
          claudeDetail && claudeDetail.thread && claudeDetail.thread.status,
        )}`,
      );
    }

    if (claudeDetail.thread.sessionId !== "smoke-sess-1") {
      throw new Error(
        `passC expected sessionId smoke-sess-1, got ${JSON.stringify(
          claudeDetail.thread.sessionId,
        )}`,
      );
    }

    const toolMsg = (claudeDetail.messages || []).find(
      (m) => m.role === "tool" && m.tool && m.tool.done === true,
    );
    if (!toolMsg) {
      throw new Error(
        `passC expected a tool message with done true, messages=${JSON.stringify(
          claudeDetail.messages,
        )}`,
      );
    }

    if (!claudeDetail.usage || claudeDetail.usage.inputTokens == null) {
      throw new Error(
        `passC expected non-null usage, got ${JSON.stringify(claudeDetail.usage)}`,
      );
    }

    assertWorkLogShape(claudeDetail.workLog, startedC.runId);
    logStep("passC.threads.get.done", {
      ok: true,
      status: claudeDetail.thread.status,
      sessionId: claudeDetail.thread.sessionId,
      toolDone: toolMsg.tool.done,
      usage: claudeDetail.usage,
    });
    logStep("passC", { ok: true });

    // ── Pass D: codex adapter via fake JSONL binary ───────────────────
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_CLAUDE_BIN;
    const fakeCodex = writeSmokeFakeCodex(userData);
    process.env.CODER_CODEX_BIN = fakeCodex;

    const threadD = await createThread(win.webContents, project.id, "Codex Smoke");
    // Switch provider to codex before starting (no session yet).
    const setProv = await evalInRenderer(
      win.webContents,
      `window.coder.threads.setProvider(${JSON.stringify({
        threadId: threadD.id,
        provider: "codex",
      })})`,
    );
    if (!setProv || setProv.provider !== "codex") {
      throw new Error(
        `passD setProvider expected codex, got ${JSON.stringify(setProv)}`,
      );
    }
    logStep("passD.threads.create", {
      ok: true,
      threadId: threadD.id,
      provider: setProv.provider,
    });

    const startedD = await evalInRenderer(
      win.webContents,
      `window.coder.runs.start(${JSON.stringify({
        threadId: threadD.id,
        prompt: "Codex smoke prompt",
      })})`,
    );
    if (!startedD || !startedD.runId) {
      throw new Error(`passD runs.start unexpected: ${JSON.stringify(startedD)}`);
    }
    logStep("passD.runs.start", { ok: true, started: startedD });

    const deadlineD = Date.now() + 15000;
    let codexDetail = null;
    while (Date.now() < deadlineD) {
      codexDetail = await evalInRenderer(
        win.webContents,
        `window.coder.threads.get(${JSON.stringify(threadD.id)})`,
      );
      if (codexDetail && codexDetail.thread.status === "done") break;
      if (codexDetail && codexDetail.thread.status === "failed") {
        throw new Error(
          `passD thread failed: ${JSON.stringify(codexDetail.messages)}`,
        );
      }
      await sleep(50);
    }
    if (!codexDetail || codexDetail.thread.status !== "done") {
      throw new Error(
        `passD expected status done, got ${JSON.stringify(
          codexDetail && codexDetail.thread && codexDetail.thread.status,
        )}`,
      );
    }

    if (codexDetail.thread.sessionId !== "smoke-codex-sess-1") {
      throw new Error(
        `passD expected sessionId smoke-codex-sess-1, got ${JSON.stringify(
          codexDetail.thread.sessionId,
        )}`,
      );
    }

    const codexTool = (codexDetail.messages || []).find(
      (m) =>
        m.role === "tool" &&
        m.tool &&
        m.tool.done === true &&
        m.tool.name === "Command",
    );
    if (!codexTool) {
      throw new Error(
        `passD expected a Command tool message with done true, messages=${JSON.stringify(
          codexDetail.messages,
        )}`,
      );
    }

    assertWorkLogShape(codexDetail.workLog, startedD.runId);
    logStep("passD.threads.get.done", {
      ok: true,
      status: codexDetail.thread.status,
      sessionId: codexDetail.thread.sessionId,
      toolDone: codexTool.tool.done,
      usage: codexDetail.usage,
    });
    logStep("passD", { ok: true });

    // ── Pass E: two-phase mixed template (claude seed + text finalize) ─
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    delete process.env.CODER_CODEX_BIN;
    const fakeWfClaude = writeSmokeWorkflowFakeClaude(userData);
    const fakeWfText = writeSmokeWorkflowFakeText(userData);
    process.env.CODER_CLAUDE_BIN = fakeWfClaude;
    process.env.CODER_GROK_BIN = fakeWfText;

    const threadE = await createThread(win.webContents, project.id, "New Thread");
    logStep("passE.threads.create", {
      ok: true,
      threadId: threadE.id,
      provider: threadE.provider,
    });

    const listType = await evalInRenderer(
      win.webContents,
      `typeof window.coder.workflows?.list`,
    );
    if (listType !== "function") {
      throw new Error(
        `passE expected window.coder.workflows.list to be a function, got ${listType}`,
      );
    }

    const tmplE = await evalInRenderer(
      win.webContents,
      `window.coder.workflows.save(${JSON.stringify({
        name: "Smoke Mixed",
        phases: [
          {
            name: "seed",
            agentCount: 1,
            instruction: "Smoke seed: produce a short plan.",
            provider: "claude",
            model: null,
          },
          {
            name: "finalize",
            agentCount: 1,
            instruction: "Smoke finalize: produce the final answer.",
            provider: "grok",
            model: null,
          },
        ],
      })})`,
    );
    if (!tmplE || !tmplE.id) {
      throw new Error(
        `passE workflows.save unexpected: ${JSON.stringify(tmplE)}`,
      );
    }
    logStep("passE.workflows.save", { ok: true, templateId: tmplE.id });

    const startWfType = await evalInRenderer(
      win.webContents,
      `typeof window.coder.runs.startWorkflow`,
    );
    if (startWfType !== "function") {
      throw new Error(
        `passE expected window.coder.runs.startWorkflow to be a function, got ${startWfType}`,
      );
    }

    const startedE = await evalInRenderer(
      win.webContents,
      `window.coder.runs.startWorkflow(${JSON.stringify({
        threadId: threadE.id,
        prompt: "Smoke workflow prompt",
        templateId: tmplE.id,
      })})`,
    );
    if (!startedE || !startedE.runId) {
      throw new Error(
        `passE runs.startWorkflow unexpected: ${JSON.stringify(startedE)}`,
      );
    }
    logStep("passE.runs.startWorkflow", { ok: true, started: startedE });

    const deadlineE = Date.now() + 20000;
    let wfDetail = null;
    while (Date.now() < deadlineE) {
      wfDetail = await evalInRenderer(
        win.webContents,
        `window.coder.threads.get(${JSON.stringify(threadE.id)})`,
      );
      if (wfDetail && wfDetail.thread.status === "done") break;
      if (wfDetail && wfDetail.thread.status === "failed") {
        throw new Error(
          `passE thread failed: ${JSON.stringify(wfDetail.messages)}`,
        );
      }
      await sleep(50);
    }
    if (!wfDetail || wfDetail.thread.status !== "done") {
      throw new Error(
        `passE expected status done, got ${JSON.stringify(
          wfDetail && wfDetail.thread && wfDetail.thread.status,
        )}`,
      );
    }

    const synthAssistant = (wfDetail.messages || []).find(
      (m) => m.role === "assistant" && m.runId === startedE.runId,
    );
    if (!synthAssistant || !/SMOKE_TEXT_FINAL/.test(synthAssistant.text || "")) {
      throw new Error(
        `passE expected assistant text containing SMOKE_TEXT_FINAL, got ${JSON.stringify(
          synthAssistant && synthAssistant.text,
        )}`,
      );
    }

    if (!wfDetail.workflow || wfDetail.workflow.complete !== true) {
      throw new Error(
        `passE expected workflow.complete true, got ${JSON.stringify(
          wfDetail.workflow,
        )}`,
      );
    }
    if (wfDetail.workflow.total !== 2) {
      throw new Error(
        `passE expected workflow.total === 2, got ${wfDetail.workflow.total}`,
      );
    }
    let settledAgents = 0;
    for (const phase of wfDetail.workflow.phases || []) {
      for (const agent of phase.agents || []) {
        if (agent.status === "settled") settledAgents += 1;
      }
    }
    if (settledAgents !== 2) {
      throw new Error(
        `passE expected 2 settled agents, got ${settledAgents}: ${JSON.stringify(
          wfDetail.workflow,
        )}`,
      );
    }

    const dossiers = (wfDetail.messages || []).filter(
      (m) => m.role === "tool" && m.runId === startedE.runId && m.tool,
    );
    if (dossiers.length < 2) {
      throw new Error(
        `passE expected >=2 dossier tool messages, got ${dossiers.length}: ${JSON.stringify(
          dossiers,
        )}`,
      );
    }
    for (const d of dossiers) {
      if (!d.tool.done) {
        throw new Error(`passE dossier not done: ${JSON.stringify(d)}`);
      }
      if (typeof d.tool.input !== "string" || !d.tool.input) {
        throw new Error(`passE dossier missing input: ${JSON.stringify(d)}`);
      }
      if (typeof d.tool.output !== "string") {
        throw new Error(`passE dossier missing output: ${JSON.stringify(d)}`);
      }
    }

    assertWorkLogShape(wfDetail.workLog, startedE.runId);
    logStep("passE.threads.get.done", {
      ok: true,
      status: wfDetail.thread.status,
      assistantText: synthAssistant.text,
      workflowComplete: wfDetail.workflow.complete,
      settledAgents,
      dossierCount: dossiers.length,
      usage: wfDetail.usage,
    });
    logStep("passE", { ok: true });

    logStep("smoke", { ok: true, passes: ["A", "B", "C", "D", "E"] });
    app.exit(0);
  })
  .catch((err) => {
    fail("smoke", err);
  });
