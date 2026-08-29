"use strict";
// REAL end-to-end acceptance drive: boots the full app runtime (memory
// supervisor + MCP injection) and spends ONE genuine claude turn to prove the
// whole flywheel: agent reaches memory over MCP, the transcript is recorded,
// the run outcome is stored, and vectors are embedded.
//
//   npm run acceptance      (from the repo root; costs one real claude turn)
//
// Isolated: temp userData, its own memory server and database, never the real
// ones. Fakes cannot replace this: the two bugs it caught (variadic CLI flags
// swallowing the prompt, and headless tool-permission denial) are invisible to
// every fake-CLI test in the suite.

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { pathToFileURL } = require("node:url");

const REPO = process.cwd();
const { Store } = require(path.join(REPO, "electron/store.js"));
const { createRunner } = require(path.join(REPO, "electron/runner.js"));
const { registerIpc } = require(path.join(REPO, "electron/ipc.js"));
const memSup = require(path.join(REPO, "electron/memory-sup.js"));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "coder-accept-"));
app.setPath("userData", userData);

// Real providers only: make sure no fake/simulate overrides leak in.
delete process.env.CODER_SIMULATE;
delete process.env.CODER_AGENT_CMD;
delete process.env.CODER_CLAUDE_BIN;
process.env.CODER_GROK_MCP_DISABLE = "1"; // do not touch grok user config
process.env.CODER_CURSOR_MCP_DISABLE = "1"; // do not touch ~/.cursor/mcp.json
process.env.SOLENTA_SKIP_USERDATA_MIGRATION = "1"; // isolated userData: never migrate real data into it
process.env.CODER_KIMI_MCP_PATH = path.join(userData, "kimi-mcp.json");
process.env.CODER_CURSOR_MCP_PATH = path.join(userData, "cursor-mcp.json");

function out(step, data) {
  console.log(JSON.stringify({ step, ...data }));
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(b) });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function evalIn(wc, code) {
  return wc.executeJavaScript(code, true);
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timeout: " + label);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

app
  .whenReady()
  .then(async () => {
    const core = await import(
      pathToFileURL(path.join(REPO, "core/dist/index.js")).href
    );

    // 1. Memory supervisor: spawn a fresh isolated memory server.
    const sup = memSup.createMemorySupervisor({
      userDataPath: userData,
      appPath: REPO,
      log: (m) => out("memlog", { m }),
    });
    await sup.start();
    const status = memSup.getMemoryStatus();
    out("memory", status);
    if (!status.running) throw new Error("memory server did not start");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(userData, "memory-server.json"), "utf8"),
    );

    // 2. App runtime.
    const store = new Store(path.join(userData, "coder-store.json"));
    function broadcast(channel, payload) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      }
    }
    const runner = createRunner({
      store,
      core,
      pushFn: broadcast,
      tickMs: 700,
      userDataPath: userData, // required for memory + transcript recording
    });
    registerIpc({
      ipcMain,
      dialog,
      store,
      runner,
      broadcast,
      worktreeBase: path.join(userData, "worktrees"),
      userDataPath: userData,
    });

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(REPO, "electron/preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(REPO, "dist/index.html"));
    await waitFor(
      () => evalIn(win.webContents, "Boolean(window.coder)"),
      10000,
      "window.coder",
    );

    // 3. Project + thread + ONE REAL claude turn.
    const project = await evalIn(
      win.webContents,
      `window.coder.projects.add(${JSON.stringify(REPO)})`,
    );
    out("project", { id: project.id, slug: project.slug });

    const thread = await evalIn(
      win.webContents,
      `window.coder.threads.create(${JSON.stringify({
        projectId: project.id,
        title: "acceptance",
      })})`,
    );
    out("thread", { id: thread.id, provider: thread.provider });

    const prompt =
      "Call the memory_bootstrap tool from the coder-memory MCP server with project set to your working directory. " +
      "If the tool call succeeds, reply with exactly: MEMOK. If the tool is unavailable or fails, reply with exactly: NOMEM. " +
      "Do not run any other tools.";
    await evalIn(
      win.webContents,
      `window.coder.runs.start(${JSON.stringify({ threadId: thread.id, prompt })})`,
    );
    out("run", { started: true });

    const detail = await waitFor(
      async () => {
        const d = await evalIn(
          win.webContents,
          `window.coder.threads.get(${JSON.stringify(thread.id)})`,
        );
        return d.thread.status === "done" || d.thread.status === "failed"
          ? d
          : null;
      },
      240000,
      "run terminal",
    );
    const assistant = detail.messages.filter((m) => m.role === "assistant").pop();
    out("terminal", {
      status: detail.thread.status,
      sessionId: detail.thread.sessionId ? "set" : null,
      assistantTail: (assistant?.text || "").slice(-120),
      usage: detail.usage,
    });
    if (detail.thread.status !== "done") throw new Error("run did not complete");
    if (!/MEMOK/.test(assistant?.text || ""))
      throw new Error("agent could not reach the memory server (no MEMOK)");

    // 4. Verify the flywheel on the isolated server.
    const H = { Authorization: `Bearer ${cfg.token}` };
    const base = `http://127.0.0.1:${cfg.port}`;

    // Transcript recording is batched at run-terminal; allow it a moment.
    const transcript = await waitFor(
      async () => {
        const r = await fetchJson(
          `${base}/api/session-search?query=MEMOK`,
          H,
        );
        return Array.isArray(r.body) && r.body.length > 0 ? r.body : null;
      },
      15000,
      "transcript recorded",
    );
    out("transcript", { hits: transcript.length, role: transcript[0].role });

    const runEntry = await waitFor(
      async () => {
        const r = await fetchJson(
          `${base}/api/search?query=${encodeURIComponent("claude run acceptance")}`,
          H,
        );
        const hit = (r.body || []).find((e) => e.type === "run");
        return hit || null;
      },
      15000,
      "run outcome recorded",
    );
    out("runEntry", { id: runEntry.id, title: runEntry.title });

    const health = await fetchJson(`${base}/health`);
    out("vectors", health.body.vectors);
    if (!(health.body.vectors.count > 0))
      throw new Error("no vectors embedded");

    out("acceptance", { ok: true });
    app.exit(0);
  })
  .catch((err) => {
    out("acceptance", { ok: false, error: String((err && err.message) || err) });
    app.exit(1);
  });
