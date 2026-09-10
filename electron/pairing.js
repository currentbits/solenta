"use strict";

/**
 * External MCP pairing tokens (#157).
 *
 * Scoped, expiring, revocable credentials so a client outside Solenta
 * (Claude Desktop, Claude Code, …) can hit the loopback coder-threads
 * server and launch/track tasks. The raw token is shown once at mint;
 * disk stores only the sha256. Pairings live in <userData>/pairings.json
 * at mode 0600 — same treatment as orch-server.json (#125).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "pairings.json";
const MAX_PAIRINGS = 20;
const NAME_MAX = 80;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX_LEN = 8;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LAUNCHES_PER_HOUR = 30;
const DEFAULT_READS_PER_MINUTE = 120;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const CAPABILITIES = Object.freeze(["read", "launch", "steer", "read_all"]);
const DEFAULT_CAPABILITIES = Object.freeze(["read", "launch"]);

const EXTERNAL_SERVER_NAME = "solenta";
const EXTERNAL_INSTRUCTIONS =
  "Solenta desktop pairing. You are an external MCP client connected to a " +
  "running Solenta app on this machine. Launch and track coding tasks in the " +
  "projects this connection is allowed to see. " +
  "Call projects_list first, then task_launch with a projectId from that list " +
  "and a self-contained prompt. New work starts in a managed git worktree and " +
  "usually waits for the user to approve it in the Solenta app; poll " +
  "task_status until status is done, failed, or awaiting_approval. " +
  "Do not guess project ids. Do not put this token on a command line. " +
  "Solenta must stay running for this connection to work.";

function timingSafeEqualString(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  return (
    bufferA.length === bufferB.length &&
    crypto.timingSafeEqual(bufferA, bufferB)
  );
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function pairingPath(userDataPath) {
  return path.join(String(userDataPath || ""), FILE_NAME);
}

function emptyStore() {
  return { pairings: [] };
}

function loadStore(userDataPath) {
  const file = pairingPath(userDataPath);
  if (!file || file === FILE_NAME || !fs.existsSync(file)) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`pairings file at ${file} is not valid JSON`);
  }
  const rows = Array.isArray(parsed && parsed.pairings) ? parsed.pairings : [];
  return { pairings: rows.filter((p) => p && typeof p === "object") };
}

function saveStore(userDataPath, store) {
  const file = pairingPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(
    { pairings: Array.isArray(store.pairings) ? store.pairings : [] },
    null,
    2,
  );
  fs.writeFileSync(file, payload, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name || "Pairing"),
    tokenPrefix: String(row.tokenPrefix || ""),
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.filter((c) => CAPABILITIES.includes(c))
      : [],
    projectIds: Array.isArray(row.projectIds) ? row.projectIds.map(String) : null,
    expiresAt: Number.isFinite(row.expiresAt) ? row.expiresAt : null,
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
    lastUsedAt: Number.isFinite(row.lastUsedAt) ? row.lastUsedAt : null,
    revokedAt: Number.isFinite(row.revokedAt) ? row.revokedAt : null,
    requireApproval: row.requireApproval !== false,
    managedWorktree: row.managedWorktree !== false,
    launchesPerHour: Number.isFinite(row.launchesPerHour)
      ? row.launchesPerHour
      : DEFAULT_LAUNCHES_PER_HOUR,
    readsPerMinute: Number.isFinite(row.readsPerMinute)
      ? row.readsPerMinute
      : DEFAULT_READS_PER_MINUTE,
  };
}

function sanitizeCapabilities(input) {
  const raw = Array.isArray(input) ? input : DEFAULT_CAPABILITIES;
  const set = new Set();
  for (const item of raw) {
    const cap = String(item || "").trim();
    if (CAPABILITIES.includes(cap)) set.add(cap);
  }
  set.add("read");
  if (set.has("read_all")) set.add("read");
  return CAPABILITIES.filter((c) => set.has(c));
}

function sanitizeProjectIds(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) {
    throw new Error("projectIds must be an array of project ids, or omitted for all projects");
  }
  const ids = [];
  const seen = new Set();
  for (const item of input) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > 50) {
      throw new Error("A pairing can name at most 50 projects");
    }
  }
  if (ids.length === 0) {
    throw new Error("Pick at least one project, or allow all projects");
  }
  return ids;
}

function sanitizeTtlMs(input) {
  if (input == null) return DEFAULT_TTL_MS;
  if (input === false || input === 0) return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("ttlMs must be a non-negative number, or null for no expiry");
  }
  return n === 0 ? null : n;
}

function clampRate(value, fallback, max) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("Rate limits must be positive integers");
  }
  return Math.min(Math.floor(n), max);
}

function pruneHits(hits, windowMs, now) {
  if (!Array.isArray(hits)) return [];
  return hits.filter((t) => Number.isFinite(t) && now - t < windowMs);
}

function tryConsume(row, kind, now) {
  if (kind === "launch") {
    const limit = Number.isFinite(row.launchesPerHour)
      ? row.launchesPerHour
      : DEFAULT_LAUNCHES_PER_HOUR;
    const hits = pruneHits(row.launchHits, HOUR_MS, now);
    if (hits.length >= limit) return false;
    row.launchHits = hits.concat(now);
    return true;
  }
  const limit = Number.isFinite(row.readsPerMinute)
    ? row.readsPerMinute
    : DEFAULT_READS_PER_MINUTE;
  const hits = pruneHits(row.readHits, MINUTE_MS, now);
  if (hits.length >= limit) return false;
  row.readHits = hits.concat(now);
  return true;
}

function readOrchPort(userDataPath) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(String(userDataPath || ""), "orch-server.json"), "utf8"),
    );
    const port = Number(cfg && cfg.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch {
    // ignore
  }
  return null;
}

function mcpUrl(port) {
  if (!Number.isInteger(port) || port < 1) return null;
  return `http://127.0.0.1:${port}/mcp`;
}

function buildConfigs({ token, port, pairing }) {
  const url = mcpUrl(port);
  const name = pairing && pairing.name ? String(pairing.name) : "Solenta";
  const caps = (pairing && pairing.capabilities) || [];
  const projects =
    pairing && Array.isArray(pairing.projectIds)
      ? pairing.projectIds.join(", ")
      : "all projects in Solenta";
  const claudeDesktopJson = url
    ? JSON.stringify(
        {
          mcpServers: {
            solenta: {
              type: "http",
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      )
    : null;
  const pairingPrompt = url
    ? [
        `Connect to my local Solenta desktop app over MCP so you can launch and track coding tasks.`,
        ``,
        `Add an HTTP MCP server named "solenta":`,
        `- URL: ${url}`,
        `- Header: Authorization: Bearer ${token}`,
        ``,
        `Solenta must be running. This pairing (${name}) can: ${caps.join(", ") || "read"}.`,
        `Projects: ${projects}.`,
        pairing && pairing.managedWorktree !== false
          ? `New work starts in a managed git worktree.`
          : `New work may run in the project checkout.`,
        pairing && pairing.requireApproval !== false
          ? `Launches wait for me to approve them in the Solenta app; poll task_status.`
          : `Launches start without an in-app approval prompt.`,
        `Do not put this token on a command line or in a world-readable file.`,
      ].join("\n")
    : null;
  return { url, claudeDesktopJson, pairingPrompt };
}

function listPairings(userDataPath, opts = {}) {
  const store = loadStore(userDataPath);
  const includeRevoked = opts.includeRevoked === true;
  const now = opts.now || Date.now();
  const pairings = store.pairings
    .filter((p) => includeRevoked || !p.revokedAt)
    .map((p) => {
      const pub = toPublic(p);
      pub.expired =
        pub.expiresAt != null && Number.isFinite(pub.expiresAt) && pub.expiresAt <= now;
      return pub;
    });
  const status = typeof opts.getOrchStatus === "function" ? opts.getOrchStatus() : null;
  const port =
    status && Number.isInteger(status.port) && status.port > 0
      ? status.port
      : readOrchPort(userDataPath);
  return {
    pairings,
    server: {
      running: Boolean(status && status.running),
      port,
      url: mcpUrl(port),
    },
  };
}

function createPairing(userDataPath, input, opts = {}) {
  const now = opts.now || Date.now();
  const store = loadStore(userDataPath);
  const active = store.pairings.filter((p) => !p.revokedAt);
  if (active.length >= MAX_PAIRINGS) {
    throw new Error(`At most ${MAX_PAIRINGS} active pairings. Revoke one first.`);
  }
  const name = String((input && input.name) || "").trim();
  if (!name) throw new Error("Name is required");
  if (name.length > NAME_MAX) throw new Error(`Name must be ${NAME_MAX} characters or fewer`);
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const ttlMs = sanitizeTtlMs(input && input.ttlMs);
  const row = {
    id: crypto.randomUUID(),
    name,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, TOKEN_PREFIX_LEN),
    capabilities: sanitizeCapabilities(input && input.capabilities),
    projectIds: sanitizeProjectIds(input && input.projectIds),
    expiresAt: ttlMs == null ? null : now + ttlMs,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
    requireApproval: input && input.requireApproval === false ? false : true,
    managedWorktree: input && input.managedWorktree === false ? false : true,
    launchesPerHour: clampRate(
      input && input.launchesPerHour,
      DEFAULT_LAUNCHES_PER_HOUR,
      1000,
    ),
    readsPerMinute: clampRate(
      input && input.readsPerMinute,
      DEFAULT_READS_PER_MINUTE,
      10000,
    ),
    launchHits: [],
    readHits: [],
  };
  store.pairings.push(row);
  saveStore(userDataPath, store);
  const pairing = toPublic(row);
  const status = typeof opts.getOrchStatus === "function" ? opts.getOrchStatus() : null;
  const port =
    status && Number.isInteger(status.port) && status.port > 0
      ? status.port
      : readOrchPort(userDataPath);
  const configs = buildConfigs({ token, port, pairing });
  return { pairing, token, ...configs };
}

function revokePairing(userDataPath, id, opts = {}) {
  const now = opts.now || Date.now();
  const want = String(id || "").trim();
  if (!want) throw new Error("Pairing id is required");
  const store = loadStore(userDataPath);
  const row = store.pairings.find((p) => p && p.id === want);
  if (!row) throw new Error(`Unknown pairing: ${want}`);
  if (!row.revokedAt) {
    row.revokedAt = now;
    saveStore(userDataPath, store);
  }
  return toPublic(row);
}

/**
 * Verify a presented bearer token against stored pairing hashes.
 * @returns {{ ok: true, pairing: object } | { ok: false, reason: string }}
 */
