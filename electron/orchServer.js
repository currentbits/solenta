"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

const { registerMcpServer, unregisterMcpServer } = require("./memory-sup.js");
const { forkWorkerThread } = require("./services.js");

const SERVER_NAME = "coder-threads";
const CONFIG_NAME = "orch-server.json";
/** Max request body size for MCP JSON payloads (1 MiB). */
const MAX_BODY_BYTES = 1024 * 1024;

const INSTRUCTIONS =
  "Solenta thread orchestrator: drive other agent threads in this Solenta workspace. " +
  "The workspace holds SEVERAL projects and this server sees all of them, but you may " +
  "only drive threads in your own. Your thread id and project id are stated at the end " +
  "of your prompt; pass them, never guess an id from a title. " +
  "threads_list shows every thread with id, title, provider, status, handoffFrom, " +
  "projectId and projectName — filter it by your own projectId first. " +
  "thread_fork and thread_send reject a thread outside the projectId you pass. " +
  "thread_fork starts a new thread (optionally on a different provider) on your " +
  "prompt; the worker does NOT inherit the source session, only a truncated digest " +
  "of its last messages, so write a self-contained prompt with every fact the worker " +
  "needs. The worker runs in its own git worktree and branch " +
  "so parallel workers never edit the same files (pass worktree:false to share the " +
  "project checkout, and merge a worker's branch when its work lands). " +
  "thread_send starts a run with your prompt on an " +
  "existing thread. thread_status reports a thread's status and the first line of " +
  "its last assistant reply. Runs are asynchronous: send work, then continue. " +
  "When a worker you forked finishes (done or failed) you are woken on a new turn " +
  "with a notice; do not sit idle waiting for the user to relay that. " +
  "thread_status still has full details if you need them before the wake-up. " +
  "A worker can also stall on a permission prompt only the user can answer: that " +
  "sends no notice and stays \"working\", so if one goes quiet check thread_status " +
  "for awaitingInput and tell the user what it is waiting on.";

function timingSafeEqualString(a, b) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return (
    bufferA.length === bufferB.length &&
    crypto.timingSafeEqual(bufferA, bufferB)
  );
}

/**
 * Bearer Authorization header, or ?token= on the URL for header-less clients.
 * @param {http.IncomingMessage} req
 * @param {string} token
 * @param {URL} url
 */
function authorized(req, token, url) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return timingSafeEqualString(header.slice(7), token);
  }
  const queryToken = url.searchParams.get("token");
  if (queryToken == null) return false;
  return timingSafeEqualString(queryToken, token);
}

function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Read the full request body as a Buffer, capped at MAX_BODY_BYTES.
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error("request body too large"));
        try {
          req.pause();
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Load the @modelcontextprotocol/sdk + zod from memory-server's dependency
 * tree (the root package does not depend on them; the packaged app ships
 * memory-server/node_modules only). Throws when unavailable.
 * @param {string} appPath - app/repo root containing memory-server/
 */
function loadSdk(appPath) {
  const req = createRequire(path.join(appPath, "memory-server", "package.json"));
  const { McpServer } = req("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = req(
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
  );
  const { z } = req("zod");
  return { McpServer, StreamableHTTPServerTransport, z };
}

/**
 * Pick a random free loopback port.
 * @returns {Promise<number>}
 */
function probeFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Load existing config strictly, or create one on first run.
 * Same pattern as memory-server.json: { port, token } at 0o600.
 * @param {string} file
 * @returns {Promise<{ port: number, token: string }>}
 */
async function loadOrCreateConfig(file) {
  let port = 0;
  if (fs.existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`config at ${file} is not valid JSON`);
    }
    port = Number(parsed && parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`config at ${file} is missing a valid port`);
    }
  }

  const config = {
    port: port || (await probeFreePort()),
    // Fresh token every launch. These tokens drive thread_fork/thread_send
    // (arbitrary agent runs in any registered project) and leak into
    // user-global CLI configs, so a rotation is what actually revokes a copy
    // we failed to clean up: it is dead the next time Solenta starts (#125).
    token: crypto.randomBytes(32).toString("hex"),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return config;
}

