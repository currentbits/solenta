const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const {
  createOrchServer,
  createToolHandlers,
} = require("../orchServer.js");
const {
  createMemorySupervisor,
  getClaudeMcpArgs,
  getCodexMcpArgs,
  ensureKimiMcpConfig,
  registerMcpServer,
  unregisterMcpServer,
  resetMemorySupForTests,
} = require("../memory-sup.js");

const APP_PATH = path.join(__dirname, "..", "..");

function waitFor(predicate, { timeoutMs = 10000, intervalMs = 30 } = {}) {
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

/** Fake store over plain data, matching the Store read API. */
function makeFakeStore() {
  const threads = [
    {
      id: "t1",
      title: "First",
      provider: "claude",
      status: "idle",
      handoffFrom: null,
    },
    {
      id: "t2",
      title: "Second",
      provider: "codex",
      status: "working",
      handoffFrom: "t1",
    },
    {
      id: "t3",
      title: "Broken",
      provider: "grok",
      status: "failed",
      handoffFrom: null,
    },
  ];
  const messagesByThread = {
    t1: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "first line\nsecond line" },
    ],
    t2: [{ role: "user", text: "only user" }],
    t3: [
      { role: "user", text: "do it" },
      { role: "assistant", text: "starting" },
      { role: "event", text: "Allowed: something" },
      { role: "event", text: "Run error: result subtype error_during_execution" },
    ],
  };
  return {
    getThreads: () => threads,
    getThread: (id) => threads.find((t) => t.id === id) || null,
    getMessages: (id) => messagesByThread[id] || [],
  };
}

function makeDeps() {
  const runs = [];
  const forks = [];
  const deps = {
    store: makeFakeStore(),
    runner: {
      startRun: async (input) => {
        runs.push(input);
        return { runId: "r" + runs.length };
      },
    },
    forkThread: (store, input) => {
      forks.push(input);
      return { id: "fork-" + forks.length };
    },
    getProvider: (id) =>
      ["claude", "codex", "kimi", "grok", "opencode"].includes(id)
        ? { id }
        : null,
    runs,
    forks,
  };
  return deps;
}

describe("orch-server tool handlers", () => {
  it("threads_list maps id, title, provider, status, handoffFrom", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const list = await h.threads_list();
    assert.deepEqual(list, [
      {
        id: "t1",
        title: "First",
        provider: "claude",
        status: "idle",
        handoffFrom: null,
      },
      {
        id: "t2",
        title: "Second",
        provider: "codex",
        status: "working",
        handoffFrom: "t1",
      },
      {
        id: "t3",
        title: "Broken",
        provider: "grok",
        status: "failed",
        handoffFrom: null,
      },
    ]);
  });

  it("thread_fork forks then starts a run on the new thread", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_fork({
      threadId: "t1",
      provider: "codex",
      prompt: "take over",
    });
    assert.deepEqual(out, { threadId: "fork-1" });
    assert.deepEqual(deps.forks, [{ threadId: "t1", provider: "codex" }]);
    assert.deepEqual(deps.runs, [{ threadId: "fork-1", prompt: "take over" }]);
  });

  it("thread_fork omits provider key when not given", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await h.thread_fork({ threadId: "t1", prompt: "go" });
    assert.deepEqual(deps.forks, [{ threadId: "t1" }]);
  });

  it("thread_fork rejects unknown thread and unknown provider", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    await assert.rejects(
      () => h.thread_fork({ threadId: "nope", prompt: "x" }),
      /Unknown thread: nope/,
    );
    await assert.rejects(
      () => h.thread_fork({ threadId: "t1", provider: "nope", prompt: "x" }),
      /Unknown provider: nope/,
    );
    assert.equal(deps.forks.length, 0);
    assert.equal(deps.runs.length, 0);
  });

  it("thread_send starts a run; rejects unknown thread", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    const out = await h.thread_send({ threadId: "t2", prompt: "ping" });
    assert.deepEqual(out, { threadId: "t2" });
    assert.deepEqual(deps.runs, [{ threadId: "t2", prompt: "ping" }]);
    await assert.rejects(
      () => h.thread_send({ threadId: "ghost", prompt: "x" }),
      /Unknown thread: ghost/,
    );
  });

  it("thread_status returns first line of last assistant text", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    assert.deepEqual(await h.thread_status({ threadId: "t1" }), {
      status: "idle",
      title: "First",
      provider: "claude",
      lastAssistantText: "first line",
      lastError: null,
    });
    // No assistant message: null.
    assert.deepEqual(await h.thread_status({ threadId: "t2" }), {
      status: "working",
      title: "Second",
      provider: "codex",
      lastAssistantText: null,
      lastError: null,
    });
    await assert.rejects(
      () => h.thread_status({ threadId: "ghost" }),
      /Unknown thread: ghost/,
    );
  });

  it("thread_status surfaces the Run error event on failed threads", async () => {
    const deps = makeDeps();
    const h = createToolHandlers(deps);
    assert.deepEqual(await h.thread_status({ threadId: "t3" }), {
      status: "failed",
      title: "Broken",
      provider: "grok",
      lastAssistantText: "starting",
      lastError: "Run error: result subtype error_during_execution",
    });
  });
});

