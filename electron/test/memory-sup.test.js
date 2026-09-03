const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  createMemorySupervisor,
  getClaudeMcpArgs,
  getCodexMcpArgs,
  getCodexMcpEnv,
  ensureKimiMcpConfig,
  ensureGrokMcpConfig,
  ensureCursorMcpConfig,
  removeGrokMcpEntries,
  removeCursorMcpEntries,
  registerMcpServer,
  unregisterMcpServer,
  resolveKimiMcpPath,
  resolveCursorMcpPath,
  resetMemorySupForTests,
  resolveNodeBinary,
  grokTomlLooksValid,
  whenGrokMcpIdle,
} = require("../memory-sup.js");
const { writeFakeBin } = require("./support/fakeBin.js");

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

/** Fake grok that holds the process ~80ms so overlapping spawns are observable. */
function slowGrokMcpBody() {
  return `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const log = process.env.CODER_FAKE_GROK_MCP_LOG;
function rec(ev) {
  fs.appendFileSync(
    log,
    JSON.stringify({
      ev,
      t: Date.now(),
      pid: process.pid,
      args: process.argv.slice(2),
    }) + "\\n",
  );
}
rec("start");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
rec("end");
process.exit(0);
`;
}

function grokMcpLog(logFile) {
  return fs
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function assertSerialGrokMcp(logFile, n) {
  const events = grokMcpLog(logFile);
  const byPid = new Map();
  for (const e of events) {
    if (!byPid.has(e.pid)) byPid.set(e.pid, {});
    byPid.get(e.pid)[e.ev] = e.t;
  }
  const intervals = [...byPid.values()];
  assert.equal(
    intervals.length,
    n,
    `expected ${n} grok mcp invocations, got ${intervals.length}: ${JSON.stringify(events)}`,
  );
  for (const iv of intervals) {
    assert.equal(typeof iv.start, "number");
    assert.equal(typeof iv.end, "number");
    assert.ok(iv.end >= iv.start);
  }
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i];
      const b = intervals[j];
      assert.equal(
        a.start < b.end && b.start < a.end,
        false,
        `overlapping grok mcp CLIs: ${JSON.stringify({ a, b })}`,
      );
    }
  }
}

