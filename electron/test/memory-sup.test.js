const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const {
  createMemorySupervisor,
  getClaudeMcpArgs,
  resetMemorySupForTests,
} = require("../memory-sup.js");

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

const configPath = process.env.CODER_MEMORY_CONFIG;
if (!configPath || !fs.existsSync(configPath)) {
  console.error("missing CODER_MEMORY_CONFIG");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const port = Number(cfg.port);
if (!port) {
  console.error("invalid port");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, port }));
    return;
  }
  res.writeHead(404);
  res.end("nope");
});
server.listen(port, "127.0.0.1", () => {
  // ready
});
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
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
      PATH: process.env.PATH,
    };
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
      assert.equal(mcpArgs.length, 2);
      assert.equal(mcpArgs[0], "--mcp-config");
      assert.ok(fs.existsSync(mcpArgs[1]));
      const mcp = JSON.parse(fs.readFileSync(mcpArgs[1], "utf8"));
      assert.equal(
        mcp.mcpServers["coder-memory"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
      assert.equal(
        mcp.mcpServers["coder-memory"].headers.Authorization,
        `Bearer ${token}`,
      );

      // Adopted: stop must not try to kill a child we never owned.
      sup.stop();
      // Server still up after stop
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.ok, true);
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

  it("no config file: continues without memory", async () => {
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
    });
    await sup.start();
    assert.equal(sup.getStatus().running, false);
    assert.equal(getClaudeMcpArgs().length, 0);
  });
});
