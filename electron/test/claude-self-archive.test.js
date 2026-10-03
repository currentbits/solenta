"use strict";

/**
 * #1383: a Claude thread that archives (or settles) itself does so from
 * inside its own turn (the thread_archive tool). Retiring the kept-alive CLI
 * must wait for that turn to settle; killing it immediately SIGTERMs the
 * process making the call and the turn lands as "Run error (exit 143)".
 *
 * Run: node --test electron/test/claude-self-archive.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const { rmTree } = require("./support/rmTree.js");

{
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        ipcMain: { handle() {} },
        BrowserWindow: { getAllWindows: () => [] },
        dialog: {},
        shell: {},
        app: { getPath: () => os.tmpdir() },
      };
    }
    return origLoad.apply(this, arguments);
  };
}

const { IPC_HANDLERS, makeCtx } = require("../ipc.js");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kept-alive fake CLI whose turn stays open until the gate file exists. */
function writeGatedFakeClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
fs.writeFileSync(process.env.CODER_FAKE_CLAUDE_PID_FILE, String(process.pid));
emit({ type: "system", subtype: "init", session_id: "sess-self", model: "m" });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "closing this thread" }] },
    });
    const gate = setInterval(() => {
      if (!fs.existsSync(process.env.CODER_FAKE_CLAUDE_GATE)) return;
      clearInterval(gate);
      emit({
        type: "result",
        subtype: "success",
        result: "closed",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        num_turns: 1,
        session_id: "sess-self",
      });
    }, 20);
  }
});
setInterval(() => {}, 500);
`,
  );
}

const ENV_KEYS = [
  "CODER_SIMULATE",
  "CODER_AGENT_CMD",
  "CODER_CLAUDE_BIN",
  "CODER_GROK_MCP_DISABLE",
  "CODER_GROK_BIN",
  "CODER_FAKE_CLAUDE_PID_FILE",
  "CODER_FAKE_CLAUDE_GATE",
];

describe("self-archive defers the Claude keep-alive kill (#1383)", () => {
  let tmpDir;
  let store;
  let runner;
  let pidFile;
  let gateFile;
  let threadId;
  let prevEnv;

  beforeEach(async () => {
    prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-self-archive-"));
    pidFile = path.join(tmpDir, "claude.pid");
    gateFile = path.join(tmpDir, "gate");
    process.env.CODER_CLAUDE_BIN = writeGatedFakeClaude(tmpDir);
    process.env.CODER_FAKE_CLAUDE_PID_FILE = pidFile;
    process.env.CODER_FAKE_CLAUDE_GATE = gateFile;

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await import(
      pathToFileURL(path.join(__dirname, "../../core/dist/index.js")).href
    );
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
    });
    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const project = await services.addProject(store, repo);
    threadId = services.createThread(store, {
      projectId: project.id,
      title: "Self closer",
    }).id;
    store.saveNow();
  });

  afterEach(async () => {
    if (runner) runner.stopAll();
    await rmTree(tmpDir);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function ctx() {
    return makeCtx({
      store,
      runner,
      broadcast() {},
      worktreeBase: "",
      userDataPath: tmpDir,
    });
  }

  function readPid() {
    return fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : 0;
  }

  // Settle refuses while a run is active (services.setSettled), so archive
  // is the only path a live turn can take against itself.
  it("archive mid-turn lets the turn finish, then reaps the CLI", async () => {
    await runner.startRun({ threadId, prompt: "merge and close" });
    await waitFor(() => readPid() > 0 && runner.isRunning(threadId));
    const pid = readPid();

    await IPC_HANDLERS["threads:setArchived"](ctx(), {
      threadId,
      archived: true,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(processAlive(pid), true, "live turn must not be killed");
    assert.equal(runner.isRunning(threadId), true);

    fs.writeFileSync(gateFile, "go");
    await waitFor(() => !runner.isRunning(threadId));
    await waitFor(() => !processAlive(pid));

    const thread = store.getThread(threadId);
    assert.equal(thread.status, "done");
    assert.equal(thread.lastError ?? null, null);
  });

  it("archiving an idle thread still reaps the CLI immediately", async () => {
    fs.writeFileSync(gateFile, "go");
    await runner.startRun({ threadId, prompt: "one turn" });
    await waitFor(() => store.getThread(threadId).status === "done");
    const pid = readPid();
    assert.equal(processAlive(pid), true, "keep-alive holds the CLI");

    await IPC_HANDLERS["threads:setArchived"](ctx(), {
      threadId,
      archived: true,
    });
    await waitFor(() => !processAlive(pid));
  });
});