function authorizeToken(userDataPath, token, opts = {}) {
  const presented = String(token || "");
  if (!presented) return { ok: false, reason: "missing" };
  const now = opts.now || Date.now();
  const kind = opts.kind === "launch" ? "launch" : "read";
  let store;
  try {
    store = loadStore(userDataPath);
  } catch {
    return { ok: false, reason: "unknown" };
  }
  const hash = hashToken(presented);
  let found = null;
  for (const row of store.pairings) {
    if (!row || row.revokedAt) continue;
    if (typeof row.tokenHash !== "string") continue;
    if (timingSafeEqualString(row.tokenHash, hash)) {
      found = row;
      break;
    }
  }
  if (!found) return { ok: false, reason: "unknown" };
  if (Number.isFinite(found.expiresAt) && found.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }
  if (opts.consume === false) {
    return { ok: true, pairing: found };
  }
  if (!tryConsume(found, kind, now)) {
    return { ok: false, reason: "rate_limited" };
  }
  found.lastUsedAt = now;
  try {
    saveStore(userDataPath, store);
  } catch {
    // Auth still succeeded; a persist miss must not 401 the client.
  }
  return { ok: true, pairing: found };
}

function hasCapability(pairing, cap) {
  return Boolean(
    pairing &&
      Array.isArray(pairing.capabilities) &&
      pairing.capabilities.includes(cap),
  );
}