/**
 * Tool handlers implemented directly against main-process objects.
 * Each returns a plain value; buildMcpServer wraps them as MCP results.
 * Exported separately so tests can drive them spawn-free.
 *
 * @param {object} deps
 * @param {import('./store').Store} deps.store
 * @param {{ startRun: (input: { threadId: string, prompt: string }) => Promise<unknown> }} deps.runner
 * @param {(store: unknown, input: { threadId: string, provider?: string }) => { id: string }} deps.forkThread
 * @param {(id: string) => unknown} deps.getProvider
 */
function createToolHandlers(deps) {
  const { store, runner, forkThread, getProvider } = deps;

  /**
   * The project a thread belongs to, or null when it has been deleted.
   * @param {{ projectId?: string } | null | undefined} thread
   */
  function projectOf(thread) {
    if (!thread || !thread.projectId) return null;
    if (typeof store.getProject !== "function") return null;
    return store.getProject(thread.projectId);
  }

  /**
   * Guard against driving a thread in ANOTHER project (issue #109). The
   * server has no caller identity, so the caller must STATE the project it
   * believes it is acting in and we reject a mismatch.
   *
   * ponytail: a self-declared claim, not proof — it catches a confused
   * caller, not a malicious one. Upgrade to per-run bearer tokens mapped to
   * threadIds if forgery ever matters (costly: grok/kimi register MCP
   * globally at user scope, so a per-run token cannot reach them).
   *
   * @param {{ id: string, projectId?: string }} thread - the target thread
   * @param {unknown} claimed - projectId the caller says it is working in
   */
  function assertSameProject(thread, claimed) {
    const want = String(claimed || "");
    const got = String(thread.projectId || "");
    if (want === got) return;
    const name = (p) => (p && p.name ? `"${p.name}"` : "unknown project");
    const target = name(projectOf(thread));
    const caller = name(
      typeof store.getProject === "function" ? store.getProject(want) : null,
    );
    throw new Error(
      `Thread ${thread.id} belongs to ${target} (projectId ${got}), not to ` +
        `${caller} (projectId ${want}). A thread can only drive threads in ` +
        `its own project. Use your own projectId and a threadId from ` +
        `threads_list with that same projectId.`,
    );
  }

  async function threads_list() {
    return store.getThreads().map((t) => {
      const project = projectOf(t);
      return {
        id: t.id,
        title: t.title ?? null,
        provider: t.provider ?? null,
        status: t.status ?? null,
        handoffFrom: t.handoffFrom ?? null,
        // Without these, picking a thread is a guess — which is exactly how
        // one project's agent spawned workers on another project's repo.
        projectId: t.projectId ?? null,
        projectName: project ? (project.name ?? null) : null,
      };
    });
  }

  async function thread_fork(args) {
    const source = store.getThread(args.threadId);
    if (!source) {
      throw new Error(`Unknown thread: ${args.threadId}`);
    }
    assertSameProject(source, args.projectId);
    /** @type {{ threadId: string, provider?: string, worktree?: boolean }} */
    const input = { threadId: args.threadId };
    if (args.provider != null) {
      if (!getProvider(String(args.provider))) {
        throw new Error(`Unknown provider: ${args.provider}`);
      }
      input.provider = String(args.provider);
    }
    if (args.worktree === false) input.worktree = false;
    // orchWorker + lazy worktree live in services.forkWorkerThread, shared
    // with the runner's pendingFork dispatch.
    const fork = forkWorkerThread(store, input, forkThread);
    await runner.startRun({ threadId: fork.id, prompt: args.prompt });
    return { threadId: fork.id };
  }

  async function thread_send(args) {
    const thread = store.getThread(args.threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${args.threadId}`);
    }
    assertSameProject(thread, args.projectId);
    // Re-dispatched worker: unarchive so the new run is visible again.
    if (thread.orchWorker && thread.archived) {
      store.updateThread(args.threadId, { archived: false });
      store.save();
    }
    await runner.startRun({ threadId: args.threadId, prompt: args.prompt });
    return { threadId: args.threadId };
  }

  async function thread_status(args) {
    const thread = store.getThread(args.threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${args.threadId}`);
    }
    let lastAssistantText = null;
    const msgs = store.getMessages(args.threadId) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant" && m.text != null && String(m.text)) {
        lastAssistantText = String(m.text).split(/\r?\n/)[0] || null;
        break;
      }
    }
    // Prefer the stored reason (issue #140). Fall back to a "Run error: ..."
    // event for threads that failed before lastError was persisted.
    let lastError = thread.lastError ? String(thread.lastError) : null;
    if (!lastError && thread.status === "failed") {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === "event" && /^Run error/.test(String(m.text || ""))) {
          lastError = String(m.text);
          break;
        }
      }
    }
    // A worker blocked on a permission prompt stays "working" forever and
    // never fires a wake-up notice, so the orchestrator must be able to see
    // it (issue #31). Same guard as the sidebar badge: a stale flag left by
    // a run that died mid-prompt must not read as blocked.
    const awaitingInput =
      thread.status === "working" && thread.awaitingInput === true;
    let awaitingPermission = null;
    if (awaitingInput && typeof runner.getPendingPermission === "function") {
      const pending = runner.getPendingPermission(args.threadId);
      if (pending) awaitingPermission = pending.summary || pending.toolName;
    }
    return {
      status: thread.status ?? null,
      title: thread.title ?? null,
      provider: thread.provider ?? null,
      lastAssistantText,
      lastError,
      awaitingInput,
      awaitingPermission,
    };
  }

  return { threads_list, thread_fork, thread_send, thread_status };
}