/**
 * POST a JSON-RPC message to /mcp and parse the SSE response payload.
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function mcpPost(port, token, message, { auth = "bearer" } = {}) {
  const url =
    auth === "query"
      ? `http://127.0.0.1:${port}/mcp?token=${token}`
      : `http://127.0.0.1:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (auth === "bearer") headers.authorization = `Bearer ${token}`;
  if (auth === "wrong") headers.authorization = "Bearer wrong-token";
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const text = await res.text();
  let body = null;
  const dataLine = text
    .split("\n")
    .find((l) => l.startsWith("data:"));
  if (dataLine) {
    body = JSON.parse(dataLine.slice("data:".length).trim());
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

describe("orch-server HTTP", () => {
  let tmpDir;
  let logs;
  let prevEnv;
  /** @type {Array<ReturnType<typeof createOrchServer>>} */
  let servers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-"));
    logs = [];
    servers = [];
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    // Keep provider side effects inside the test dir / turned off.
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok-not-a-real-binary");
    resetMemorySupForTests();
  });

  afterEach(() => {
    for (const s of servers) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startOrch(overrides = {}) {
    const deps = makeDeps();
    const orch = createOrchServer({
      store: deps.store,
      runner: deps.runner,
      userDataPath: tmpDir,
      appPath: APP_PATH,
      log: (m) => logs.push(m),
      forkThread: deps.forkThread,
      getProvider: deps.getProvider,
      ...overrides,
    });
    servers.push(orch);
    await orch.start();
    return { orch, deps };
  }

  it("persists orch-server.json and serves /health without auth", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    assert.equal(st.running, true);
    assert.ok(st.port > 0);

    const cfgPath = path.join(tmpDir, "orch-server.json");
    assert.ok(fs.existsSync(cfgPath));
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.port, st.port);
    assert.ok(cfg.token.length >= 16);

    const health = await fetch(`http://127.0.0.1:${st.port}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
  });

  it("rejects /mcp without a token or with a wrong token", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };
    assert.equal((await mcpPost(st.port, "", init, { auth: "none" })).status, 401);
    assert.equal(
      (await mcpPost(st.port, "", init, { auth: "wrong" })).status,
      401,
    );
  });

  it("serves initialize and tools/list with bearer or query token", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
    );

    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };
    const viaBearer = await mcpPost(st.port, cfg.token, init);
    assert.equal(viaBearer.status, 200);
    assert.equal(viaBearer.body.result.serverInfo.name, "coder-threads");

    const viaQuery = await mcpPost(st.port, cfg.token, init, {
      auth: "query",
    });
    assert.equal(viaQuery.status, 200);

    const list = await mcpPost(st.port, cfg.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(list.status, 200);
    const names = list.body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "thread_fork",
      "thread_send",
      "thread_status",
      "threads_list",
    ]);
  });

  it("tools/call threads_list runs the handler over HTTP", async () => {
    const { orch } = await startOrch();
    const st = orch.getStatus();
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
    );
    const res = await mcpPost(st.port, cfg.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "threads_list", arguments: {} },
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body.result.content[0].text);
    assert.equal(payload.length, 3);
    assert.equal(payload[0].id, "t1");
  });

  it("fails soft on a corrupt config: logs once, stays down", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "orch-server.json"),
      "{ not json !!!",
      "utf8",
    );
    const { orch } = await startOrch();
    assert.equal(orch.getStatus().running, false);
    assert.ok(logs.some((m) => /orch-server: invalid config/.test(String(m))));
  });

  it("fails soft when the persisted port cannot bind", async () => {
    // Occupy a port, persist a config pointing at it, then start.
    const port = await freePort();
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "orch-server.json"),
        JSON.stringify({ port, token: "t".repeat(32) }),
        "utf8",
      );
      const { orch } = await startOrch();
      assert.equal(orch.getStatus().running, false);
      assert.ok(
        logs.some((m) => /orch-server: cannot bind/.test(String(m))),
        `expected bind-failure log, got: ${JSON.stringify(logs)}`,
      );
      // No server registered: no claude/codex args from the orch side.
      assert.equal(getClaudeMcpArgs().length, 0);
      assert.equal(getCodexMcpArgs().length, 0);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe("orch-server provider injection", () => {
  let tmpDir;
  let logs;
  let prevEnv;
  let servers;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-orch-inj-"));
    logs = [];
    servers = [];
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_KIMI_BIN = path.join(tmpDir, "no-kimi");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok-not-a-real-binary");
    resetMemorySupForTests();
  });

  afterEach(() => {
    for (const s of servers) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Adopt a fake memory server so coder-memory is healthy too. */
  async function adoptMemory(port, token) {
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({ port, token, dbPath: path.join(tmpDir, "db") }),
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
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
    });
    await sup.start();
    return { sup, server };
  }

  async function startOrch(env) {
    const deps = makeDeps();
    const orch = createOrchServer({
      store: deps.store,
      runner: deps.runner,
      userDataPath: tmpDir,
      appPath: APP_PATH,
      log: (m) => logs.push(m),
      env,
      forkThread: deps.forkThread,
      getProvider: deps.getProvider,
    });
    servers.push(orch);
    await orch.start();
    return orch;
  }

  it("claude config and args list both servers; stop drops coder-threads", async () => {
    const memPort = await freePort();
    const memToken = "mem-tok";
    const { sup, server } = await adoptMemory(memPort, memToken);
    try {
      const orch = await startOrch();
      const orchPort = orch.getStatus().port;
      const orchToken = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
      ).token;

      const args = getClaudeMcpArgs();
      assert.equal(args.length, 2);
      assert.equal(
        args[1],
        "--allowedTools=mcp__coder-memory__* mcp__coder-threads__*",
      );
      const mcpPath = args[0].slice("--mcp-config=".length);
      const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(
        doc.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${memPort}/mcp`,
      );
      assert.deepEqual(doc.mcpServers["coder-threads"], {
        type: "http",
        url: `http://127.0.0.1:${orchPort}/mcp`,
        headers: { Authorization: `Bearer ${orchToken}` },
      });

      orch.stop();
      const after = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.ok(after.mcpServers["coder-memory"]);
      assert.equal(after.mcpServers["coder-threads"], undefined);
      assert.equal(
        getClaudeMcpArgs()[1],
        "--allowedTools=mcp__coder-memory__*",
      );
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("codex args carry one -c pair per server", async () => {
    const memPort = await freePort();
    const memToken = "mem-tok";
    const { sup, server } = await adoptMemory(memPort, memToken);
    try {
      const orch = await startOrch();
      const orchPort = orch.getStatus().port;
      const orchToken = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
      ).token;
      assert.deepEqual(getCodexMcpArgs(), [
        "-c",
        `mcp_servers.coder-memory.url="http://127.0.0.1:${memPort}/mcp?token=${memToken}"`,
        "-c",
        `mcp_servers.coder-threads.url="http://127.0.0.1:${orchPort}/mcp?token=${orchToken}"`,
      ]);
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("kimi mcp.json merge gains coder-threads alongside coder-memory", async () => {
    const memPort = await freePort();
    const { sup, server } = await adoptMemory(memPort, "mem-tok");
    try {
      const orch = await startOrch();
      const orchPort = orch.getStatus().port;
      const orchToken = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "orch-server.json"), "utf8"),
      ).token;
      const ok = ensureKimiMcpConfig({
        log: (m) => logs.push(m),
        isKimiAvailable: () => true,
      });
      assert.equal(ok, true);
      const doc = JSON.parse(
        fs.readFileSync(process.env.CODER_KIMI_MCP_PATH, "utf8"),
      );
      assert.equal(
        doc.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${memPort}/mcp`,
      );
      assert.equal(
        doc.mcpServers["coder-threads"].url,
        `http://127.0.0.1:${orchPort}/mcp`,
      );
      assert.equal(
        doc.mcpServers["coder-threads"].headers.Authorization,
        `Bearer ${orchToken}`,
      );
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("grok mcp add runs once per server", async () => {
    const argvFile = path.join(tmpDir, "grok-argv.jsonl");
    const fakeGrok = path.join(tmpDir, "fake-grok");
    fs.writeFileSync(
      fakeGrok,
      `#!/usr/bin/env node
"use strict";
const fs = require("fs");
fs.appendFileSync(
  ${JSON.stringify(argvFile)},
  JSON.stringify(process.argv.slice(2)) + "\\n",
  "utf8",
);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const memPort = await freePort();
    const { sup, server } = await adoptMemory(memPort, "mem-tok");
    try {
      const env = { ...process.env, CODER_GROK_BIN: fakeGrok };
      delete env.CODER_GROK_MCP_DISABLE;
      const orch = await startOrch(env);
      assert.equal(orch.getStatus().running, true);

      await waitFor(() => {
        if (!fs.existsSync(argvFile)) return false;
        const lines = fs
          .readFileSync(argvFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        return lines.length >= 2;
      });
      const adds = fs
        .readFileSync(argvFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const names = adds.map((a) => a[2]).sort();
      assert.deepEqual(names, ["coder-memory", "coder-threads"]);
      const threadsAdd = adds.find((a) => a[2] === "coder-threads");
      assert.equal(threadsAdd[0], "mcp");
      assert.equal(threadsAdd[1], "add");
      assert.ok(
        threadsAdd[3].startsWith(
          `http://127.0.0.1:${orch.getStatus().port}/mcp`,
        ),
      );
      assert.ok(threadsAdd.includes("-s"));
      assert.ok(threadsAdd.includes("user"));
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("register/unregister validate input and keep memory-only output stable", () => {
    assert.equal(registerMcpServer({ name: "", port: 1, token: "x" }), false);
    assert.equal(
      registerMcpServer({ name: "coder-memory", port: 1, token: "x" }),
      false,
    );
    assert.equal(
      registerMcpServer({ name: "coder-threads", port: 0, token: "x" }),
      false,
    );
    assert.equal(
      registerMcpServer({ name: "coder-threads", port: 1234, token: "" }),
      false,
    );
    assert.equal(unregisterMcpServer("coder-threads"), false);
    // Nothing healthy, nothing registered: no args.
    assert.equal(getClaudeMcpArgs().length, 0);
    assert.equal(getCodexMcpArgs().length, 0);
  });
});
