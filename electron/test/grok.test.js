"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { Store } = require("../store.js");
const services = require("../services.js");
const { createRunner } = require("../runner.js");
const { getProvider } = require("../providers.js");

const TOKEN = "test-bearer-token-64chars-abcdefghijklmnopqrstuvwxyz012345";

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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

/**
 * Fake memory HTTP server that captures POST /api/store bodies.
 */
function startCaptureServer(port, token) {
  /** @type {object[]} */
  const bodies = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "POST" && url.pathname === "/api/store") {
        try {
          bodies.push(JSON.parse(body || "{}"));
        } catch {
          bodies.push({ _raw: body });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "run-stored-1" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        bodies,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
    server.on("error", reject);
  });
}

/**
 * Write a fake grok CLI. Reads CODER_FAKE_GROK_SCENARIO and optional
 * CODER_FAKE_GROK_ARGV_FILE. Emits streaming-messages-json NDJSON (claude shape).
 * @param {string} dir
 * @returns {string} path to the fake binary
 */
function writeFakeGrok(dir) {
  const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");

if (process.env.CODER_FAKE_GROK_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_GROK_ARGV_FILE,
    JSON.stringify(process.argv.slice(1)),
    "utf8",
  );
}

// mcp add path: capture and exit (used by ensureGrokMcpConfig tests)
if (process.argv[2] === "mcp" || process.argv[1] && process.argv.slice(1)[0] === "mcp") {
  const args = process.argv.slice(1);
  if (args[0] === "mcp" || args[1] === "mcp") {
    if (process.env.CODER_FAKE_GROK_MCP_ARGV_FILE) {
      fs.writeFileSync(
        process.env.CODER_FAKE_GROK_MCP_ARGV_FILE,
        JSON.stringify(args[0] === "mcp" ? args : args.slice(1)),
        "utf8",
      );
    }
    process.exit(0);
    return;
  }
}

const scenario = process.env.CODER_FAKE_GROK_SCENARIO || "success";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

