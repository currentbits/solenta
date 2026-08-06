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
  getCodexMcpArgs,
  ensureKimiMcpConfig,
  resolveKimiMcpPath,
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
      CODER_KIMI_MCP_PATH: process.env.CODER_KIMI_MCP_PATH,
      CODER_KIMI_BIN: process.env.CODER_KIMI_BIN,
      PATH: process.env.PATH,
    };
    // Keep ensureKimi writes inside the test dir if kimi is present.
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "kimi-mcp.json");
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

      const codexArgs = getCodexMcpArgs();
      assert.equal(codexArgs.length, 2);
      assert.equal(codexArgs[0], "-c");
      assert.equal(
        codexArgs[1],
        `mcp_servers.coder-memory.url="http://127.0.0.1:${port}/mcp?token=${token}"`,
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
        appPath: tmpDir,
        log: (m) => logs.push(m),
      });
      await sup.start();
      const args = getCodexMcpArgs();
      assert.deepEqual(args, [
        "-c",
        `mcp_servers.coder-memory.url="http://127.0.0.1:${port}/mcp?token=${token}"`,
      ]);
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
    };
    process.env.CODER_KIMI_MCP_PATH = path.join(tmpDir, "mcp.json");
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
    // Disable auto-write by making kimi unavailable during start; tests call ensure explicitly.
    const sup = createMemorySupervisor({
      userDataPath: tmpDir,
      appPath: tmpDir,
      log: (m) => logs.push(m),
      env: { ...process.env, CODER_KIMI_BIN: path.join(tmpDir, "no-kimi") },
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