function projectAllowed(pairing, projectId) {
  if (!pairing) return false;
  if (!Array.isArray(pairing.projectIds)) return true;
  return pairing.projectIds.includes(String(projectId || ""));
}

function pairingOwnsThread(pairing, thread) {
  return Boolean(pairing && thread && String(thread.pairingId || "") === String(pairing.id));
}

function canReadThread(pairing, thread) {
  if (!thread || !pairing) return false;
  if (!projectAllowed(pairing, thread.projectId)) return false;
  if (hasCapability(pairing, "read_all")) return true;
  return pairingOwnsThread(pairing, thread);
}

function lastAssistantLine(store, threadId) {
  const msgs = typeof store.getMessages === "function" ? store.getMessages(threadId) || [] : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.text != null && String(m.text)) {
      return String(m.text).split(/\r?\n/)[0] || null;
    }
  }
  return null;
}

function publicTask(store, thread) {
  if (!thread) return null;
  const awaitingApproval = thread.pendingExternalApproval === true;
  const project =
    typeof store.getProject === "function" ? store.getProject(thread.projectId) : null;
  return {
    threadId: thread.id,
    title: thread.title ?? null,
    projectId: thread.projectId ?? null,
    projectName: project && project.name ? project.name : null,
    status: awaitingApproval ? "awaiting_approval" : thread.status ?? null,
    lastError: thread.lastError ? String(thread.lastError) : null,
    lastAssistant: lastAssistantLine(store, thread.id),
    awaitingApproval,
    pairingId: thread.pairingId ?? null,
  };
}