async function main() {
  if (scenario === "fail-exit") {
    process.stderr.write("grok-stderr-boom\\n");
    process.exit(2);
    return;
  }

  if (scenario === "success") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "grok-sess-001",
      model: "grok-4.5",
    });
    await delay(20);
    emit({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "planning" },
          { type: "text", text: "Hello from grok" },
        ],
      },
    });
    await delay(20);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hello from grok",
      usage: { input_tokens: 80, output_tokens: 40 },
      total_cost_usd: 0.02,
      num_turns: 1,
      session_id: "grok-sess-001",
    });
    process.exit(0);
    return;
  }

  if (scenario === "resume-turn") {
    emit({
      type: "system",
      subtype: "init",
      session_id: "grok-sess-001",
      model: "grok-4.5",
    });
    await delay(15);
    emit({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Second grok turn" }],
      },
    });
    await delay(15);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Second grok turn",
      usage: { input_tokens: 30, output_tokens: 15 },
      total_cost_usd: 0.005,
      num_turns: 2,
      session_id: "grok-sess-001",
    });
    process.exit(0);
    return;
  }

  process.stderr.write("unknown scenario " + scenario + "\\n");
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(String(e) + "\\n");
  process.exit(1);
});
`;
  const launcher = path.join(dir, "fake-grok");
  fs.writeFileSync(launcher, body, { mode: 0o755 });
  return launcher;
}

describe("grok provider registry", () => {
  it("is claude-stream with resume, models, and structured buildArgs", () => {
    const grok = getProvider("grok");
    assert.equal(grok.kind, "claude-stream");
    assert.equal(grok.supportsResume, true);
    assert.deepEqual(grok.models, ["grok-4.5"]);
    assert.equal(grok.binEnv, "CODER_GROK_BIN");
    assert.equal(grok.defaultBin, "grok");

    const first = grok.buildArgs({
      prompt: "hello",
      permissionMode: "default",
    });
    // -p/--single <PROMPT> is last so flags cannot swallow the prompt.
    assert.equal(first[first.length - 2], "-p");
    assert.equal(first[first.length - 1], "hello");
    assert.ok(first.includes("--output-format"));
    assert.ok(first.includes("streaming-messages-json"));
    assert.ok(first.includes("--permission-mode"));
    // Headless grok cannot prompt: asking modes are mapped to "auto"
    // (issue #3 — default mode auto-cancels the first gated tool).
    assert.ok(first.includes("auto"));
    assert.ok(!first.includes("default"));
    assert.ok(!first.includes("--resume"));
    assert.ok(!first.includes("--verbose"));
    assert.ok(!first.some((a) => String(a).startsWith("--mcp-config")));
    assert.ok(!first.includes("stream-json"));

    for (const [mode, expected] of [
      ["default", "auto"],
      ["acceptEdits", "auto"],
      ["bypassPermissions", "bypassPermissions"],
      ["plan", "plan"],
    ]) {
      const args = grok.buildArgs({ prompt: "p", permissionMode: mode });
      const idx = args.indexOf("--permission-mode");
      assert.ok(idx >= 0, mode);
      assert.equal(args[idx + 1], expected, mode);
    }

    const withModel = grok.buildArgs({
      prompt: "p",
      model: "grok-4.5",
      permissionMode: "plan",
    });
    const mIdx = withModel.indexOf("-m");
    assert.ok(mIdx >= 0);
    assert.equal(withModel[mIdx + 1], "grok-4.5");
    assert.ok(!withModel.includes("--model"));

    const resume = grok.buildArgs({
      prompt: "again",
      sessionId: "sess-g-9",
      permissionMode: "default",
    });
    const rIdx = resume.indexOf("--resume");
    assert.ok(rIdx >= 0);
    assert.equal(resume[rIdx + 1], "sess-g-9");
  });
});

describe("runner grok provider (claude-stream path)", () => {
  let tmpDir;
  let store;
  let runner;
  let core;
  let prevSimulate;
  let prevAgentCmd;
  let prevGrokBin;
  let prevScenario;
  let prevArgvFile;
  let fakeGrok;
  let argvFile;

  let prevGrokMcpDisable;

  beforeEach(async () => {
    prevSimulate = process.env.CODER_SIMULATE;
    prevAgentCmd = process.env.CODER_AGENT_CMD;
    prevGrokBin = process.env.CODER_GROK_BIN;
    prevScenario = process.env.CODER_FAKE_GROK_SCENARIO;
    prevArgvFile = process.env.CODER_FAKE_GROK_ARGV_FILE;
    prevGrokMcpDisable = process.env.CODER_GROK_MCP_DISABLE;

    delete process.env.CODER_SIMULATE;
    delete process.env.CODER_AGENT_CMD;
    // Kill switch when any test starts a memory supervisor (mcp add -s user
    // has no path override). Fake bin still used for run paths.
    process.env.CODER_GROK_MCP_DISABLE = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-"));
    fakeGrok = writeFakeGrok(tmpDir);
    argvFile = path.join(tmpDir, "argv.json");
    process.env.CODER_GROK_BIN = fakeGrok;
    process.env.CODER_FAKE_GROK_ARGV_FILE = argvFile;

    store = new Store(path.join(tmpDir, "store.json"));
    core = await loadCore();
    runner = createRunner({
      store,
      core,
      pushFn: () => {},
      tickMs: 15,
    });

    const repo = path.join(tmpDir, "app");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    const project = services.addProject(store, repo);
    const thread = services.createThread(store, {
      projectId: project.id,
      title: "Grok Thread",
    });
    services.setProvider(store, { threadId: thread.id, provider: "grok" });
  });

  afterEach(() => {
    if (runner) runner.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevSimulate === undefined) delete process.env.CODER_SIMULATE;
    else process.env.CODER_SIMULATE = prevSimulate;
    if (prevAgentCmd === undefined) delete process.env.CODER_AGENT_CMD;
    else process.env.CODER_AGENT_CMD = prevAgentCmd;
    if (prevGrokBin === undefined) delete process.env.CODER_GROK_BIN;
    else process.env.CODER_GROK_BIN = prevGrokBin;
    if (prevScenario === undefined) delete process.env.CODER_FAKE_GROK_SCENARIO;
    else process.env.CODER_FAKE_GROK_SCENARIO = prevScenario;
    if (prevArgvFile === undefined) delete process.env.CODER_FAKE_GROK_ARGV_FILE;
    else process.env.CODER_FAKE_GROK_ARGV_FILE = prevArgvFile;
    if (prevGrokMcpDisable === undefined) delete process.env.CODER_GROK_MCP_DISABLE;
    else process.env.CODER_GROK_MCP_DISABLE = prevGrokMcpDisable;
  });

  it("first turn argv: -p prompt, streaming-messages-json, no --resume/--verbose/--mcp-config", async () => {
    process.env.CODER_FAKE_GROK_SCENARIO = "success";
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "do the thing" });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const pIdx = argv.indexOf("-p");
    assert.ok(pIdx >= 0, `expected -p in ${JSON.stringify(argv)}`);
    assert.equal(argv[pIdx + 1], "do the thing");
    assert.ok(argv.includes("--output-format"));
    assert.ok(argv.includes("streaming-messages-json"));
    assert.ok(argv.includes("--permission-mode"));
    // default is mapped to auto for headless grok (issue #3).
    assert.ok(argv.includes("auto"));
    assert.ok(!argv.includes("--resume"));
    assert.ok(!argv.includes("--verbose"));
    assert.ok(!argv.some((a) => String(a).startsWith("--mcp-config")));
    assert.ok(!argv.includes("stream-json"));

    assert.equal(store.getThread(thread.id).sessionId, "grok-sess-001");
    const assistants = store
      .getMessages(thread.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, "Hello from grok");

    const usage = store.getUsage(thread.id);
    assert.ok(usage);
    assert.equal(usage.model, "grok-4.5");
    assert.equal(usage.inputTokens, 80);
    assert.equal(usage.outputTokens, 40);
    assert.equal(usage.costUsd, 0.02);
    assert.equal(usage.turns, 1);
  });

  it("second turn passes --resume with captured session id", async () => {
    process.env.CODER_FAKE_GROK_SCENARIO = "success";
    const thread = store.getThreads()[0];

    await runner.startRun({ threadId: thread.id, prompt: "turn one" });
    await waitFor(() => store.getThread(thread.id).status === "done");
    assert.equal(store.getThread(thread.id).sessionId, "grok-sess-001");

    process.env.CODER_FAKE_GROK_SCENARIO = "resume-turn";
    fs.unlinkSync(argvFile);

    await runner.startRun({ threadId: thread.id, prompt: "turn two" });
    await waitFor(() => {
      const msgs = store.getMessages(thread.id);
      return msgs.some(
        (m) => m.role === "assistant" && m.text === "Second grok turn",
      );
    });
    await waitFor(() => store.getThread(thread.id).status === "done");

    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    const resumeIdx = argv.indexOf("--resume");
    assert.ok(resumeIdx >= 0, `expected --resume in ${JSON.stringify(argv)}`);
    assert.equal(argv[resumeIdx + 1], "grok-sess-001");
    assert.equal(argv[argv.indexOf("-p") + 1], "turn two");

    const usage = store.getUsage(thread.id);
    assert.equal(usage.inputTokens, 110);
    assert.equal(usage.outputTokens, 55);
    assert.ok(Math.abs(usage.costUsd - 0.025) < 1e-9);
    assert.equal(usage.turns, 2);
    assert.equal(usage.model, "grok-4.5");
  });

  it("maps asking modes to auto (headless cannot prompt) and propagates -m", async () => {
    process.env.CODER_FAKE_GROK_SCENARIO = "success";
    const project = store.getProjects()[0];

    for (const [mode, expected] of [
      ["default", "auto"],
      ["acceptEdits", "auto"],
      ["bypassPermissions", "bypassPermissions"],
      ["plan", "plan"],
    ]) {
      const t = services.createThread(store, {
        projectId: project.id,
        title: `mode-${mode}`,
      });
      services.setProvider(store, {
        threadId: t.id,
        provider: "grok",
        model: "grok-4.5",
      });
      store.updateThread(t.id, { permissionMode: mode });

      if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
      await runner.startRun({ threadId: t.id, prompt: `mode ${mode}` });
      await waitFor(() => store.getThread(t.id).status === "done");

      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      const pmIdx = argv.indexOf("--permission-mode");
      assert.ok(pmIdx >= 0, mode);
      assert.equal(argv[pmIdx + 1], expected, mode);
      const mIdx = argv.indexOf("-m");
      assert.ok(mIdx >= 0, mode);
      assert.equal(argv[mIdx + 1], "grok-4.5");
      assert.ok(!argv.includes("--verbose"));
      assert.ok(!argv.some((a) => String(a).startsWith("--mcp-config")));
    }
  });

  it("does not inject --mcp-config even when memory is healthy", async () => {
    const {
      resetMemorySupForTests,
      createMemorySupervisor,
      getClaudeMcpArgs,
    } = require("../memory-sup.js");

    resetMemorySupForTests();
    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-mem-"));
    const port = await freePort();
    fs.writeFileSync(
      path.join(memDir, "memory-server.json"),
      JSON.stringify({
        port,
        token: "mcp-test-token",
        dbPath: path.join(memDir, "db"),
      }),
      "utf8",
    );
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    try {
      // Point grok bin for ensureGrokMcpConfig at a no-op mcp-capturing binary;
      // keep run binary as fakeGrok via process.env after start.
      const noGrok = path.join(memDir, "no-grok-for-ensure");
      const sup = createMemorySupervisor({
        userDataPath: memDir,
        appPath: memDir,
        log: () => {},
        env: {
          ...process.env,
          // Defense in depth: never run real `grok mcp add` during tests.
          CODER_GROK_MCP_DISABLE: "1",
          CODER_GROK_BIN: noGrok,
          CODER_KIMI_BIN: path.join(memDir, "no-kimi"),
        },
      });
      await sup.start();
      assert.equal(sup.getStatus().running, true);
      assert.ok(getClaudeMcpArgs().some((a) => a.startsWith("--mcp-config=")));

      process.env.CODER_FAKE_GROK_SCENARIO = "success";
      if (fs.existsSync(argvFile)) fs.unlinkSync(argvFile);
      const thread = store.getThreads()[0];
      await runner.startRun({ threadId: thread.id, prompt: "with-mem" });
      await waitFor(() => store.getThread(thread.id).status === "done");
      const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
      assert.ok(
        !argv.some((a) => String(a).startsWith("--mcp-config")),
        `grok must not get --mcp-config: ${JSON.stringify(argv)}`,
      );
      assert.ok(!argv.includes("--verbose"));
      sup.stop();
    } finally {
      resetMemorySupForTests();
      await new Promise((r) => server.close(r));
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("auto-record footer shows non-zero tokens and grok model for a done run", async () => {
    const port = await freePort();
    const status = { running: true, adopted: true, port };
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token: TOKEN,
        dbPath: path.join(tmpDir, "m.db"),
      }),
      "utf8",
    );
    const fake = await startCaptureServer(port, TOKEN);
    try {
      runner.stopAll();
      runner = createRunner({
        store,
        core,
        pushFn: () => {},
        tickMs: 15,
        userDataPath: tmpDir,
        getMemoryStatus: () => status,
      });

      process.env.CODER_FAKE_GROK_SCENARIO = "success";
      const project = store.getProjects()[0];
      const thread = services.createThread(store, {
        projectId: project.id,
        title: "Grok record me",
      });
      services.setProvider(store, {
        threadId: thread.id,
        provider: "grok",
        model: "grok-4.5",
      });

      await runner.startRun({ threadId: thread.id, prompt: "record please" });
      await waitFor(() => store.getThread(thread.id).status === "done");
      await waitFor(() => fake.bodies.length >= 1, { timeoutMs: 5000 });

      const body = fake.bodies[0];
      assert.equal(body.type, "run");
      assert.ok(body.title.startsWith("grok run: "));
      assert.match(
        body.body,
        /provider=grok model=grok-4\.5 status=done tokens_in=80 tokens_out=40 cost_usd=0\.02/,
      );
    } finally {
      await fake.close();
    }
  });
});
