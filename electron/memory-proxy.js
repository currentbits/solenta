"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { getMemoryStatus, CONFIG_NAME } = require("./memory-sup.js");

const NOT_RUNNING = "Memory server is not running.";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Read { port, token } from <userData>/memory-server.json, or null.
 * @param {string} userDataPath
 * @returns {{ port: number, token: string } | null}
 */
function readMemoryConfig(userDataPath) {
  const configPath = path.join(userDataPath, CONFIG_NAME);
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const port = Number(parsed.port);
    const token = typeof parsed.token === "string" ? parsed.token : "";
    if (!port || !Number.isFinite(port) || !token) return null;
    return { port, token };
  } catch {
    return null;
  }
}

/**
 * Normalize a raw server entry to MemoryEntryInfo (camelCase timestamps).
 * @param {unknown} raw
 * @returns {import('../src/shared/ipc').MemoryEntryInfo}
 */
function normalizeEntry(raw) {
  const o = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const createdAt =
    typeof o.createdAt === "string"
      ? o.createdAt
      : typeof o.created_at === "string"
        ? o.created_at
        : "";
  const updatedAt =
    typeof o.updatedAt === "string"
      ? o.updatedAt
      : typeof o.updated_at === "string"
        ? o.updated_at
        : "";
  const importance = Number(o.importance);
  return {
    id: typeof o.id === "string" ? o.id : String(o.id ?? ""),
    type: /** @type {import('../src/shared/ipc').MemoryEntryInfo['type']} */ (
      typeof o.type === "string" ? o.type : "knowledge"
    ),
    title: typeof o.title === "string" ? o.title : "",
    body: typeof o.body === "string" ? o.body : "",
    project:
      o.project === null || o.project === undefined
        ? null
        : typeof o.project === "string"
          ? o.project
          : String(o.project),
    importance: Number.isFinite(importance) ? importance : 0,
    createdAt,
    updatedAt,
  };
}

/**
 * Issue one HTTP request to the memory server. Never throws synchronously.
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {string} opts.method
 * @param {string} opts.pathWithQuery - path including optional query string
 * @param {unknown} [opts.body]
 * @param {number} opts.timeoutMs
 * @returns {Promise<unknown>}
 */
function httpRequest(opts) {
  const { port, token, method, pathWithQuery, body, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let payload = null;
    /** @type {Record<string, string | number>} */
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathWithQuery,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              if (status < 200 || status >= 300) {
                fail(new Error(text.slice(0, 200) || `HTTP ${status}`));
                return;
              }
              fail(new Error("invalid JSON from memory server"));
              return;
            }
          }
          if (status < 200 || status >= 300) {
            const msg =
              parsed &&
              typeof parsed === "object" &&
              typeof /** @type {{error?: unknown}} */ (parsed).error === "string"
                ? /** @type {{error: string}} */ (parsed).error
                : `HTTP ${status}`;
            fail(new Error(msg));
            return;
          }
          ok(parsed);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      fail(new Error("Memory server request timed out"));
    });
    req.on("error", (err) => {
      fail(err);
    });

    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Create a memory API proxy for the main process.
 * Uses getMemoryStatus() + <userData>/memory-server.json; never throws sync.
 *
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {() => { running: boolean, adopted: boolean, port: number | null }} [opts.getStatus]
 * @param {number} [opts.timeoutMs]
 */
function createMemoryProxy(opts) {
  const {
    userDataPath,
    getStatus = getMemoryStatus,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  /**
   * Resolve running server + config, or reject with the exact not-running message.
   * @returns {Promise<{ port: number, token: string }>}
   */
  async function requireServer() {
    const st = getStatus();
    if (!st || !st.running) {
      throw new Error(NOT_RUNNING);
    }
    const cfg = readMemoryConfig(userDataPath);
    if (!cfg) {
      throw new Error(NOT_RUNNING);
    }
    // Prefer live status port when set; fall back to config.
    const port = st.port != null ? Number(st.port) : cfg.port;
    if (!port || !Number.isFinite(port)) {
      throw new Error(NOT_RUNNING);
    }
    return { port, token: cfg.token };
  }

  /**
   * @param {string} method
   * @param {string} pathWithQuery
   * @param {unknown} [body]
   */
  async function request(method, pathWithQuery, body) {
    try {
      const { port, token } = await requireServer();
      return await httpRequest({
        port,
        token,
        method,
        pathWithQuery,
        body,
        timeoutMs,
      });
    } catch (err) {
      // Re-throw as Error with message preserved; never sync throw from callers.
      if (err instanceof Error) throw err;
      throw new Error(String(err));
    }
  }

  return {
    /**
     * @param {{ query: string, project?: string }} input
     * @returns {Promise<import('../src/shared/ipc').MemoryEntryInfo[]>}
     */
    async search(input) {
      const q = encodeURIComponent(String(input && input.query != null ? input.query : ""));
      let pathWithQuery = `/api/search?query=${q}`;
      if (input && input.project != null && input.project !== "") {
        pathWithQuery += `&project=${encodeURIComponent(String(input.project))}`;
      }
      const raw = await request("GET", pathWithQuery);
      const list = Array.isArray(raw) ? raw : [];
      return list.map(normalizeEntry);
    },

    /**
     * @param {{ limit?: number }} [input]
     * @returns {Promise<import('../src/shared/ipc').MemoryEntryInfo[]>}
     */
    async recent(input) {
      let pathWithQuery = "/api/recent";
      if (input && input.limit != null) {
        pathWithQuery += `?limit=${encodeURIComponent(String(input.limit))}`;
      }
      const raw = await request("GET", pathWithQuery);
      const list = Array.isArray(raw) ? raw : [];
      return list.map(normalizeEntry);
    },

    /**
     * @param {{ id: string }} input
     * @returns {Promise<import('../src/shared/ipc').MemoryEntryInfo>}
     */
    async get(input) {
      const id = encodeURIComponent(String(input && input.id != null ? input.id : ""));
      const raw = await request("GET", `/api/entry/${id}`);
      return normalizeEntry(raw);
    },

    /**
     * @param {{ type: string, title: string, body: string, project?: string }} input
     * @returns {Promise<{ id: string }>}
     */
    async store(input) {
      const payload = {
        type: input && input.type,
        title: input && input.title,
        body: input && input.body,
      };
      if (input && input.project !== undefined) {
        payload.project = input.project;
      }
      const raw = await request("POST", "/api/store", payload);
      const o =
        raw && typeof raw === "object"
          ? /** @type {Record<string, unknown>} */ (raw)
          : {};
      return {
        id: typeof o.id === "string" ? o.id : String(o.id ?? ""),
      };
    },
  };
}

module.exports = {
  createMemoryProxy,
  readMemoryConfig,
  normalizeEntry,
  NOT_RUNNING,
};
