"use strict";

/**
 * #1227: removing a project must retire idle Claude keep-alives the same
 * way threads:delete does. Store purge is not enough — sessions live in
 * the runner Map until disposeClaudeSession kills the child and clears
 * the idle timer.
 *
 * Run: node --test electron/test/remove-project-sessions.test.js
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

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
const { createRunner, liveClaudeChildren } = require("../runner.js");
const { writeFakeBin } = require("./support/fakeBin.js");

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function loadCore() {
  const corePath = path.join(__dirname, "../../core/dist/index.js");
  return import(pathToFileURL(corePath).href);
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
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

function readPid(file) {
  if (!fs.existsSync(file)) return 0;
  const n = Number(fs.readFileSync(file, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Keep-alive Claude CLI: one turn per stdin user message, then linger.
 * SIGTERM exits so disposeClaudeSession actually reaps the child.
 */
function writeKeepAliveFakeClaude(dir) {
  return writeFakeBin(
    path.join(dir, "fake-claude"),
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(1);
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
function sessionKey() {
  const i = argv.indexOf("--resume");
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]);
  return process.env.CODER_FAKE_CLAUDE_SESSION || "sess-keep";
}
const key = sessionKey();
const pidsDir = process.env.CODER_FAKE_CLAUDE_PIDS_DIR;
if (pidsDir) {
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.writeFileSync(path.join(pidsDir, key), String(process.pid));
}
process.on("SIGTERM", () => process.exit(0));
emit({ type: "system", subtype: "init", session_id: key, model: "m" });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== "user") continue;
    emit({
      type: "assistant",
      message: { content: [{ type: "text", text: "kept" }] },
    });
    emit({
      type: "result",
      subtype: "success",
      result: "kept",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      num_turns: 1,
      session_id: key,
    });
  }
});
setInterval(() => {}, 500);
`,
  );
}

function plantFakeSession(sessions, threadId) {
  const child = { killed: false, killCalls: 0 };
  const idleTimer = setTimeout(() => {}, 30 * 60 * 1000);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
  const sess = {
    handle: {
      child,
      kill() {
        child.killed = true;
        child.killCalls += 1;
      },
    },
    idleTimer,
    child,
  };
  sessions.set(threadId, sess);
  return sess;
}

function makeHandleRunner() {
  const sessions = new Map();
  const running = new Set();
  return {
    sessions,
    running,
    isRunning: (id) => running.has(id),
    plant: (threadId) => plantFakeSession(sessions, threadId),
    disposeClaudeSession(threadId) {
      const sess = sessions.get(threadId);
      if (!sess) return;
      sessions.delete(threadId);
      if (sess.idleTimer) {
        clearTimeout(sess.idleTimer);
        sess.idleTimer = null;
      }
      try {
        if (sess.handle) sess.handle.kill();
      } catch {
        // already dead
      }
    },
  };
}

describe("projects:remove IPC retires fake-child session handles (#1227)", () => {
  let tmpDir;
  let store;
  let projectA;
  let projectB;
  let runner;
  let broadcasts;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-rm-proj-sess-"));
    store = new Store(path.join(tmpDir, "store.json"));
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);
    git(repoA, ["init"]);
    git(repoB, ["init"]);
    projectA = await services.addProject(store, repoA);
    projectB = await services.addProject(store, repoB);
    runner = makeHandleRunner();
    broadcasts = [];
  });

  afterEach(() => {
    if (runner) {
      for (const sess of runner.sessions.values()) {
        if (sess.idleTimer) clearTimeout(sess.idleTimer);
      }
      runner.sessions.clear();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function ctx() {
    return makeCtx({
      store,
      runner,
      broadcast(channel, payload) {
        broadcasts.push({ channel, payload });
      },
      worktreeBase: "",
      userDataPath: tmpDir,
    });
  }

  function addThread(projectId, title) {
    return services.createThread(store, {
      projectId,
      title,
      provider: "claude",
    });
  }

  it("kills each removed thread's handle and clears its idle timer", async () => {
    const a1 = addThread(projectA.id, "A1");
    const a2 = addThread(projectA.id, "A2");
    const b1 = addThread(projectB.id, "B1");
    const s1 = runner.plant(a1.id);
    const s2 = runner.plant(a2.id);
    const sB = runner.plant(b1.id);

    await IPC_HANDLERS["threads:delete"](ctx(), { threadId: a1.id });
    assert.equal(s1.child.killed, true, "single-thread delete must kill its handle");
    assert.equal(s1.idleTimer, null);
    assert.equal(runner.sessions.has(a1.id), false);
    assert.equal(s2.child.killed, false, "sibling session must survive thread delete");
    assert.equal(sB.child.killed, false);

    broadcasts.length = 0;
    await IPC_HANDLERS["projects:remove"](ctx(), { projectId: projectA.id });

    assert.equal(store.getProject(projectA.id), null);
    assert.equal(store.getThread(a2.id), null);
    assert.equal(s2.child.killed, true, "project removal must kill remaining handles");
    assert.equal(s2.child.killCalls, 1);
    assert.equal(s2.idleTimer, null, "idle timer must be cleared, not left to fire");
    assert.equal(runner.sessions.has(a2.id), false);
    assert.equal(sB.child.killed, false, "other project's session must stay");
    assert.ok(sB.idleTimer, "other project's idle timer must stay armed");
    assert.equal(runner.sessions.has(b1.id), true);
    assert.ok(store.getProject(projectB.id));
    assert.ok(store.getThread(b1.id));
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
    assert.equal(
      broadcasts.find((b) => b.channel === "threads:changed").payload.length,
      1,
    );
  });

  it("rejects an active run before any session is stopped or deleted", async () => {
    const idle = addThread(projectA.id, "idle");
    const working = addThread(projectA.id, "working");
    const other = addThread(projectB.id, "other");
    const sIdle = runner.plant(idle.id);
    const sWorking = runner.plant(working.id);
    const sOther = runner.plant(other.id);
    runner.running.add(working.id);

    await assert.rejects(
      () => IPC_HANDLERS["projects:remove"](ctx(), { projectId: projectA.id }),
      /Cannot remove a project while a run is active/,
    );

    assert.ok(store.getProject(projectA.id));
    assert.ok(store.getThread(idle.id));
    assert.ok(store.getThread(working.id));
    assert.equal(sIdle.child.killed, false);
    assert.equal(sWorking.child.killed, false);
    assert.equal(sOther.child.killed, false);
    assert.equal(runner.sessions.size, 3);
    assert.equal(
      broadcasts.some((b) => b.channel === "threads:changed"),
      false,
    );
  });

  it("is harmless when dispose is repeated or the session already exited", async () => {
    const thread = addThread(projectA.id, "gone");
    const sess = runner.plant(thread.id);
    runner.disposeClaudeSession(thread.id);
    runner.disposeClaudeSession(thread.id);
    assert.equal(sess.child.killCalls, 1);
    assert.equal(runner.sessions.has(thread.id), false);

    await IPC_HANDLERS["projects:remove"](ctx(), { projectId: projectA.id });
    assert.equal(store.getProject(projectA.id), null);
    assert.equal(sess.child.killCalls, 1, "already-killed handle must not be re-killed");
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });
});

describe("projects:remove reaps real runner fake-child keep-alives (#1227)", () => {
  let tmpDir;
  let store;
  let runner;
  let pidsDir;
  let prevSimulate;
  let prevAgentCmd;
  let prevClaudeBin;
  let prevGrokMcpDisable;
  let prevGrokBin;
  let prevPidsDir;
  let prevSession;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevClaudeBin = process.env.CODER_CLAUDE_BIN;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevPidsDir = process.env.CODER_FAKE_CLAUDE_PIDS_DIR;
    prevSession = process.env.CODER_FAKE_CLAUDE_SESSION;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = "no-grok-not-a-real-binary";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-rm-proj-cli-"));
    pidsDir = path.join(tmpDir, "pids");
    fs.mkdirSync(pidsDir);
    process.env.CODER_CLAUDE_BIN = writeKeepAliveFakeClaude(tmpDir);
    process.env.CODER_FAKE_CLAUDE_PIDS_DIR = pidsDir;

    store = new Store(path.join(tmpDir, "store.json"));
    const core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn() {},
      tickMs: 15,
      userDataPath: tmpDir,
    });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevClaudeBin === undefined) delete process.env.CODER_CLAUDE_BIN;
    else process.env.CODER_CLAUDE_BIN = prevClaudeBin;
    if (prevGrokMcpDisable === undefined) {
      delete process.env.CODER_GROK_MCP_DISABLE;
    } else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevPidsDir === undefined) delete process.env.CODER_FAKE_CLAUDE_PIDS_DIR;
    else process.env.CODER_FAKE_CLAUDE_PIDS_DIR = prevPidsDir;
    if (prevSession === undefined) delete process.env.CODER_FAKE_CLAUDE_SESSION;
    else process.env.CODER_FAKE_CLAUDE_SESSION = prevSession;
  });

  async function addProject(name) {
    const repo = path.join(tmpDir, name);
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    return services.addProject(store, repo);
  }

  function addThread(projectId, title) {
    return services.createThread(store, {
      projectId,
      title,
      provider: "claude",
    });
  }

  function pidFile(session) {
    return path.join(pidsDir, session);
  }

  async function finishKeepAliveTurn(threadId, session) {
    process.env.CODER_FAKE_CLAUDE_SESSION = session;
    await runner.startRun({ threadId, prompt: "one turn" });
    await waitFor(() => store.getThread(threadId).status === "done");
    await waitFor(() => readPid(pidFile(session)) > 0);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      runner.isRunning(threadId),
      false,
      "Solenta turn must have ended before idle retirement",
    );
    const pid = readPid(pidFile(session));
    assert.equal(processAlive(pid), true, "keep-alive must survive turn settle");
    return pid;
  }

  function ipcCtx() {
    return makeCtx({
      store,
      runner,
      broadcast() {},
      worktreeBase: "",
      userDataPath: tmpDir,
    });
  }

  it("kills idle children for the removed project and leaves the other project's CLI", async () => {
    const projectA = await addProject("repo-a");
    const projectB = await addProject("repo-b");
    const a1 = addThread(projectA.id, "A1");
    const a2 = addThread(projectA.id, "A2");
    const b1 = addThread(projectB.id, "B1");

    const pidA1 = await finishKeepAliveTurn(a1.id, "sess-a1");
    const pidA2 = await finishKeepAliveTurn(a2.id, "sess-a2");
    const pidB1 = await finishKeepAliveTurn(b1.id, "sess-b1");
    const liveBefore = liveClaudeChildren.size;
    assert.ok(liveBefore >= 3, "three warm CLIs must be tracked");

    await IPC_HANDLERS["threads:delete"](ipcCtx(), { threadId: a1.id });
    await waitFor(() => !processAlive(pidA1), { timeoutMs: 5000 });
    assert.equal(processAlive(pidA2), true, "sibling keep-alive must survive thread delete");
    assert.equal(processAlive(pidB1), true);

    await IPC_HANDLERS["projects:remove"](ipcCtx(), { projectId: projectA.id });
    await waitFor(() => !processAlive(pidA2), { timeoutMs: 5000 });
    assert.equal(processAlive(pidB1), true, "other project's keep-alive must stay");
    assert.equal(store.getProject(projectA.id), null);
    assert.equal(store.getThread(a2.id), null);
    assert.ok(store.getProject(projectB.id));
    assert.ok(store.getThread(b1.id));
    await waitFor(() => liveClaudeChildren.size === 1, { timeoutMs: 5000 });
  });

  it("does not reap an idle child when the active-run guard rejects", async () => {
    const projectA = await addProject("repo-guard");
    const idle = addThread(projectA.id, "idle");
    const working = addThread(projectA.id, "working");
    const pidIdle = await finishKeepAliveTurn(idle.id, "sess-guard-idle");
    store.updateThread(working.id, { status: "working" });
    store.saveNow();

    await assert.rejects(
      () => IPC_HANDLERS["projects:remove"](ipcCtx(), { projectId: projectA.id }),
      /Cannot remove a project while a run is active/,
    );
    assert.equal(processAlive(pidIdle), true, "guard must not stop idle sessions");
    assert.ok(store.getProject(projectA.id));
    assert.ok(store.getThread(idle.id));
    assert.ok(store.getThread(working.id));
  });

  it("reuses the warm CLI on the next ordinary turn", async () => {
    const project = await addProject("repo-reuse");
    const thread = addThread(project.id, "reuse");
    const pid1 = await finishKeepAliveTurn(thread.id, "sess-reuse");

    await runner.startRun({ threadId: thread.id, prompt: "turn two" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    const pid2 = readPid(pidFile("sess-reuse"));
    assert.equal(pid2, pid1, "second turn must reuse the kept-alive child");
    assert.equal(processAlive(pid1), true);
  });

  it("still removes the project after the child has already exited", async () => {
    const project = await addProject("repo-exited");
    const thread = addThread(project.id, "exited");
    const pid = await finishKeepAliveTurn(thread.id, "sess-exited");
    runner.disposeClaudeSession(thread.id);
    runner.disposeClaudeSession(thread.id);
    await waitFor(() => !processAlive(pid), { timeoutMs: 5000 });

    const broadcasts = [];
    const ctx = makeCtx({
      store,
      runner,
      broadcast(channel, payload) {
        broadcasts.push({ channel, payload });
      },
      worktreeBase: "",
      userDataPath: tmpDir,
    });
    await IPC_HANDLERS["projects:remove"](ctx, { projectId: project.id });
    assert.equal(store.getProject(project.id), null);
    assert.ok(broadcasts.some((b) => b.channel === "threads:changed"));
  });
});