function requireCap(pairing, cap) {
  if (hasCapability(pairing, cap)) return;
  throw new Error(`This pairing does not allow ${cap}`);
}

function titleFromPrompt(prompt) {
  const line = String(prompt || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || "External task";
}

function notifyPairingLaunch(deps, { thread, pairing, project }) {
  const broadcast = deps.broadcast;
  if (typeof broadcast === "function") {
    try {
      const { listThreads } = require("./services.js");
      broadcast("threads:changed", listThreads(deps.store));
    } catch {
      broadcast("threads:changed", []);
    }
  }
  if (typeof deps.notify === "function") {
    try {
      deps.notify({
        title: "Solenta pairing",
        body: `${pairing.name} wants to start "${thread.title}"${
          project && project.name ? ` in ${project.name}` : ""
        }`,
        threadId: thread.id,
      });
    } catch {
      // ignore
    }
  }
}

/**
 * Tool handlers for a pairing-authenticated MCP session.
 * Separate from the in-app coder-threads surface: there is no "your thread".
 */
function createExternalHandlers(deps) {
  const { store, runner, pairing } = deps;
  const createThread =
    deps.createThread || ((s, input) => require("./services.js").createThread(s, input));
  const canHostWorktree =
    deps.canHostWorktree ||
    ((project) => require("./services.js").canHostWorktree(project));
  const setArchived =
    deps.setArchived ||
    ((s, input) => require("./services.js").setArchived(s, input));
  const getProvider =
    deps.getProvider || ((id) => require("./providers.js").getProvider(id));
  const userDataPath = deps.userDataPath || "";

  function requireProject(projectId) {
    const id = String(projectId || "").trim();
    if (!id) throw new Error("projectId is required");
    const project = typeof store.getProject === "function" ? store.getProject(id) : null;
    if (!project) throw new Error(`Unknown project: ${id}`);
    if (!projectAllowed(pairing, id)) {
      throw new Error("This pairing cannot access that project");
    }
    return project;
  }

  function requireReadable(threadId) {
    const thread = store.getThread(threadId);
    if (!thread || !canReadThread(pairing, thread)) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    return thread;
  }

  function requireOwned(threadId) {
    const thread = requireReadable(threadId);
    if (!pairingOwnsThread(pairing, thread)) {
      throw new Error(`Thread ${threadId} was not launched by this pairing`);
    }
    return thread;
  }

  async function projects_list() {
    const projects =
      typeof store.getProjects === "function" ? store.getProjects() || [] : [];
    return projects
      .filter((p) => p && projectAllowed(pairing, p.id))
      .map((p) => ({
        id: p.id,
        name: p.name ?? null,
        slug: p.path ? path.basename(String(p.path)) : null,
      }));
  }

  async function task_list() {
    const threads = typeof store.getThreads === "function" ? store.getThreads() || [] : [];
    return threads
      .filter((t) => t && !Number.isFinite(t.trashedAt) && canReadThread(pairing, t))
      .map((t) => publicTask(store, t));
  }

  async function task_status(args) {
    const thread = requireReadable(args && args.threadId);
    return publicTask(store, thread);
  }

  async function task_launch(args) {
    requireCap(pairing, "launch");
    const prompt = String((args && args.prompt) || "").trim();
    if (!prompt) throw new Error("prompt is required");
    const project = requireProject(args && args.projectId);
    if (pairing.managedWorktree !== false && !canHostWorktree(project)) {
      throw new Error(
        "This pairing starts work in a managed git worktree, but that project cannot host one (remote or not a git checkout).",
      );
    }
    if (args && args.provider != null) {
      if (!getProvider(String(args.provider))) {
        throw new Error(`Unknown provider: ${args.provider}`);
      }
    }
    const consumed = authorizeToken(userDataPath, deps.presentedToken, {
      kind: "launch",
      now: deps.now,
    });
    if (!consumed.ok) {
      if (consumed.reason === "rate_limited") {
        throw new Error("Launch rate limit reached for this pairing. Try again later.");
      }
      throw new Error("Pairing is no longer valid");
    }
    const title = String((args && args.title) || "").trim() || titleFromPrompt(prompt);
    const input = { projectId: project.id, title };
    if (args && args.provider != null) input.provider = String(args.provider);
    const thread = createThread(store, input);
    /** @type {Record<string, unknown>} */
    const patch = {
      pairingId: pairing.id,
      pairingLabel: pairing.name,
      pendingExternalPrompt: prompt,
    };
    if (pairing.managedWorktree !== false) patch.pendingWorktree = true;
    if (pairing.requireApproval !== false) patch.pendingExternalApproval = true;
    store.updateThread(thread.id, patch);
    store.save();
    const fresh = store.getThread(thread.id) || { ...thread, ...patch };
    if (pairing.requireApproval !== false) {
      notifyPairingLaunch(deps, { thread: fresh, pairing, project });
      return publicTask(store, fresh);
    }
    await runner.startRun({ threadId: fresh.id, prompt });
    store.updateThread(fresh.id, { pendingExternalPrompt: null });
    store.save();
    if (typeof deps.broadcast === "function") {
      try {
        const { listThreads } = require("./services.js");
        deps.broadcast("threads:changed", listThreads(store));
      } catch {
        deps.broadcast("threads:changed", []);
      }
    }
    return publicTask(store, store.getThread(fresh.id) || fresh);
  }

  async function task_send(args) {
    requireCap(pairing, "steer");
    const prompt = String((args && args.prompt) || "").trim();
    if (!prompt) throw new Error("prompt is required");
    const thread = requireOwned(args && args.threadId);
    if (thread.pendingExternalApproval === true) {
      throw new Error(
        "This task is waiting for the user to approve it in Solenta. Do not send a follow-up yet.",
      );
    }
    const running =
      (typeof runner.isRunning === "function" && runner.isRunning(thread.id)) ||
      thread.status === "working";
    if (running) {
      throw new Error("Task is still running. Poll task_status, then send when it is idle.");
    }
    await runner.startRun({ threadId: thread.id, prompt });
    return publicTask(store, store.getThread(thread.id) || thread);
  }

  async function task_stop(args) {
    requireCap(pairing, "steer");
    const thread = requireOwned(args && args.threadId);
    if (thread.pendingExternalApproval === true) {
      store.updateThread(thread.id, {
        pendingExternalApproval: false,
        pendingExternalPrompt: null,
      });
      setArchived(store, { threadId: thread.id, archived: true });
      if (typeof deps.broadcast === "function") {
        try {
          const { listThreads } = require("./services.js");
          deps.broadcast("threads:changed", listThreads(store));
        } catch {
          deps.broadcast("threads:changed", []);
        }
      }
      return { threadId: thread.id, status: "rejected" };
    }
    if (typeof runner.stopRun === "function") {
      await runner.stopRun({ threadId: thread.id });
    }
    return publicTask(store, store.getThread(thread.id) || thread);
  }

  return {
    projects_list,
    task_list,
    task_status,
    task_launch,
    task_send,
    task_stop,
  };
}

function buildExternalMcpServer(sdk, handlers, pairing) {
  const { McpServer, z } = sdk;
  const server = new McpServer(
    { name: EXTERNAL_SERVER_NAME, version: "0.1.0" },
    { instructions: EXTERNAL_INSTRUCTIONS },
  );

  const json = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  });

  server.registerTool(
    "projects_list",
    {
      description:
        "List projects this Solenta pairing can see (id, name, folder slug). " +
        "Pass a projectId from this list to task_launch. Do not guess ids.",
      inputSchema: {},
    },
    async () => json(await handlers.projects_list()),
  );

  server.registerTool(
    "task_list",
    {
      description:
        "List tasks this pairing can read. Default: only tasks this pairing " +
        "launched. Status awaiting_approval means the user has not approved " +
        "the run in Solenta yet.",
      inputSchema: {},
    },
    async () => json(await handlers.task_list()),
  );

  server.registerTool(
    "task_status",
    {
      description:
        "Status of one task: status, last assistant line, lastError, " +
        "awaitingApproval. Poll this after task_launch; do not sit idle.",
      inputSchema: { threadId: z.string().min(1) },
    },
    async (args) => json(await handlers.task_status(args)),
  );

  if (hasCapability(pairing, "launch")) {
    server.registerTool(
      "task_launch",
      {
        description:
          "Create a Solenta task in a project from projects_list and start it " +
          "(or queue it for in-app approval). prompt must be self-contained. " +
          "Returns threadId and status (awaiting_approval or working).",
        inputSchema: {
          projectId: z.string().min(1),
          prompt: z.string().min(1),
          title: z.string().min(1).optional(),
          provider: z.string().min(1).optional(),
        },
      },
      async (args) => json(await handlers.task_launch(args)),
    );
  }

  if (hasCapability(pairing, "steer")) {
    server.registerTool(
      "task_send",
      {
        description:
          "Send a follow-up prompt to a task this pairing launched, once it is idle.",
        inputSchema: {
          threadId: z.string().min(1),
          prompt: z.string().min(1),
        },
      },
      async (args) => json(await handlers.task_send(args)),
    );
    server.registerTool(
      "task_stop",
      {
        description:
          "Stop a running task this pairing launched, or decline one still " +
          "waiting for approval.",
        inputSchema: { threadId: z.string().min(1) },
      },
      async (args) => json(await handlers.task_stop(args)),
    );
  }

  return server;
}

