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
  /** @type {import('../src/shared/ipc').MemoryEntryInfo} */
  const entry = {
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
  if (Array.isArray(o.citations)) {
    /** @type {import('../src/shared/ipc').MemoryCitation[]} */
    const citations = [];
    for (const raw of o.citations) {
      if (!raw || typeof raw !== "object") continue;
      const kind = String(/** @type {{kind?: unknown}} */ (raw).kind || "");
      if (kind === "file") {
        const filePath = String(/** @type {{path?: unknown}} */ (raw).path || "").trim();
        if (!filePath) continue;
        /** @type {import('../src/shared/ipc').MemoryCitation} */
        const cite = { kind: "file", path: filePath };
        const line = Number(/** @type {{line?: unknown}} */ (raw).line);
        if (Number.isInteger(line) && line >= 1) cite.line = line;
        const excerpt = String(/** @type {{excerpt?: unknown}} */ (raw).excerpt || "").trim();
        if (excerpt) cite.excerpt = excerpt;
        citations.push(cite);
      } else if (kind === "thread") {
        const id = String(/** @type {{id?: unknown}} */ (raw).id || "").trim();
        if (id) citations.push({ kind: "thread", id });
      } else if (kind === "commit") {
        const sha = String(/** @type {{sha?: unknown}} */ (raw).sha || "").trim();
        if (sha) citations.push({ kind: "commit", sha });
      }
    }
    entry.citations = citations;
  }
  return entry;
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, title: string }}
 */
function normalizePairSide(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof o.id === "string" ? o.id : String(o.id ?? ""),
    title: typeof o.title === "string" ? o.title : "",
  };
}

/**
 * @param {unknown} raw
 * @returns {import('../src/shared/ipc').MemoryMaintenanceReport}
 */
function normalizeMaintenance(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const queue = o.queue && typeof o.queue === "object" ? o.queue : {};
  const items = Array.isArray(queue.items) ? queue.items : [];
  return {
    queue: {
      open: Number(queue.open) || 0,
      oldestAgeDays: Number(queue.oldestAgeDays) || 0,
      items: items.map((item) => {
        const r = item && typeof item === "object" ? item : {};
        return {
          id: Number(r.id) || 0,
          kind: typeof r.kind === "string" ? r.kind : "",
          detail: typeof r.detail === "string" ? r.detail : null,
          createdAt:
            typeof r.createdAt === "string"
              ? r.createdAt
              : typeof r.created_at === "string"
                ? r.created_at
                : "",
          a: normalizePairSide(r.a),
          b: normalizePairSide(r.b),
        };
      }),
    },
    nearDupes: Array.isArray(o.nearDupes) ? o.nearDupes : [],
    agingRuns: Array.isArray(o.agingRuns) ? o.agingRuns : [],
    fatConventions: Array.isArray(o.fatConventions) ? o.fatConventions : [],
    trust:
      o.trust && typeof o.trust === "object"
        ? o.trust
        : { agents: [], suspect: [] },
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
     * @param {{ limit?: number, project?: string }} [input]
     * @returns {Promise<import('../src/shared/ipc').MemoryEntryInfo[]>}
     */
    async recent(input) {
      let pathWithQuery = "/api/recent";
      if (input && input.limit != null) {
        pathWithQuery += `?limit=${encodeURIComponent(String(input.limit))}`;
      }
      // Must forward project: the Memory tab's default view is recent(), and an
      // unscoped list shows other projects' rows next to a Delete button.
      if (input && input.project != null && input.project !== "") {
        pathWithQuery += `${pathWithQuery.includes("?") ? "&" : "?"}project=${encodeURIComponent(String(input.project))}`;
      }
      if (input && input.type != null && input.type !== "") {
        pathWithQuery += `${pathWithQuery.includes("?") ? "&" : "?"}type=${encodeURIComponent(String(input.type))}`;
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
     * @param {{ type: string, title: string, body: string, project?: string, citations?: unknown }} input
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
      if (input && input.citations !== undefined) {
        payload.citations = input.citations;
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

    /**
     * Correct an entry by superseding it. The old row is retained and marked;
     * the returned id is the successor.
     * @param {{ id: string, title: string, body: string }} input
     * @returns {Promise<{ id: string }>}
     */
    async update(input) {
      const id = encodeURIComponent(String(input && input.id != null ? input.id : ""));
      const raw = await request("POST", `/api/entry/${id}/supersede`, {
        title: input && input.title,
        body: input && input.body,
      });
      const o = raw && typeof raw === "object" ? raw : {};
      return { id: typeof o.id === "string" ? o.id : String(o.id ?? "") };
    },

    /**
     * Permanently remove an entry and its dependents.
     * @param {{ id: string }} input
     * @returns {Promise<void>}
     */
    async remove(input) {
      const id = encodeURIComponent(String(input && input.id != null ? input.id : ""));
      await request("DELETE", `/api/entry/${id}`);
    },

    /**
     * One-call startup context (conventions, strategies, knowledge, tasks).
     * @param {{ project?: string }} [input]
     * @returns {Promise<object>}
     */
    async bootstrap(input) {
      let pathWithQuery = "/api/bootstrap";
      if (input && input.project != null && input.project !== "") {
        pathWithQuery += `?project=${encodeURIComponent(String(input.project))}`;
      }
      const raw = await request("GET", pathWithQuery);
      return raw && typeof raw === "object" ? raw : {};
    },

    /**
     * Read-only consolidation report (open review queue, near-dupes, trust).
     * @param {{ project?: string }} [input]
     * @returns {Promise<import('../src/shared/ipc').MemoryMaintenanceReport>}
     */
    async maintenance(input) {
      let pathWithQuery = "/api/maintenance";
      if (input && input.project != null && input.project !== "") {
        pathWithQuery += `?project=${encodeURIComponent(String(input.project))}`;
      }
      const raw = await request("GET", pathWithQuery);
      return normalizeMaintenance(raw);
    },

    /**
     * Resolve one open review_queue item.
     * @param {{ id: number|string, resolution: "update"|"invalidate"|"noop" }} input
     * @returns {Promise<{ ok: boolean, id: number, resolution: string }>}
     */
    async resolve(input) {
      const id = encodeURIComponent(String(input && input.id != null ? input.id : ""));
      const raw = await request("POST", `/api/review/${id}/resolve`, {
        resolution: input && input.resolution,
      });
      const o = raw && typeof raw === "object" ? raw : {};
      return {
        ok: o.ok === true,
        id: Number(o.id) || 0,
        resolution: typeof o.resolution === "string" ? o.resolution : "",
      };
    },

    /**
     * Append one transcript message to shared session history.
     * Server truncates content; non-2xx carries {error}.
     *
     * @param {{
     *   sessionId: string,
     *   project?: string | null,
     *   threadTitle?: string | null,
     *   agent?: string | null,
     *   role: "user" | "assistant" | "tool" | "system",
     *   content: string,
     * }} input
     * @returns {Promise<unknown>}
     */
    async session(input) {
      const payload = {
        sessionId: input && input.sessionId,
        role: input && input.role,
        content: input && input.content,
      };
      if (input && input.project !== undefined) {
        payload.project = input.project;
      }
      if (input && input.threadTitle !== undefined) {
        payload.threadTitle = input.threadTitle;
      }
      if (input && input.agent !== undefined) {
        payload.agent = input.agent;
      }
      return request("POST", "/api/session", payload);
    },
  };
}

module.exports = {
  createMemoryProxy,
  readMemoryConfig,
  normalizeEntry,
  NOT_RUNNING,
};
