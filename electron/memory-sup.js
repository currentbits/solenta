"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");

const CONFIG_NAME = "memory-server.json";
const MCP_CONFIG_NAME = "mcp-coder-memory.json";
const HEALTH_TIMEOUT_MS = 1000;
const SPAWN_WAIT_MS = 5000;
const HEALTH_POLL_MS = 100;

/** @type {{ running: boolean, adopted: boolean, port: number | null }} */
let globalStatus = { running: false, adopted: false, port: null };
/** @type {string | null} */
let globalMcpConfigPath = null;
/** @type {import('node:child_process').ChildProcess | null} */
let ownedChild = null;

/**
 * Reset module state (tests only).
 */
function resetMemorySupForTests() {
  if (ownedChild && !ownedChild.killed) {
    try {
      ownedChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  ownedChild = null;
  globalStatus = { running: false, adopted: false, port: null };
  globalMcpConfigPath = null;
}

/**
 * Claude argv extras when memory is healthy: ['--mcp-config', path] or [].
 * @returns {string[]}
 */
function getClaudeMcpArgs() {
  if (!globalStatus.running || !globalMcpConfigPath) return [];
  return ["--mcp-config", globalMcpConfigPath];
}

/**
 * @returns {{ running: boolean, adopted: boolean, port: number | null }}
 */
function getMemoryStatus() {
  return {
    running: globalStatus.running,
    adopted: globalStatus.adopted,
    port: globalStatus.port,
  };
}

/**
 * Probe GET /health with a timeout.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function probeHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const obj = JSON.parse(body);
            resolve(Boolean(obj && obj.ok === true));
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait until /health is ok or timeout.
 * @param {number} port
 * @param {number} maxMs
 */
async function waitForHealth(port, maxMs = SPAWN_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await probeHealth(port, Math.min(HEALTH_TIMEOUT_MS, 400))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

/**
 * Resolve a node binary: CODER_NODE_BIN, which node, nvm newest, homebrew.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function resolveNodeBinary(env = process.env) {
  if (env.CODER_NODE_BIN) {
    const p = String(env.CODER_NODE_BIN).trim();
    if (p && fs.existsSync(p)) return p;
    // Explicit override that does not exist: fail (do not fall through).
    if (p) return null;
  }

  try {
    const out = execFileSync("which", ["node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // ignore
  }

  // nvm: newest version under ~/.nvm/versions/node/*/bin/node
  try {
    const home = env.HOME || osHomedir();
    const nvmRoot = path.join(home, ".nvm", "versions", "node");
    if (fs.existsSync(nvmRoot)) {
      const versions = fs
        .readdirSync(nvmRoot)
        .filter((d) => {
          try {
            return fs.statSync(path.join(nvmRoot, d)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort()
        .reverse();
      for (const v of versions) {
        const candidate = path.join(nvmRoot, v, "bin", "node");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // ignore
  }

  const homebrew = "/opt/homebrew/bin/node";
  if (fs.existsSync(homebrew)) return homebrew;

  return null;
}

function osHomedir() {
  try {
    return require("node:os").homedir();
  } catch {
    return process.env.HOME || "";
  }
}

/**
 * Resolve the memory server entry script path.
 * @param {string} appPath
 * @param {NodeJS.ProcessEnv} env
 */
function resolveEntryPath(appPath, env = process.env) {
  if (env.CODER_MEMORY_ENTRY) {
    return String(env.CODER_MEMORY_ENTRY);
  }
  return path.join(appPath, "memory-server", "src", "index.js");
}

/**
 * Write mcp-coder-memory.json once for this healthy session.
 * @param {string} userDataPath
 * @param {number} port
 * @param {string} token
 */
function writeMcpConfig(userDataPath, port, token) {
  const mcpPath = path.join(userDataPath, MCP_CONFIG_NAME);
  const body = {
    mcpServers: {
      "coder-memory": {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(body, null, 2), "utf8");
  globalMcpConfigPath = mcpPath;
  return mcpPath;
}

/**
 * Mark memory healthy and publish MCP args.
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {string} opts.userDataPath
 * @param {boolean} opts.adopted
 */
function markHealthy(opts) {
  globalStatus = {
    running: true,
    adopted: Boolean(opts.adopted),
    port: opts.port,
  };
  writeMcpConfig(opts.userDataPath, opts.port, opts.token);
}

/**
 * Create a memory-server supervisor.
 *
 * Contract (sibling builds memory-server/):
 * - config at <userData>/memory-server.json { port, token, dbPath }
 * - GET http://127.0.0.1:<port>/health -> { ok: true, ... }
 * - entry: <appPath>/memory-server/src/index.js (or CODER_MEMORY_ENTRY)
 * - env CODER_MEMORY_CONFIG points at the config path
 *
 * Never throws on failure: logs a warning and continues without memory.
 *
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {string} opts.appPath - app/repo root containing memory-server/
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function createMemorySupervisor(opts) {
  const {
    userDataPath,
    appPath,
    log = (msg) => console.warn(msg),
    env = process.env,
  } = opts;

  const configPath = path.join(userDataPath, CONFIG_NAME);

  async function start() {
    // Clear prior session state for this supervisor instance.
    globalStatus = { running: false, adopted: false, port: null };
    globalMcpConfigPath = null;
    ownedChild = null;

    if (!fs.existsSync(configPath)) {
      log("memory-server: no config at " + configPath + "; continuing without memory");
      return;
    }

    /** @type {{ port?: number, token?: string, dbPath?: string }} */
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      log(
        "memory-server: invalid config JSON; continuing without memory: " +
          (err && err.message ? err.message : String(err)),
      );
      return;
    }

    const port = Number(cfg.port);
    const token = typeof cfg.token === "string" ? cfg.token : "";
    if (!port || !Number.isFinite(port)) {
      log("memory-server: invalid port in config; continuing without memory");
      return;
    }

    // (b) Probe health; adopt if already up.
    if (await probeHealth(port, HEALTH_TIMEOUT_MS)) {
      markHealthy({ port, token, userDataPath, adopted: true });
      log(`memory-server: adopted existing server on port ${port}`);
      return;
    }

    // (c) Spawn
    const entry = resolveEntryPath(appPath, env);
    if (!fs.existsSync(entry)) {
      log(
        "memory-server: entry missing (" +
          entry +
          "); continuing without memory",
      );
      return;
    }

    const nodeBin = resolveNodeBinary(env);
    if (!nodeBin) {
      log(
        "memory-server: node binary unavailable; continuing without memory (warn)",
      );
      return;
    }

    try {
      const child = spawn(nodeBin, [entry], {
        env: {
          ...env,
          CODER_MEMORY_CONFIG: configPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
        detached: false,
      });
      ownedChild = child;
      child.stderr?.setEncoding("utf8");
      let stderrBuf = "";
      child.stderr?.on("data", (c) => {
        stderrBuf += c;
        if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-2000);
      });
      child.on("error", (err) => {
        log(
          "memory-server: spawn error; continuing without memory: " +
            (err && err.message ? err.message : String(err)),
        );
      });
      child.on("exit", (code) => {
        if (ownedChild === child) {
          ownedChild = null;
          if (globalStatus.running && !globalStatus.adopted) {
            globalStatus = { running: false, adopted: false, port: null };
            globalMcpConfigPath = null;
          }
        }
        if (code && code !== 0) {
          log(
            "memory-server: child exited " +
              code +
              (stderrBuf ? ": " + stderrBuf.trim().slice(-400) : ""),
          );
        }
      });
    } catch (err) {
      log(
        "memory-server: spawn failed; continuing without memory: " +
          (err && err.message ? err.message : String(err)),
      );
      ownedChild = null;
      return;
    }

    const up = await waitForHealth(port, SPAWN_WAIT_MS);
    if (!up) {
      log(
        "memory-server: health never came up within " +
          SPAWN_WAIT_MS +
          "ms; continuing without memory",
      );
      // Kill the hung spawn attempt if still around
      if (ownedChild) {
        try {
          ownedChild.kill("SIGTERM");
        } catch {
          // ignore
        }
        ownedChild = null;
      }
      return;
    }

    markHealthy({ port, token, userDataPath, adopted: false });
    log(`memory-server: spawned and healthy on port ${port}`);
  }

  /**
   * Terminate only a child we spawned (not an adopted server).
   */
  function stop() {
    if (ownedChild && !globalStatus.adopted) {
      const child = ownedChild;
      ownedChild = null;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1500).unref?.();
    }
    // After stop of our child, clear status; leave adopted servers alone.
    if (!globalStatus.adopted) {
      globalStatus = { running: false, adopted: false, port: null };
      globalMcpConfigPath = null;
    }
  }

  return {
    start,
    stop,
    getStatus: getMemoryStatus,
  };
}

module.exports = {
  createMemorySupervisor,
  getClaudeMcpArgs,
  getMemoryStatus,
  resetMemorySupForTests,
  resolveNodeBinary,
  probeHealth,
  CONFIG_NAME,
  MCP_CONFIG_NAME,
};