function presentedTokenFromRequest(req, url) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  const queryToken = url.searchParams.get("token");
  return queryToken == null ? "" : queryToken;
}

function approveExternalRun(deps, threadId) {
  const { store, runner } = deps;
  const thread = store.getThread(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  if (thread.pendingExternalApproval !== true) {
    throw new Error("This thread is not waiting for pairing approval");
  }
  const prompt = String(thread.pendingExternalPrompt || "").trim();
  if (!prompt) throw new Error("This pairing launch has no prompt to run");
  store.updateThread(threadId, {
    pendingExternalApproval: false,
  });
  store.save();
  return runner.startRun({ threadId, prompt }).then((result) => {
    store.updateThread(threadId, { pendingExternalPrompt: null });
    store.save();
    if (typeof deps.broadcast === "function") {
      try {
        const { listThreads } = require("./services.js");
        deps.broadcast("threads:changed", listThreads(store));
      } catch {
        deps.broadcast("threads:changed", []);
      }
    }
    return result;
  });
}

function rejectExternalRun(deps, threadId) {
  const { store } = deps;
  const thread = store.getThread(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  if (thread.pendingExternalApproval !== true) {
    throw new Error("This thread is not waiting for pairing approval");
  }
  store.updateThread(threadId, {
    pendingExternalApproval: false,
    pendingExternalPrompt: null,
  });
  const setArchived =
    deps.setArchived ||
    ((s, input) => require("./services.js").setArchived(s, input));
  setArchived(store, { threadId, archived: true });
  if (typeof deps.broadcast === "function") {
    try {
      const { listThreads } = require("./services.js");
      deps.broadcast("threads:changed", listThreads(store));
    } catch {
      deps.broadcast("threads:changed", []);
    }
  }
  return store.getThread(threadId) || thread;
}

module.exports = {
  FILE_NAME,
  MAX_PAIRINGS,
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  DEFAULT_TTL_MS,
  DEFAULT_LAUNCHES_PER_HOUR,
  DEFAULT_READS_PER_MINUTE,
  EXTERNAL_SERVER_NAME,
  EXTERNAL_INSTRUCTIONS,
  hashToken,
  toPublic,
  listPairings,
  createPairing,
  revokePairing,
  authorizeToken,
  hasCapability,
  projectAllowed,
  canReadThread,
  createExternalHandlers,
  buildExternalMcpServer,
  presentedTokenFromRequest,
  approveExternalRun,
  rejectExternalRun,
  buildConfigs,
  mcpUrl,
  readOrchPort,
};