/**
 * Build the MCP server exposing the thread tools.
 * @param {{ McpServer: unknown, z: unknown }} sdk
 * @param {ReturnType<typeof createToolHandlers>} handlers
 */
function buildMcpServer(sdk, handlers) {
  const { McpServer, z } = sdk;
  const server = new McpServer(
    { name: SERVER_NAME, version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "threads_list",
    {
      description:
        "List every thread: id, title, provider, status, handoffFrom, " +
        "projectId, projectName. Threads from EVERY project are listed — " +
        "match projectId against your own before touching one.",
      inputSchema: {},
    },
    async () => json(await handlers.threads_list()),
  );

  server.registerTool(
    "thread_fork",
    {
      description:
        "Fork a thread into a new one (optionally on another provider) and start it on prompt. " +
        "threadId is normally YOUR OWN thread id, and projectId YOUR OWN project id — both are " +
        "stated at the end of your prompt. The fork lands in the source thread's project, so " +
        "forking a thread from another project spawns workers on the WRONG repo: projectId must " +
        "match the source thread's project or the call is rejected. " +
        "The fork carries only a truncated digest of the source thread's last messages, not the " +
        "whole conversation — the prompt must be self-contained. " +
        "The worker gets its own git worktree so parallel workers never edit the same files; " +
        "pass worktree:false to run it in the project checkout instead. Returns the new threadId.",
      inputSchema: {
        threadId: z.string().min(1),
        projectId: z.string().min(1),
        provider: z.string().min(1).optional(),
        prompt: z.string().min(1),
        worktree: z.boolean().optional(),
      },
    },
    async (args) => json(await handlers.thread_fork(args)),
  );

  server.registerTool(
    "thread_send",
    {
      description:
        "Start a run with prompt on an existing thread. projectId is YOUR OWN project id " +
        "(stated at the end of your prompt); the thread must belong to it. Rejects unknown " +
        "threads and threads in another project.",
      inputSchema: {
        threadId: z.string().min(1),
        projectId: z.string().min(1),
        prompt: z.string().min(1),
      },
    },
    async (args) => json(await handlers.thread_send(args)),
  );

  server.registerTool(
    "thread_status",
    {
      description:
        "Status of one thread: status, title, provider, lastAssistantText (first line of the last assistant message, null when none), lastError (run error detail when status is failed, null otherwise), awaitingInput (true when the run is stalled on a permission prompt only the user can answer) and awaitingPermission (what it is asking for).",
      inputSchema: {
        threadId: z.string().min(1),
      },
    },
    async (args) => json(await handlers.thread_status(args)),
  );

  return server;
}

/**
 * Create the in-main orchestrator MCP server ("coder-threads").
 *
 * Loopback HTTP on 127.0.0.1 with a bearer token persisted at
 * <userData>/orch-server.json, same pattern as memory-server.json.
 * Fails soft: invalid config, missing SDK, or an unbindable port logs once
 * and the app continues without thread tools.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {{ startRun: (input: { threadId: string, prompt: string }) => Promise<unknown> }} opts.runner
 * @param {string} opts.userDataPath
 * @param {string} opts.appPath - app/repo root containing memory-server/
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(store: unknown, input: { threadId: string, provider?: string }) => { id: string }} [opts.forkThread] - inject for tests
 * @param {(id: string) => unknown} [opts.getProvider] - inject for tests
 */
function createOrchServer(opts) {
  const {
    store,
    runner,
    userDataPath,
    appPath,
    log = (msg) => console.warn(msg),
    env = process.env,
  } = opts;
  // Lazy requires: only touched when a tool actually runs.
  const forkThread =
    opts.forkThread ||
    ((s, input) => require("./services.js").forkThread(s, input));
  const getProvider =
    opts.getProvider || ((id) => require("./providers.js").getProvider(id));

  const configPath = path.join(userDataPath, CONFIG_NAME);

  /** @type {http.Server | null} */
  let server = null;
  /** @type {{ running: boolean, port: number | null }} */
  let status = { running: false, port: null };

  async function start() {
    /** @type {{ port: number, token: string }} */
    let config;
    try {
      config = await loadOrCreateConfig(configPath);
    } catch (err) {
      log(
        "orch-server: invalid config; continuing without thread tools: " +
          (err && err.message ? err.message : String(err)),
      );
      return;
    }

    let sdk;
    try {
      sdk = loadSdk(appPath);
    } catch (err) {
      log(
        "orch-server: MCP SDK unavailable; continuing without thread tools: " +
          (err && err.message ? err.message : String(err)),
      );
      return;
    }

    const handlers = createToolHandlers({
      store,
      runner,
      forkThread,
      getProvider,
    });

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // Health is open (no auth).
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, server: SERVER_NAME }));
        return;
      }

      if (url.pathname === "/mcp") {
        if (!authorized(req, config.token, url)) {
          res.writeHead(401).end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }

        let body;
        try {
          const raw = await readBody(req);
          body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "valid JSON required" }));
          return;
        }

        const mcp = buildMcpServer(sdk, handlers);
        const transport = new sdk.StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
              }),
            );
          }
        } finally {
          try {
            await transport.close();
          } catch {
            // ignore
          }
          try {
            await mcp.close();
          } catch {
            // ignore
          }
        }
        return;
      }

      res.writeHead(404).end();
    });

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, "127.0.0.1", resolve);
      });
    } catch (err) {
      log(
        `orch-server: cannot bind 127.0.0.1:${config.port}; continuing without thread tools: ` +
          (err && err.message ? err.message : String(err)),
      );
      try {
        server.close();
      } catch {
        // ignore
      }
      server = null;
      return;
    }

    const address = server.address();
    status = { running: true, port: address.port };
    // Fold coder-threads into every provider's MCP injection.
    registerMcpServer({
      name: SERVER_NAME,
      port: address.port,
      token: config.token,
      userDataPath,
      log,
      env,
    });
    log(`orch-server: listening on 127.0.0.1:${address.port}`);
  }

  function stop() {
    try {
      // Also drops the token kimi/grok persisted in the user's home.
      unregisterMcpServer(SERVER_NAME, { log, env });
    } catch {
      // ignore
    }
    if (server) {
      try {
        server.close();
      } catch {
        // ignore
      }
      server = null;
    }
    status = { running: false, port: null };
  }

  function getStatus() {
    return { running: status.running, port: status.port };
  }

  return { start, stop, getStatus };
}

module.exports = {
  createOrchServer,
  createToolHandlers,
  loadOrCreateConfig,
  SERVER_NAME,
  CONFIG_NAME,
  INSTRUCTIONS,
};