/** Answer /health; HMAC-prove `token` when ?nonce= is present. */
function serveProvenHealth(token) {
  return (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/health") {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = { ok: true };
    const nonce = url.searchParams.get("nonce");
    if (nonce) {
      body.proof = crypto
        .createHmac("sha256", token)
        .update(nonce)
        .digest("hex");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

/**
 * Minimal fake memory server entry: HTTP /health and /mcp stub.
 * Reads CODER_MEMORY_CONFIG for port/token.
 */
function writeFakeMemoryEntry(dir) {
  const scriptPath = path.join(dir, "fake-memory-server.js");
  const body = `#!/usr/bin/env node
"use strict";
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const configPath = process.env.CODER_MEMORY_CONFIG;
if (!configPath) {
  console.error("missing CODER_MEMORY_CONFIG");
  process.exit(1);
}
// Like the real server: create the config on first run.
if (!fs.existsSync(configPath)) {
  const fresh = {
    port: 49500 + Math.floor(Math.random() * 500),
    token: "t".repeat(64),
    dbPath: configPath + ".db",
  };
  fs.writeFileSync(configPath, JSON.stringify(fresh), { mode: 0o600 });
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const port = Number(cfg.port);
if (!port) {
  console.error("invalid port");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    const body = { ok: true, port };
    const nonce = url.searchParams.get("nonce");
    if (nonce) {
      body.proof = crypto.createHmac("sha256", cfg.token).update(nonce).digest("hex");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end("nope");
});
server.listen(port, "127.0.0.1", () => {
  // ready
});
`;
  writeFakeBin(scriptPath, body);
  // Spawned as `node [entry]`, so callers need the JS path, not the .cmd.
  return scriptPath;
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

describe("memory-sup supervisor", () => {
  let tmpDir;
  let logs;
  let prevEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-memsup-"));
    logs = [];
    prevEnv = {
      CODER_NODE_BIN: process.env.CODER_NODE_BIN,
      CODER_MEMORY_ENTRY: process.env.CODER_MEMORY_ENTRY,
      CODER_MEMORY_CONFIG: process.env.CODER_MEMORY_CONFIG,
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      PATH: process.env.PATH,
    };
    // Keep ensureKimi writes inside the test dir if kimi is present.
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    // Defense in depth: kill switch + fake bin (mcp add -s user has no path override).
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok-not-a-real-binary");
    resetMemorySupForTests();
  });

  afterEach(() => {
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adopts an already-healthy server without spawning", async () => {
    const port = await freePort();
    const token = "test-token-adopt";
    const configPath = path.join(tmpDir, "memory-server.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "mem.db"),
      }),
      "utf8",
    );

    const server = http.createServer(serveProvenHealth(token));
    await new Promise((r) => server.listen(port, "127.0.0.1", r));

    try {
      const sup = createMemorySupervisor({
        userDataPath: tmpDir,
        appPath: path.join(tmpDir, "app"),
        log: (m) => logs.push(m),
      });
      await sup.start();
      const st = sup.getStatus();
      assert.equal(st.running, true);
      assert.equal(st.adopted, true);
      assert.equal(st.port, port);

      // Equals-form args only: the CLI's space forms are variadic and would
      // swallow the trailing prompt. The allow rule is required so headless
      // runs can actually call the memory tools instead of being denied.
      const mcpArgs = getClaudeMcpArgs();
      assert.equal(mcpArgs.length, 2);
      assert.ok(mcpArgs[0].startsWith("--mcp-config="));
      assert.equal(mcpArgs[1], "--allowedTools=mcp__coder-memory__*");
      assert.ok(!mcpArgs.some((a) => a === "--mcp-config" || a === "--allowedTools"));
      const mcpPath = mcpArgs[0].slice("--mcp-config=".length);
      assert.ok(fs.existsSync(mcpPath));
      const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(
        mcp.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
      assert.equal(
        mcp.mcpServers["coder-memory"].headers.Authorization,
        `Bearer ${token}`,
      );

      const codexArgs = getCodexMcpArgs();
      assert.equal(codexArgs.length, 6);
      assert.equal(codexArgs[0], "-c");
      assert.equal(
        codexArgs[1],
        `mcp_servers.coder-memory.url="http://127.0.0.1:${port}/mcp"`,
      );
      assert.equal(
        codexArgs[5],
        'mcp_servers.coder-memory.default_tools_approval_mode="approve"',
      );
      // The token rides the env, never argv (ps is world-readable).
      assert.ok(!codexArgs.some((a) => a.includes(token)));
      assert.deepEqual(getCodexMcpEnv(), {
        CODER_MCP_TOKEN_CODER_MEMORY: token,
      });

      // Per-run ?project= bind (issue #710). The global file stays bare so
      // concurrent runs cannot clobber each other.
      const boundClaude = getClaudeMcpArgs({ projectPath: "/tmp/alpha-project" });
      assert.ok(boundClaude[0].startsWith("--mcp-config="));
      const boundPath = boundClaude[0].slice("--mcp-config=".length);
      assert.notEqual(boundPath, mcpPath);
      const boundDoc = JSON.parse(fs.readFileSync(boundPath, "utf8"));
      assert.match(
        boundDoc.mcpServers["coder-memory"].url,
        /[?&]project=/,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers["coder-memory"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
      const boundCodex = getCodexMcpArgs({ projectPath: "/tmp/alpha-project" });
      assert.ok(
        boundCodex.some((a) => /project=/.test(String(a))),
        `expected bound codex url, got ${JSON.stringify(boundCodex)}`,
      );

      // Sleep-time consolidation (issue #722): memory-only MCP config does
      // not list coder-threads and does not pre-approve it.
      const threadsPort = await freePort();
      registerMcpServer({
        name: "coder-threads",
        port: threadsPort,
        token: "threads-tok",
        userDataPath: tmpDir,
      });
      const both = getClaudeMcpArgs();
      assert.equal(
        both[1],
        "--allowedTools=mcp__coder-memory__* mcp__coder-threads__*",
      );
      const memOnly = getClaudeMcpArgs({
        projectPath: tmpDir,
        memoryOnly: true,
      });
      assert.equal(memOnly.length, 2);
      assert.equal(memOnly[1], "--allowedTools=mcp__coder-memory__*");
      const memOnlyPath = memOnly[0].slice("--mcp-config=".length);
      assert.ok(memOnlyPath.endsWith("-memory.json"));
      assert.notEqual(memOnlyPath, mcpPath);
      const memOnlyDoc = JSON.parse(fs.readFileSync(memOnlyPath, "utf8"));
      assert.ok(memOnlyDoc.mcpServers["coder-memory"]);
      assert.equal(memOnlyDoc.mcpServers["coder-threads"], undefined);

      // Adopted: stop must not try to kill a child we never owned.
      sup.stop();
      // Server still up after stop
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.ok, true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("does not adopt a listener that cannot prove the token", async () => {
    const port = await freePort();
    const token = "squatter-token-xxxxxxxx";
    const configPath = path.join(tmpDir, "memory-server.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "mem.db"),
      }),
      "utf8",
    );

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, proof: "deadbeef" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => server.listen(port, "127.0.0.1", r));

    try {
      const sup = createMemorySupervisor({
        userDataPath: tmpDir,
        appPath: path.join(tmpDir, "app"),
        log: (m) => logs.push(m),
      });
      await sup.start();
      const st = sup.getStatus();
      assert.notEqual(st.adopted, true);
      assert.ok(
        logs.some((m) =>
          String(m).includes(`unverified listener on port ${port}`),
        ),
        `expected unverified-listener warning, got: ${JSON.stringify(logs)}`,
      );

      const mcpPath = path.join(tmpDir, "mcp-coder-memory.json");
      if (fs.existsSync(mcpPath)) {
        const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
        const url = mcp.mcpServers?.["coder-memory"]?.url || "";
        assert.ok(
          !url.includes(`:${port}`),
          `mcp config must not point at squatter port: ${url}`,
        );
      }
      const mcpArgs = getClaudeMcpArgs();
      assert.ok(
        !mcpArgs.some((a) => String(a).includes(`:${port}`)),
        `getClaudeMcpArgs must not point at squatter: ${JSON.stringify(mcpArgs)}`,
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("adopts a fake that serves the correct HMAC proof", async () => {
    const port = await freePort();
    const token = "proof-token-xxxxxxxx";
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "mem.db"),
      }),
      "utf8",
    );

    const server = http.createServer(serveProvenHealth(token));
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    try {
      const sup = createMemorySupervisor({
        userDataPath: tmpDir,
        appPath: path.join(tmpDir, "app"),
        log: (m) => logs.push(m),
      });
      await sup.start();
      const st = sup.getStatus();
      assert.equal(st.running, true);
      assert.equal(st.adopted, true);
      assert.equal(st.port, port);
      const mcpArgs = getClaudeMcpArgs();
      assert.ok(mcpArgs[0].startsWith("--mcp-config="));
      const mcpPath = mcpArgs[0].slice("--mcp-config=".length);
      const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(
        mcp.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
      assert.equal(
        mcp.mcpServers["coder-memory"].headers.Authorization,
        `Bearer ${token}`,
      );
      sup.stop();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("spawns fake entry when health is down and becomes healthy", async () => {
    const port = await freePort();
    const token = "spawn-token";
    const configPath = path.join(tmpDir, "memory-server.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "mem.db"),
      }),
      "utf8",
    );

    const entry = writeFakeMemoryEntry(tmpDir);
    process.env.CODER_MEMORY_ENTRY = entry;
    process.env.CODER_NODE_BIN = process.execPath;

    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: path.join(tmpDir, "app"),
      log: (m) => logs.push(m),
    });
    await sup.start();
    const st = sup.getStatus();
    assert.equal(st.running, true);
    assert.equal(st.adopted, false);
    assert.equal(st.port, port);

    // We spawned: stop should kill the child
    sup.stop();
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(200),
        });
        return false;
      } catch {
        return true;
      }
    });
  });

  it("degrades cleanly when no node binary is available", async () => {
    const port = await freePort();
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token: "t",
        dbPath: path.join(tmpDir, "db"),
      }),
      "utf8",
    );
    // Entry must exist so we reach the node-binary check (not entry-missing).
    const entry = writeFakeMemoryEntry(tmpDir);
    process.env.CODER_NODE_BIN = "/nonexistent/node-binary-xyz";
    process.env.PATH = "";
    process.env.CODER_MEMORY_ENTRY = entry;

    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
      env: {
        ...process.env,
        CODER_NODE_BIN: "/nonexistent/node-binary-xyz",
        PATH: "",
        CODER_MEMORY_ENTRY: entry,
      },
    });
    await sup.start();
    const st = sup.getStatus();
    assert.equal(st.running, false);
    assert.equal(st.adopted, false);
    assert.equal(getClaudeMcpArgs().length, 0);
    assert.equal(getCodexMcpArgs().length, 0);
    assert.ok(
      logs.some(
        (m) =>
          /memory/i.test(String(m)) &&
          /node|unavailable/i.test(String(m)),
      ),
      `expected node-unavailable log, got: ${JSON.stringify(logs)}`,
    );
  });

  it("degrades when memory-server entry file is missing", async () => {
    const port = await freePort();
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token: "t",
        dbPath: path.join(tmpDir, "db"),
      }),
      "utf8",
    );
    process.env.CODER_NODE_BIN = process.execPath;
    process.env.CODER_MEMORY_ENTRY = path.join(
      tmpDir,
      "no-such-memory-server.js",
    );

    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: path.join(tmpDir, "app-missing"),
      log: (m) => logs.push(m),
    });
    await sup.start();
    const st = sup.getStatus();
    assert.equal(st.running, false);
    assert.equal(getClaudeMcpArgs().length, 0);
    assert.ok(logs.some((m) => /memory/i.test(String(m))));
  });

  it("quit kills only a child we spawned (not an adopted server)", async () => {
    const port = await freePort();
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token: "own",
        dbPath: path.join(tmpDir, "db"),
      }),
      "utf8",
    );
    const entry = writeFakeMemoryEntry(tmpDir);
    process.env.CODER_MEMORY_ENTRY = entry;
    process.env.CODER_NODE_BIN = process.execPath;

    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
    });
    await sup.start();
    assert.equal(sup.getStatus().running, true);
    assert.equal(sup.getStatus().adopted, false);

    // Capture child pid via status if exposed, otherwise just stop and confirm port dies
    sup.stop();
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(200),
        });
        return !r.ok;
      } catch {
        return true;
      }
    });
  });

  it("no config file with entry present: spawns and picks up server-created config", async () => {
    const entry = writeFakeMemoryEntry(tmpDir);
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
      env: { ...process.env, CODER_MEMORY_ENTRY: entry },
    });
    await sup.start();
    try {
      assert.equal(sup.getStatus().running, true);
      assert.equal(sup.getStatus().adopted, false);
      assert.ok(fs.existsSync(path.join(tmpDir, "memory-server.json")));
      assert.ok(getClaudeMcpArgs().length > 0);
    } finally {
      sup.stop();
    }
  });

  it("no config and no entry: continues without memory", async () => {
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: path.join(tmpDir, "definitely-missing"),
      log: (m) => logs.push(m),
    });
    await sup.start();
    assert.equal(sup.getStatus().running, false);
    assert.equal(getClaudeMcpArgs().length, 0);
    assert.equal(getCodexMcpArgs().length, 0);
  });

  it("getCodexMcpArgs empty when unhealthy, populated when healthy", async () => {
    assert.equal(getCodexMcpArgs().length, 0);

    const port = await freePort();
    const token = "codex-token-xyz";
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "db"),
      }),
      "utf8",
    );
    const server = http.createServer(serveProvenHealth(token));
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    try {
      const sup = createMemorySupervisor({
        userDataPath: tmpDir,
        appPath: tmpDir,
        log: (m) => logs.push(m),
      });
      await sup.start();
      const args = getCodexMcpArgs();
      assert.deepEqual(args, [
        "-c",
        `mcp_servers.coder-memory.url="http://127.0.0.1:${port}/mcp"`,
        "-c",
        'mcp_servers.coder-memory.bearer_token_env_var="CODER_MCP_TOKEN_CODER_MEMORY"',
        "-c",
        'mcp_servers.coder-memory.default_tools_approval_mode="approve"',
      ]);
      assert.deepEqual(getCodexMcpEnv(), {
        CODER_MCP_TOKEN_CODER_MEMORY: token,
      });
      sup.stop();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("Codex first-party MCP servers auto-approve tools under exec never-policy (#846)", async () => {
    const port = await freePort();
    const token = "codex-approve-tok";
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "db"),
      }),
      "utf8",
    );
    const server = http.createServer(serveProvenHealth(token));
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    try {
      const sup = createMemorySupervisor({
        userDataPath: tmpDir,
        appPath: tmpDir,
        log: (m) => logs.push(m),
      });
      await sup.start();
      registerMcpServer({
        name: "coder-threads",
        port: await freePort(),
        token: "threads-tok",
        userDataPath: tmpDir,
      });
      const pairs = [];
      const args = getCodexMcpArgs();
      for (let i = 0; i < args.length; i += 2) {
        assert.equal(args[i], "-c");
        pairs.push(args[i + 1]);
      }
      assert.ok(
        pairs.includes(
          'mcp_servers.coder-memory.default_tools_approval_mode="approve"',
        ),
        `expected coder-memory auto-approve, got ${JSON.stringify(pairs)}`,
      );
      assert.ok(
        pairs.includes(
          'mcp_servers.coder-threads.default_tools_approval_mode="approve"',
        ),
        `expected coder-threads auto-approve, got ${JSON.stringify(pairs)}`,
      );
      sup.stop();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("ensureKimiMcpConfig", () => {
  let tmpDir;
  let logs;
  let prevEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-kimi-mcp-"));
    logs = [];
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "mcp.json");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok-not-a-real-binary");
    resetMemorySupForTests();
  });

  afterEach(() => {
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function markHealthyViaAdopt(port, token) {
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "db"),
      }),
      "utf8",
    );
    const server = http.createServer(serveProvenHealth(token));
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    // Disable auto-write by making kimi/grok unavailable during start; tests call ensure explicitly.
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
      env: {
        ...process.env,
        CODER_GROK_MCP_DISABLE: "1",
        CODER_KIMI_BIN: path.join(tmpDir, "no-kimi"),
        CODER_GROK_BIN: path.join(tmpDir, "no-grok-not-a-real-binary"),
      },
    });
    await sup.start();
    return { sup, server };
  }

  it("creates fresh mcp.json when missing", async () => {
    const port = await freePort();
    const token = "kimi-tok";
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      const mcpPath = process.env.CODER_KIMI_MCP_PATH;
      assert.ok(!fs.existsSync(mcpPath));
      const ok = ensureKimiMcpConfig({
        log: (m) => logs.push(m),
        isKimiAvailable: () => true,
      });
      assert.equal(ok, true);
      assert.ok(fs.existsSync(mcpPath));
      const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.deepEqual(doc.mcpServers["coder-memory"], {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      });
      // Fresh create: no backup
      assert.ok(!fs.existsSync(mcpPath + ".coder-backup"));
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("merges into existing file preserving foreign keys and backs up once", async () => {
    const port = await freePort();
    const token = "merge-tok";
    const mcpPath = process.env.CODER_KIMI_MCP_PATH;
    fs.writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          version: 1,
          otherTop: true,
          mcpServers: {
            foreign: { type: "stdio", command: "echo" },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      assert.equal(
        ensureKimiMcpConfig({
          log: (m) => logs.push(m),
          isKimiAvailable: () => true,
        }),
        true,
      );
      const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(doc.version, 1);
      assert.equal(doc.otherTop, true);
      assert.deepEqual(doc.mcpServers.foreign, {
        type: "stdio",
        command: "echo",
      });
      assert.equal(
        doc.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
      const backup = mcpPath + ".coder-backup";
      assert.ok(fs.existsSync(backup));
      const backupDoc = JSON.parse(fs.readFileSync(backup, "utf8"));
      assert.ok(!backupDoc.mcpServers["coder-memory"]);
      assert.deepEqual(backupDoc.mcpServers.foreign, {
        type: "stdio",
        command: "echo",
      });

      // Second write with same values: no backup overwrite (backup still original)
      const backupBefore = fs.readFileSync(backup, "utf8");
      assert.equal(
        ensureKimiMcpConfig({
          log: (m) => logs.push(m),
          isKimiAvailable: () => true,
        }),
        true,
      );
      assert.equal(fs.readFileSync(backup, "utf8"), backupBefore);
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("updates entry when port/token differ; does not overwrite existing backup", async () => {
    const port1 = await freePort();
    const token1 = "tok-a";
    const mcpPath = process.env.CODER_KIMI_MCP_PATH;
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "coder-memory": {
            type: "http",
            url: "http://127.0.0.1:1/mcp",
            headers: { Authorization: "Bearer old" },
          },
        },
      }),
      "utf8",
    );
    const existingBackup = mcpPath + ".coder-backup";
    fs.writeFileSync(existingBackup, '{"keep":true}\n', "utf8");

    const { sup, server } = await markHealthyViaAdopt(port1, token1);
    try {
      assert.equal(
        ensureKimiMcpConfig({
          log: (m) => logs.push(m),
          isKimiAvailable: () => true,
        }),
        true,
      );
      const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      assert.equal(
        doc.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${port1}/mcp`,
      );
      assert.equal(
        doc.mcpServers["coder-memory"].headers.Authorization,
        `Bearer ${token1}`,
      );
      assert.equal(fs.readFileSync(existingBackup, "utf8"), '{"keep":true}\n');
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("leaves corrupt existing file untouched", async () => {
    const port = await freePort();
    const mcpPath = process.env.CODER_KIMI_MCP_PATH;
    const corrupt = "{ not valid json !!!";
    fs.writeFileSync(mcpPath, corrupt, "utf8");
    const { sup, server } = await markHealthyViaAdopt(port, "t");
    try {
      const ok = ensureKimiMcpConfig({
        log: (m) => logs.push(m),
        isKimiAvailable: () => true,
      });
      assert.equal(ok, false);
      assert.equal(fs.readFileSync(mcpPath, "utf8"), corrupt);
      assert.ok(!fs.existsSync(mcpPath + ".coder-backup"));
      assert.ok(logs.some((m) => /parse failed|untouched/i.test(String(m))));
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("respects CODER_KIMI_MCP_PATH env override", () => {
    const custom = path.join(tmpDir, "nested", "custom-mcp.json");
    process.env.CODER_KIMI_MCP_PATH = custom;
    assert.equal(resolveKimiMcpPath(), custom);
  });

  it("no-ops when memory unhealthy or kimi unavailable", () => {
    assert.equal(
      ensureKimiMcpConfig({
        log: (m) => logs.push(m),
        isKimiAvailable: () => true,
      }),
      false,
    );
    assert.ok(!fs.existsSync(process.env.CODER_KIMI_MCP_PATH));
  });
});

describe("ensureCursorMcpConfig", () => {
  let tmpDir;
  let logs;
  let prevEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-cursor-mcp-"));
    logs = [];
    prevEnv = {
      CODER_CURSOR_MCP_PATH: process.env.CODER_CURSOR_MCP_PATH,
      CODER_CURSOR_MCP_DISABLE: process.env.CODER_CURSOR_MCP_DISABLE,
      CODER_CURSOR_BIN: process.env.CODER_CURSOR_BIN,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    process.env.CODER_CURSOR_MCP_PATH = path.join(tmpDir, "mcp.json");
    delete process.env.CODER_CURSOR_MCP_DISABLE;
    process.env.CODER_CURSOR_BIN = path.join(tmpDir, "no-cursor-agent");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    resetMemorySupForTests();
  });

  afterEach(() => {
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates fresh mcp.json when missing", () => {
    registerMcpServer({
      name: "coder-threads",
      port: 4321,
      token: "cursor-tok",
      userDataPath: tmpDir,
    });
    const mcpPath = process.env.CODER_CURSOR_MCP_PATH;
    assert.ok(!fs.existsSync(mcpPath));
    const ok = ensureCursorMcpConfig({
      log: (m) => logs.push(m),
      isCursorAvailable: () => true,
    });
    assert.equal(ok, true);
    assert.ok(fs.existsSync(mcpPath));
    const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    assert.deepEqual(doc.mcpServers["coder-threads"], {
      type: "http",
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: "Bearer cursor-tok" },
    });
    assert.ok(!fs.existsSync(mcpPath + ".coder-backup"));
    assert.equal(fs.statSync(mcpPath).mode & 0o777, 0o600);
  });

  it("merges into existing file preserving foreign keys and backs up once", () => {
    const mcpPath = process.env.CODER_CURSOR_MCP_PATH;
    fs.writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          version: 1,
          mcpServers: {
            foreign: { type: "stdio", command: "echo" },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    registerMcpServer({
      name: "coder-threads",
      port: 4321,
      token: "merge-tok",
      userDataPath: tmpDir,
    });
    assert.equal(
      ensureCursorMcpConfig({
        log: (m) => logs.push(m),
        isCursorAvailable: () => true,
      }),
      true,
    );
    const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.mcpServers.foreign, {
      type: "stdio",
      command: "echo",
    });
    assert.equal(
      doc.mcpServers["coder-threads"].url,
      "http://127.0.0.1:4321/mcp",
    );
    const backup = mcpPath + ".coder-backup";
    assert.ok(fs.existsSync(backup));
    const backupDoc = JSON.parse(fs.readFileSync(backup, "utf8"));
    assert.ok(!backupDoc.mcpServers["coder-threads"]);
    const backupBefore = fs.readFileSync(backup, "utf8");
    assert.equal(
      ensureCursorMcpConfig({
        log: (m) => logs.push(m),
        isCursorAvailable: () => true,
      }),
      true,
    );
    assert.equal(fs.readFileSync(backup, "utf8"), backupBefore);
  });

  it("no-ops when CODER_CURSOR_MCP_DISABLE=1", () => {
    process.env.CODER_CURSOR_MCP_DISABLE = "1";
    registerMcpServer({
      name: "coder-threads",
      port: 4321,
      token: "tok",
      userDataPath: tmpDir,
    });
    assert.equal(
      ensureCursorMcpConfig({
        log: (m) => logs.push(m),
        isCursorAvailable: () => true,
      }),
      false,
    );
    assert.ok(!fs.existsSync(process.env.CODER_CURSOR_MCP_PATH));
  });

  it("removeCursorMcpEntries drops our keys and keeps foreign ones", () => {
    const mcpPath = process.env.CODER_CURSOR_MCP_PATH;
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "coder-threads": { type: "http", url: "http://127.0.0.1:1/mcp" },
          someone_else: { type: "stdio" },
        },
      }),
      "utf8",
    );
    assert.equal(
      removeCursorMcpEntries(["coder-threads"], {
        log: (m) => logs.push(m),
      }),
      true,
    );
    const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    assert.equal(doc.mcpServers["coder-threads"], undefined);
    assert.ok(doc.mcpServers.someone_else, "foreign entry must survive");
  });

  it("resolveCursorMcpPath prefers CODER_CURSOR_MCP_PATH", () => {
    assert.equal(
      resolveCursorMcpPath(process.env),
      process.env.CODER_CURSOR_MCP_PATH,
    );
  });
});

describe("ensureGrokMcpConfig", () => {
  let tmpDir;
  let logs;
  let prevEnv;
  let mcpArgvFile;
  let fakeGrok;

  /**
   * Env for deliberately exercising ensureGrokMcpConfig (kill switch off).
   * @param {Record<string, string | undefined>} extra
   */
  function enableGrokMcpEnv(extra = {}) {
    const env = {
      ...process.env,
      CODER_GROK_BIN: fakeGrok,
      ...extra,
    };
    delete env.CODER_GROK_MCP_DISABLE;
    return env;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-grok-mcp-"));
    logs = [];
    mcpArgvFile = path.join(tmpDir, "mcp-argv.json");
    prevEnv = {
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_FAKE_GROK_MCP_ARGV_FILE: process.env.CODER_FAKE_GROK_MCP_ARGV_FILE,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_GROK_CONFIG_PATH: process.env.CODER_GROK_CONFIG_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
    };
    // Keep every home-directory side effect (kimi cleanup, grok chmod) in tmp.
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
    process.env.CODER_GROK_CONFIG_PATH = path.join(tmpDir, "grok-config.toml");
    // Default: kill switch on so accidental markHealthy cannot touch real config.
    process.env.CODER_GROK_MCP_DISABLE = "1";
    // Fake grok that records `mcp add` argv and exits 0.
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(1);
if (process.env.CODER_FAKE_GROK_MCP_ARGV_FILE) {
  fs.writeFileSync(
    process.env.CODER_FAKE_GROK_MCP_ARGV_FILE,
    JSON.stringify(args),
    "utf8",
  );
}
process.exit(0);
`;
    fakeGrok = writeFakeBin(path.join(tmpDir, "fake-grok-mcp"), body);
    process.env.CODER_GROK_BIN = fakeGrok;
    process.env.CODER_FAKE_GROK_MCP_ARGV_FILE = mcpArgvFile;
    resetMemorySupForTests();
  });

  afterEach(async () => {
    await whenGrokMcpIdle();
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function markHealthyViaAdopt(port, token, envExtra = {}) {
    fs.writeFileSync(
      path.join(tmpDir, "memory-server.json"),
      JSON.stringify({
        port,
        token,
        dbPath: path.join(tmpDir, "db"),
      }),
      "utf8",
    );
    const server = http.createServer(serveProvenHealth(token));
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const env = {
      ...process.env,
      CODER_KIMI_BIN: path.join(tmpDir, "no-kimi"),
      CODER_GROK_BIN: path.join(tmpDir, "no-grok-during-start"),
      CODER_GROK_MCP_DISABLE: "1",
      ...envExtra,
    };
    // envExtra may clear the kill switch for intentional ensure tests.
    if (Object.prototype.hasOwnProperty.call(envExtra, "CODER_GROK_MCP_DISABLE")
      && envExtra.CODER_GROK_MCP_DISABLE == null) {
      delete env.CODER_GROK_MCP_DISABLE;
    }
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
      env,
    });
    await sup.start();
    return { sup, server };
  }

  it("invokes fake grok with exact mcp add argv when healthy", async () => {
    const port = await freePort();
    const token = "grok-mcp-tok";
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      // Call explicitly with the fake bin available (kill switch off).
      if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
      const ok = ensureGrokMcpConfig({
        log: (m) => logs.push(m),
        env: enableGrokMcpEnv(),
      });
      assert.equal(ok, true, "should kick off async mcp add");
      // Fire-and-forget: poll the fake binary's argv capture file.
      await waitFor(() => fs.existsSync(mcpArgvFile), { timeoutMs: 3000 });
      const argv = JSON.parse(fs.readFileSync(mcpArgvFile, "utf8"));
      const mcpIdx = argv.indexOf("mcp");
      assert.ok(mcpIdx >= 0, `expected mcp in ${JSON.stringify(argv)}`);
      assert.deepEqual(argv.slice(mcpIdx), [
        "mcp",
        "add",
        "--transport",
        "http",
        "coder-memory",
        `http://127.0.0.1:${port}/mcp`,
        "--header",
        "Authorization: Bearer ${CODER_MCP_TOKEN_CODER_MEMORY}",
        "--scope",
        "user",
      ]);
      assert.ok(
        !JSON.stringify(argv).includes(token),
        "Grok argv must not include the bearer token",
      );
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("binds project and projectId on fallback grok mcp add URLs (#706)", async () => {
    const port = await freePort();
    const token = "grok-bind-tok";
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      registerMcpServer({
        name: "coder-threads",
        port: 45999,
        token: "orch-token",
        userDataPath: tmpDir,
        log: (m) => logs.push(m),
        env: { ...process.env, CODER_GROK_MCP_DISABLE: "1" },
      });
      if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
      const ok = ensureGrokMcpConfig({
        log: (m) => logs.push(m),
        env: enableGrokMcpEnv(),
        projectPath: "/tmp/alpha",
        projectId: "proj-1",
      });
      assert.equal(ok, true);
      await whenGrokMcpIdle();
      const argv = JSON.parse(fs.readFileSync(mcpArgvFile, "utf8"));
      // The fake overwrites one argv capture; either bound URL is the signal
      // that fallback add is no longer the plain server URL.
      const joined = JSON.stringify(argv);
      assert.ok(
        joined.includes("project=%2Ftmp%2Falpha") ||
          joined.includes("projectId=proj-1"),
        `expected bound URL in ${joined}`,
      );
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("no-ops when CODER_GROK_MCP_DISABLE=1 even if healthy and bin available", async () => {
    const port = await freePort();
    const token = "disable-tok";
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
      const ok = ensureGrokMcpConfig({
        log: (m) => logs.push(m),
        env: {
          ...process.env,
          CODER_GROK_BIN: fakeGrok,
          CODER_GROK_MCP_DISABLE: "1",
        },
      });
      assert.equal(ok, false);
      // Give async path a moment in case kill switch failed open.
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(!fs.existsSync(mcpArgvFile));
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("no-ops when memory unhealthy", () => {
    if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
    const ok = ensureGrokMcpConfig({
      log: (m) => logs.push(m),
      env: enableGrokMcpEnv(),
    });
    assert.equal(ok, false);
    assert.ok(!fs.existsSync(mcpArgvFile));
  });

  it("no-ops when grok binary is unavailable", async () => {
    const port = await freePort();
    const token = "t";
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
      const ok = ensureGrokMcpConfig({
        log: (m) => logs.push(m),
        env: enableGrokMcpEnv({
          CODER_GROK_BIN: path.join(tmpDir, "missing-grok"),
        }),
      });
      assert.equal(ok, false);
      assert.ok(!fs.existsSync(mcpArgvFile));
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("markHealthy calls ensureGrokMcpConfig when grok is available", async () => {
    const port = await freePort();
    const token = "auto-tok";
    if (fs.existsSync(mcpArgvFile)) fs.unlinkSync(mcpArgvFile);
    const { sup, server } = await markHealthyViaAdopt(port, token, {
      CODER_GROK_BIN: fakeGrok,
      // Clear kill switch for this intentional exercise.
      CODER_GROK_MCP_DISABLE: null,
    });
    try {
      assert.equal(sup.getStatus().running, true);
      await waitFor(() => fs.existsSync(mcpArgvFile), { timeoutMs: 3000 });
      const argv = JSON.parse(fs.readFileSync(mcpArgvFile, "utf8"));
      const mcpIdx = argv.indexOf("mcp");
      assert.ok(mcpIdx >= 0);
      assert.equal(argv[mcpIdx + 1], "add");
      assert.equal(argv[mcpIdx + 2], "--transport");
      assert.equal(argv[mcpIdx + 3], "http");
      assert.equal(argv[mcpIdx + 4], "coder-memory");
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("serializes two mcp add invocations (#626)", async () => {
    const port = await freePort();
    const token = "serial-tok";
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      registerMcpServer({
        name: "coder-threads",
        port: 45999,
        token: "orch-token",
        userDataPath: tmpDir,
        log: (m) => logs.push(m),
        env: { ...process.env, CODER_GROK_MCP_DISABLE: "1" },
      });
      const logFile = path.join(tmpDir, "grok-mcp-log.jsonl");
      const slow = writeFakeBin(
        path.join(tmpDir, "fake-grok-slow"),
        slowGrokMcpBody(),
      );
      const ok = ensureGrokMcpConfig({
        log: (m) => logs.push(m),
        env: enableGrokMcpEnv({
          CODER_GROK_BIN: slow,
          CODER_FAKE_GROK_MCP_LOG: logFile,
        }),
      });
      assert.equal(ok, true);
      await whenGrokMcpIdle();
      assertSerialGrokMcp(logFile, 2);
      const names = grokMcpLog(logFile)
        .filter((e) => e.ev === "start")
        .map((e) => {
          const t = e.args.indexOf("--transport");
          return t >= 0 ? e.args[t + 2] : e.args[2];
        })
        .sort();
      assert.deepEqual(names, ["coder-memory", "coder-threads"]);
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });

  it("restores config.toml from the pre-write copy when the batch leaves it unparseable (#626)", async () => {
    const port = await freePort();
    const token = "restore-tok";
    const { sup, server } = await markHealthyViaAdopt(port, token);
    try {
      const configPath = process.env.CODER_GROK_CONFIG_PATH;
      const original =
        '[mcp_servers.keep]\ntransport = "http"\nurl = "http://example.test/mcp"\n';
      fs.writeFileSync(configPath, original);
      const corrupt = writeFakeBin(
        path.join(tmpDir, "fake-grok-corrupt"),
        `#!/usr/bin/env node
"use strict";
const fs = require("fs");
fs.writeFileSync(
  process.env.CODER_GROK_CONFIG_PATH,
  "[mcp_servers.torn\\ntransport\\n",
);
process.exit(0);
`,
      );
      const ok = ensureGrokMcpConfig({
        log: (m) => logs.push(m),
        env: enableGrokMcpEnv({ CODER_GROK_BIN: corrupt }),
      });
      assert.equal(ok, true);
      await whenGrokMcpIdle();
      assert.equal(fs.readFileSync(configPath, "utf8"), original);
      assert.ok(
        logs.some((l) => /restored the pre-write copy/.test(l)),
        `expected restore log, got ${JSON.stringify(logs)}`,
      );
    } finally {
      sup.stop();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("grokTomlLooksValid (#626)", () => {
  it("accepts a typical grok mcp_servers block", () => {
    assert.equal(
      grokTomlLooksValid(`[mcp_servers.coder-memory]
transport = "http"
url = "http://127.0.0.1:9/mcp"
headers = { Authorization = "Bearer abc" }
`),
      true,
    );
  });

  it("rejects a truncated key (the live failure)", () => {
    assert.equal(
      grokTomlLooksValid(`[mcp_servers.coder-memory]
transport = "http"

[mcp_servers.coder-threads]
transpor
`),
      false,
    );
  });

  it("rejects an incomplete table header", () => {
    assert.equal(grokTomlLooksValid("[mcp_servers.coder-th"), false);
  });
});

describe("MCP registration cleanup (issue #125)", () => {
  let tmpDir;
  let logs;
  let prevEnv;
  let mcpArgvFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-mcp-revoke-"));
    logs = [];
    mcpArgvFile = path.join(tmpDir, "mcp-argv.json");
    prevEnv = {
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      CODER_GROK_BIN: process.env.CODER_GROK_BIN,
      CODER_GROK_CONFIG_PATH: process.env.CODER_GROK_CONFIG_PATH,
      CODER_GROK_MCP_DISABLE: process.env.CODER_GROK_MCP_DISABLE,
      CODER_FAKE_GROK_MCP_ARGV_FILE: process.env.CODER_FAKE_GROK_MCP_ARGV_FILE,
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "mcp.json");
    process.env.CODER_GROK_CONFIG_PATH = path.join(tmpDir, "grok-config.toml");
    process.env.CODER_GROK_MCP_DISABLE = "1";
    process.env.CODER_GROK_BIN = path.join(tmpDir, "no-grok");
    // Fake kimi so the availability probe passes without the real CLI.
    const fakeKimi = path.join(tmpDir, "fake-kimi");
    fs.writeFileSync(fakeKimi, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.CODER_KIMI_BIN = fakeKimi;
    resetMemorySupForTests();
  });

  afterEach(async () => {
    await whenGrokMcpIdle();
    resetMemorySupForTests();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fake grok that appends every `mcp ...` argv it sees. */
  function installFakeGrok() {
    const body = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const file = process.env.CODER_FAKE_GROK_MCP_ARGV_FILE;
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
prev.push(process.argv.slice(2));
fs.writeFileSync(file, JSON.stringify(prev), "utf8");
process.exit(0);
`;
    const bin = writeFakeBin(path.join(tmpDir, "fake-grok"), body);
    process.env.CODER_GROK_BIN = bin;
    process.env.CODER_FAKE_GROK_MCP_ARGV_FILE = mcpArgvFile;
    const env = { ...process.env };
    delete env.CODER_GROK_MCP_DISABLE;
    return env;
  }

  it("writes kimi mcp.json owner-only even when it already existed 0644", () => {
    const mcpPath = process.env.CODER_KIMI_MCP_PATH;
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), {
      mode: 0o644,
    });
    fs.chmodSync(mcpPath, 0o644);

    registerMcpServer({
      name: "coder-threads",
      port: 45999,
      token: "orch-token",
      userDataPath: tmpDir,
      log: (m) => logs.push(m),
    });

    const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    assert.equal(
      doc.mcpServers["coder-threads"].headers.Authorization,
      "Bearer orch-token",
    );
    assert.equal(fs.statSync(mcpPath).mode & 0o777, 0o600);
    // Our own claude config carries the same token; same rule.
    assert.equal(
      fs.statSync(path.join(tmpDir, "mcp-coder-memory.json")).mode & 0o777,
      0o600,
    );
  });

  it("unregister drops the kimi entry and leaves foreign servers alone", () => {
    const mcpPath = process.env.CODER_KIMI_MCP_PATH;
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { someone_else: { type: "stdio" } } }),
      "utf8",
    );

    registerMcpServer({
      name: "coder-threads",
      port: 45999,
      token: "orch-token",
      userDataPath: tmpDir,
      log: (m) => logs.push(m),
    });
    assert.ok(
      JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers["coder-threads"],
    );

    unregisterMcpServer("coder-threads", { log: (m) => logs.push(m) });

    const doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    assert.equal(doc.mcpServers["coder-threads"], undefined);
    assert.ok(doc.mcpServers.someone_else, "foreign entry must survive");
    assert.ok(
      !fs.readFileSync(mcpPath, "utf8").includes("orch-token"),
      "token must not survive the server",
    );
  });

  it("unregister runs `grok mcp remove <name> --scope user`", async () => {
    const env = installFakeGrok();
    registerMcpServer({
      name: "coder-threads",
      port: 45999,
      token: "orch-token",
      userDataPath: tmpDir,
      log: (m) => logs.push(m),
      env,
    });
    await waitFor(() => fs.existsSync(mcpArgvFile), { timeoutMs: 3000 });

    unregisterMcpServer("coder-threads", { log: (m) => logs.push(m), env });
    await waitFor(
      () =>
        JSON.parse(fs.readFileSync(mcpArgvFile, "utf8")).some(
          (a) => a[1] === "remove",
        ),
      { timeoutMs: 3000 },
    );
    const calls = JSON.parse(fs.readFileSync(mcpArgvFile, "utf8"));
    assert.deepEqual(calls.at(-1), [
      "mcp",
      "remove",
      "coder-threads",
      "--scope",
      "user",
    ]);
  });

  it("serializes two mcp remove invocations (#626)", async () => {
    const logFile = path.join(tmpDir, "grok-mcp-remove-log.jsonl");
    const slow = writeFakeBin(
      path.join(tmpDir, "fake-grok-slow-remove"),
      slowGrokMcpBody(),
    );
    const env = { ...process.env, CODER_GROK_BIN: slow, CODER_FAKE_GROK_MCP_LOG: logFile };
    delete env.CODER_GROK_MCP_DISABLE;
    const kicked = removeGrokMcpEntries(["coder-memory", "coder-threads"], {
      log: (m) => logs.push(m),
      env,
    });
    assert.equal(kicked, true);
    await whenGrokMcpIdle();
    assertSerialGrokMcp(logFile, 2);
    const names = grokMcpLog(logFile)
      .filter((e) => e.ev === "start")
      .map((e) => e.args[2])
      .sort();
    assert.deepEqual(names, ["coder-memory", "coder-threads"]);
  });
});

describe("resolveNodeBinary", () => {
  it("honours an existing CODER_NODE_BIN", () => {
    assert.equal(
      resolveNodeBinary({ CODER_NODE_BIN: process.execPath }),
      process.execPath,
    );
  });

  it("returns null for a missing CODER_NODE_BIN override", () => {
    assert.equal(resolveNodeBinary({ CODER_NODE_BIN: "/nope/node" }), null);
  });

  it("does not throw when the PATH lookup is `where` on win32", () => {
    // `where` is not a binary on macOS; defaultWhich returns null and we
    // fall through to nvm/homebrew or null. The point is no thrown `which`.
    const hit = resolveNodeBinary({ PATH: "" }, "win32");
    assert.ok(hit === null || typeof hit === "string");
  });
});

describe("waitForHealth (#618)", () => {
  it("is gone: spawn polls inline because the port can move", () => {
    const src = fs.readFileSync(path.join(__dirname, "../memory-sup.js"), "utf8");
    assert.doesNotMatch(src, /async function waitForHealth\b/);
    assert.doesNotMatch(src, /exports\.waitForHealth/);
  });
});
