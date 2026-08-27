"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { defaultWhich } = require("./providers.js");
const { recordSecretUse } = require("./secrets.js");

const CONFIG_NAME = "memory-server.json";
const MCP_CONFIG_NAME = "mcp-coder-memory.json";
const HEALTH_TIMEOUT_MS = 1000;
const SPAWN_WAIT_MS = 5000;
const HEALTH_POLL_MS = 100;

/** @type {{ running: boolean, adopted: boolean, port: number | null }} */
let globalStatus = { running: false, adopted: false, port: null };
/** @type {string | null} */
let globalMcpConfigPath = null;
/** @type {string | null} */
let globalToken = null;
/** @type {string | null} */
let globalUserDataPath = null;
/**
 * Additional in-main MCP servers (e.g. coder-threads) registered alongside
 * coder-memory. Every provider hook below serves the whole list.
 * Remote entries have `url`; stdio entries have `transport: "stdio"` plus
 * command/args. `user` marks settings-driven entries so syncUserMcpServers
 * can reconcile them without touching built-ins.
 * @type {Array<object>}
 */
let extraServers = [];
/** @type {import('node:child_process').ChildProcess | null} */
let ownedChild = null;

/**
 * Write a file that carries bearer tokens: owner-only, even when it already
 * existed with looser permissions (writeFileSync's `mode` only applies on
 * create). Best-effort chmod: foreign files may not be ours to change.
 * @param {string} file
 * @param {string} data
 */
function writeSecretFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600, encoding: "utf8" });
  chmodSecret(file);
}

/** @param {string} file */
function chmodSecret(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}

/**
 * All MCP servers currently available for injection, coder-memory first.
 * Built-ins stay remote HTTP. User entries may be remote or stdio.
 * @returns {Array<object>}
 */
function activeServers() {
  /** @type {Array<object>} */
  const list = [];
  if (globalStatus.running && globalStatus.port && globalToken) {
    list.push({
      name: "coder-memory",
      transport: "http",
      port: globalStatus.port,
      token: globalToken,
      url: `http://127.0.0.1:${globalStatus.port}/mcp`,
    });
  }
  return list.concat(extraServers);
}

/** @param {object} s */
function isStdioServer(s) {
  return Boolean(s && s.transport === "stdio");
}

/**
 * Register an extra MCP server (e.g. the coder-threads orchestrator) so all
 * four provider hooks include it. Rewrites the claude mcp config and
 * best-effort refreshes the kimi/grok registrations. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.name - server name, e.g. "coder-threads"
 * @param {number} [opts.port] - local server port; url is derived from it
 * @param {string} [opts.url] - full MCP endpoint (user servers); overrides port
 * @param {string} [opts.token] - bearer token; required for port-based servers,
 *   optional for url-based user servers
 * @param {boolean} [opts.user] - marks a settings-driven entry (sync-managed)
 * @param {string} [opts.userDataPath] - needed to rewrite the claude config
 *   when markHealthy has not run (memory down but orchestrator up)
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {boolean} true if registered
 */
function registerMcpServer(opts) {
  const log = opts.log || ((msg) => console.warn(msg));
  const name = String(opts.name || "");
  const port = Number(opts.port);
  const token = String(opts.token || "");
  // "coder-memory" is owned by markHealthy and must not be replaced here.
  if (!name || name === "coder-memory") return false;
  const { isHttpUrl } = require("./mcp.js");

  /** @type {object} */
  let entry;
  if (opts.transport === "stdio" || (typeof opts.command === "string" && opts.command && !opts.url)) {
    const command = typeof opts.command === "string" ? opts.command : "";
    if (!command) return false;
    if (typeof opts.cwd === "string" && opts.cwd) {
      try {
        if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
          log(
            "memory-server: provider error: stdio cwd does not exist: " +
              name,
          );
          return false;
        }
      } catch {
        log("memory-server: provider error: stdio cwd is not usable: " + name);
        return false;
      }
    }
    if (opts.user && opts.trusted !== true) return false;
    /** @type {Record<string, string>} */
    const serverEnv = {};
    if (opts.serverEnv && typeof opts.serverEnv === "object" && !Array.isArray(opts.serverEnv)) {
      for (const [k, v] of Object.entries(opts.serverEnv)) {
        if (typeof v === "string") serverEnv[k] = v;
      }
    }
    entry = {
      name,
      transport: "stdio",
      command,
      args: Array.isArray(opts.args) ? opts.args.map((a) => String(a)) : [],
      env: serverEnv,
      trusted: opts.trusted === true,
      port: null,
      token: "",
      url: "",
    };
    if (typeof opts.cwd === "string" && opts.cwd) entry.cwd = opts.cwd;
  } else {
    const urlRaw = typeof opts.url === "string" ? opts.url : "";
    let url = urlRaw.trim();
    if (urlRaw) {
      if (/[\u0000-\u001f\u007f]/.test(urlRaw) || !isHttpUrl(url)) return false;
    } else {
      // Port-based local server: bearer token is mandatory (loopback auth).
      if (!token) return false;
      if (!port || !Number.isFinite(port)) return false;
      url = `http://127.0.0.1:${port}/mcp`;
    }
    entry = {
      name,
      transport: opts.transport === "sse" ? "sse" : "http",
      port: Number.isFinite(port) && port > 0 ? port : null,
      token,
      url,
    };
    if (opts.headers && typeof opts.headers === "object" && !Array.isArray(opts.headers)) {
      /** @type {Record<string, string>} */
      const headers = {};
      for (const [k, v] of Object.entries(opts.headers)) {
        if (typeof v === "string" && v) headers[k] = v;
      }
      if (Object.keys(headers).length) entry.headers = headers;
    }
  }
  if (opts.user) entry.user = true;
  const idx = extraServers.findIndex((s) => s.name === name);
  if (idx >= 0) {
    extraServers[idx] = entry;
  } else {
    extraServers.push(entry);
  }
  const userDataPath = opts.userDataPath || globalUserDataPath;
  if (userDataPath) {
    try {
      writeMcpConfig(userDataPath);
    } catch (err) {
      log(
        "memory-server: failed to rewrite claude mcp config: " +
          (err && err.message ? err.message : String(err)),
      );
    }
  }
  // Best-effort: fold the new server into the file/CLI-based providers too.
  try {
    ensureKimiMcpConfig({ log, env: opts.env });
  } catch {
    // ignore
  }
  try {
    ensureGrokMcpConfig({ log, env: opts.env });
  } catch {
    // ignore
  }
  return true;
}

/**
 * Remove a previously registered extra server: rewrite the claude config and
 * revoke the copies kimi/grok persisted in the user's home, so the bearer
 * token does not outlive the server it authenticates against.
 * @param {string} name
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {boolean} true if a server was removed
 */
function unregisterMcpServer(name, opts = {}) {
  const idx = extraServers.findIndex((s) => s.name === name);
  if (idx < 0) return false;
  extraServers.splice(idx, 1);
  if (globalUserDataPath) {
    try {
      writeMcpConfig(globalUserDataPath);
    } catch {
      // ignore
    }
  }
  forgetExternalMcp([name], opts);
  return true;
}

/**
 * Reconcile user-registered MCP servers with the settings slice. Built-in
 * registrations (coder-memory via markHealthy, coder-threads via the orch
 * server) are never touched: only entries previously marked `user` are
 * removed, and reserved names in the desired list are skipped defensively.
 * Never throws.
 *
 * @param {unknown} servers - settings.mcpServers: [{ name, url, token?, enabled }]
 * @param {object} [opts]
 * @param {string} [opts.userDataPath]
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function syncUserMcpServers(servers, opts = {}) {
  const log = opts.log || ((msg) => console.warn(msg));
  /** @type {Map<string, object>} */
  const desired = new Map();
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== "object") continue;
    const name = typeof s.name === "string" ? s.name : "";
    if (!name || name === "coder-memory" || name === "coder-threads") continue;
    if (s.enabled === false) continue;
    if (s.transport === "stdio" || (s.command && !s.url)) {
      if (s.trusted !== true) continue;
    }
    desired.set(name, s);
  }
  try {
    for (const entry of [...extraServers]) {
      if (entry.user && !desired.has(entry.name)) {
        unregisterMcpServer(entry.name);
      }
    }
    for (const s of desired.values()) {
      registerMcpServer({
        name: s.name,
        transport: s.transport,
        url: typeof s.url === "string" ? s.url : "",
        token: typeof s.token === "string" ? s.token : "",
        headers: s.headers,
        command: s.command,
        args: s.args,
        serverEnv: s.env,
        cwd: s.cwd,
        trusted: s.trusted === true,
        user: true,
        userDataPath: opts.userDataPath,
        log,
        env: opts.env,
      });
    }
  } catch (err) {
    log(
      "memory-server: failed to sync user MCP servers: " +
        (err && err.message ? err.message : String(err)),
    );
  }
}

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
  globalToken = null;
  globalUserDataPath = null;
  extraServers = [];
}

/**
 * Claude argv extras when at least one MCP server is up:
 * ['--mcp-config', path, '--allowedTools', ...] or [].
 * @returns {string[]}
 */
function getClaudeMcpArgs(opts = {}) {
  const servers = activeServers();
  if (servers.length === 0 || !globalMcpConfigPath) return [];
  const projectPath = opts.projectPath ? String(opts.projectPath) : "";
  const memoryOnly = opts.memoryOnly === true;
  let configPath = globalMcpConfigPath;
  if ((projectPath || memoryOnly) && globalUserDataPath) {
    try {
      configPath = writeBoundMcpConfig(
        globalUserDataPath,
        projectPath,
        memoryOnly ? { memoryOnly: true } : {},
      );
    } catch {
      configPath = globalMcpConfigPath;
    }
  }
  // Both flags MUST use the single equals form: the claude CLI treats the
  // space-separated variants as variadic and swallows the trailing PROMPT as
  // another value, failing every real run with
  // "MCP config file not found: <prompt text>".
  //
  // The allow rule is required, not cosmetic: in headless -p runs there is
  // nobody to approve a tool prompt, so without it every memory call is
  // silently denied (permission_denials) and the agent reports no memory.
  //
  // Scope is exactly our OWN servers (coder-memory, coder-threads). A
  // user-registered endpoint stays in the mcp config but is never blanket
  // approved: `mcp__<name>__*` would pre-approve every tool it exposes now
  // and any it adds later, which is a silent code-execution channel for a
  // compromised remote server in every headless turn.
  //
  // memoryOnly (issue #722 sleep-time consolidation): coder-memory only,
  // written to a *-memory.json bound file so a concurrent normal Claude
  // run cannot pick up the stripped document.
  const args = [`--mcp-config=${configPath}`];
  const ours = servers.filter((s) => !s.user);
  const allowed = memoryOnly
    ? ours.filter((s) => s.name === "coder-memory")
    : ours;
  if (allowed.length > 0) {
    args.push(
      `--allowedTools=${allowed.map((s) => `mcp__${s.name}__*`).join(" ")}`,
    );
  }
  return args;
}

/**
 * Env var codex reads a server's bearer token from. Never put the token in
 * argv: `ps` exposes the full command line of every process to every local
 * user, and these tokens drive thread_fork/thread_send (arbitrary agent runs).
 * @param {string} name
 */
function envNamePart(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function codexTokenEnvVar(name) {
  return "CODER_MCP_TOKEN_" + envNamePart(name);
}

function headerEnvVar(serverName, headerName) {
  return "CODER_MCP_HEADER_" + envNamePart(serverName) + "_" + envNamePart(headerName);
}

/**
 * Codex argv extras when at least one MCP server is up, or [].
 * Values are TOML strings: mcp_servers.<name>.url="http://.../mcp" plus
 * mcp_servers.<name>.bearer_token_env_var="CODER_MCP_TOKEN_<NAME>"; pair with
 * getCodexMcpEnv() on the spawn or codex sees no credential.
 * @returns {string[]}
 */
/**
 * Escape a string for a TOML basic string used in Codex `-c` values.
 * @param {unknown} value
 * @returns {string}
 */
function tomlEscape(value) {
  const s = String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\b") out += "\\b";
    else if (c === "\t") out += "\\t";
    else if (c === "\n") out += "\\n";
    else if (c === "\f") out += "\\f";
    else if (c === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += c;
    }
  }
  return out;
}

function getCodexMcpArgs(opts = {}) {
  const projectPath = opts.projectPath ? String(opts.projectPath) : "";
  /** @type {string[]} */
  const args = [];
  for (const s of activeServers()) {
    if (isStdioServer(s)) {
      args.push("-c", `mcp_servers.${s.name}.command="${tomlEscape(s.command)}"`);
      const argv = Array.isArray(s.args) ? s.args : [];
      args.push(
        "-c",
        `mcp_servers.${s.name}.args=[${argv
          .map((a) => `"${tomlEscape(a)}"`)
          .join(", ")}]`,
      );
      const envKeys =
        s.env && typeof s.env === "object" ? Object.keys(s.env) : [];
      if (envKeys.length) {
        args.push(
          "-c",
          `mcp_servers.${s.name}.env_vars=[${envKeys
            .map((k) => `"${tomlEscape(k)}"`)
            .join(",")}]`,
        );
      }
      if (typeof s.cwd === "string" && s.cwd) {
        args.push("-c", `mcp_servers.${s.name}.cwd="${tomlEscape(s.cwd)}"`);
      }
      continue;
    }
    if (s.transport === "sse") {
      console.warn(
        `memory-server: Codex does not support SSE MCP server ${s.name}; skipping`,
      );
      continue;
    }
    args.push(
      "-c",
      `mcp_servers.${s.name}.url="${tomlEscape(boundCoderMemoryUrl(s.url, s.name, projectPath))}"`,
    );
    if (s.token) {
      args.push(
        "-c",
        `mcp_servers.${s.name}.bearer_token_env_var="${codexTokenEnvVar(s.name)}"`,
      );
    }
    const headers =
      s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)
        ? s.headers
        : {};
    const headerKeys = Object.keys(headers).filter(
      (k) => !(s.token && k.toLowerCase() === "authorization"),
    );
    if (headerKeys.length) {
      args.push(
        "-c",
        `mcp_servers.${s.name}.env_http_headers={ ${headerKeys
          .map(
            (k) =>
              `"${tomlEscape(k)}" = "${tomlEscape(headerEnvVar(s.name, k))}"`,
          )
          .join(", ")} }`,
      );
    }
  }
  return args;
}

/**
 * Token env vars for a codex child, matching getCodexMcpArgs(). Empty when no
 * server is up.
 * @returns {Record<string, string>}
 */
function getCodexMcpEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const s of activeServers()) {
    if (isStdioServer(s)) {
      if (s.env && typeof s.env === "object") {
        for (const [k, v] of Object.entries(s.env)) {
          if (typeof v === "string") env[k] = v;
        }
      }
      continue;
    }
    if (s.transport === "sse") continue;
    if (s.token) env[codexTokenEnvVar(s.name)] = s.token;
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) {
      for (const [k, v] of Object.entries(s.headers)) {
        if (typeof v !== "string") continue;
        if (s.token && k.toLowerCase() === "authorization") continue;
        env[headerEnvVar(s.name, k)] = v;
      }
    }
  }
  return env;
}

/**
 * Env values for Grok child processes so config `${VAR}` refs resolve.
 * Secrets stay out of `grok mcp add` argv.
 * @returns {Record<string, string>}
 */
function getGrokMcpEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const s of activeServers()) {
    if (isStdioServer(s)) {
      if (s.env && typeof s.env === "object") {
        for (const [k, v] of Object.entries(s.env)) {
          if (typeof v === "string") env[k] = v;
        }
      }
      continue;
    }
    if (s.token) env[codexTokenEnvVar(s.name)] = s.token;
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) {
      for (const [k, v] of Object.entries(s.headers)) {
        if (typeof v === "string") env[headerEnvVar(s.name, k)] = v;
      }
    }
  }
  return env;
}

/**
 * Merge Grok MCP env onto an existing spawn env (e.g. OTEL).
 * @param {Record<string, string> | undefined | null} base
 * @returns {Record<string, string> | undefined}
 */
function mergeGrokSpawnEnv(base) {
  const extra = getGrokMcpEnv();
  if (!extra || Object.keys(extra).length === 0) {
    return base && Object.keys(base).length ? base : undefined;
  }
  return { ...(base || {}), ...extra };
}

/**
 * Resolve path to kimi's mcp.json (env override or ~/.kimi-code/mcp.json).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveKimiMcpPath(env = process.env) {
  if (env.CODER_KIMI_MCP_PATH) {
    return String(env.CODER_KIMI_MCP_PATH);
  }
  return path.join(osHomedir(), ".kimi-code", "mcp.json");
}

/**
 * Append query params to an MCP URL. Used to bind a kimi run to one
 * project so the server, not the model, owns the scope (issue #671).
 * @param {string} url
 * @param {Record<string, string | null | undefined>} [query]
 */
function withQuery(url, query) {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Bind coder-memory to a live working directory so the server, not the
 * model, owns project scope (issue #671 / #710). Other servers stay bare.
 * @param {string} url
 * @param {string} name
 * @param {string} [projectPath]
 */
function boundCoderMemoryUrl(url, name, projectPath) {
  if (name === "coder-memory" && projectPath) {
    return withQuery(url, { project: projectPath });
  }
  return url;
}

/**
 * Bind Solenta HTTP MCP URLs for a grok run. coder-memory gets `?project=`
 * (working directory); coder-threads gets `?projectId=` so the server, not
 * the model, owns the scope (issue #706). Other servers stay bare.
 * @param {string} url
 * @param {string} name
 * @param {{ projectPath?: string, projectId?: string }} [opts]
 */
function boundSolentaMcpUrl(url, name, opts = {}) {
  /** @type {Record<string, string>} */
  const query = {};
  if (name === "coder-memory" && opts.projectPath) {
    query.project = String(opts.projectPath);
  }
  if (name === "coder-threads" && opts.projectId) {
    query.projectId = String(opts.projectId);
  }
  return withQuery(url, query);
}

/**
 * Desired kimi mcp.json entry for one of our servers.
 * @param {string} url
 * @param {string} token
 * @param {Record<string, string | null | undefined>} [query]
 */
function kimiHttpEntry(url, token, query, headers, transport) {
  const entry = {
    type: transport === "sse" ? "sse" : "http",
    url: withQuery(url, query),
    headers: { ...(headers && typeof headers === "object" ? headers : {}) },
  };
  if (token) {
    entry.headers.Authorization = `Bearer ${token}`;
  }
  return entry;
}

/**
 * @param {object} s
 */
function kimiStdioEntry(s) {
  const entry = {
    type: "stdio",
    command: s.command,
    args: Array.isArray(s.args) ? s.args : [],
    env: s.env && typeof s.env === "object" ? { ...s.env } : {},
  };
  if (typeof s.cwd === "string" && s.cwd) entry.cwd = s.cwd;
  return entry;
}

/**
 * Solenta MCP servers for one kimi run, URLs bound to that project.
 * Does not read the user's ~/.kimi-code/mcp.json — foreign servers stay out.
 *
 * @param {{ projectId?: string, projectPath?: string }} [opts]
 * @returns {Record<string, { type: string, url: string, headers: { Authorization?: string } }>}
 */
function kimiMcpServersForRun(opts = {}) {
  const projectId = opts.projectId ? String(opts.projectId) : "";
  const projectPath = opts.projectPath ? String(opts.projectPath) : "";
  /** @type {Record<string, { type: string, url: string, headers: { Authorization?: string } }>} */
  const mcpServers = {};
  for (const s of activeServers()) {
    if (isStdioServer(s)) {
      mcpServers[s.name] = kimiStdioEntry(s);
      continue;
    }
    /** @type {Record<string, string>} */
    const query = {};
    if (s.name === "coder-memory" && projectPath) query.project = projectPath;
    if (s.name === "coder-threads" && projectId) query.projectId = projectId;
    mcpServers[s.name] = kimiHttpEntry(s.url, s.token, query, s.headers, s.transport);
  }
  return mcpServers;
}

/**
 * When at least one MCP server is up and kimi binary is available, MERGE our
 * servers into kimi's mcp.json (never overwrite whole file). Backup once
 * before first edit of an existing file. On parse failure of an existing
 * file: log and leave it.
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(bin: string) => boolean} [opts.isKimiAvailable] - inject for tests
 * @returns {boolean} true if file was written or already correct
 */
function ensureKimiMcpConfig(opts = {}) {
  const log = opts.log || ((msg) => console.warn(msg));
  const env = opts.env || process.env;

  const servers = activeServers();
  if (servers.length === 0) {
    return false;
  }

  let kimiOk = false;
  if (typeof opts.isKimiAvailable === "function") {
    kimiOk = Boolean(opts.isKimiAvailable("kimi"));
  } else {
    try {
      const {
        getProvider,
        resolveBin,
        isBinAvailable,
      } = require("./providers.js");
      const entry = getProvider("kimi");
      if (entry) {
        kimiOk = isBinAvailable(resolveBin(entry, env), undefined, env);
      }
    } catch (err) {
      log(
        "memory-server: kimi availability check failed: " +
          (err && err.message ? err.message : String(err)),
      );
      return false;
    }
  }
  if (!kimiOk) return false;

  const mcpPath = resolveKimiMcpPath(env);
  /** @type {Record<string, { type: string, url: string, headers: { Authorization?: string } }>} */
  const desiredByName = {};
  for (const s of servers) {
    desiredByName[s.name] = isStdioServer(s)
      ? kimiStdioEntry(s)
      : kimiHttpEntry(s.url, s.token, undefined, s.headers, s.transport);
  }

  /** @type {Record<string, unknown>} */
  let doc = {};
  const existed = fs.existsSync(mcpPath);
  if (existed) {
    let raw;
    try {
      raw = fs.readFileSync(mcpPath, "utf8");
    } catch (err) {
      log(
        "memory-server: cannot read kimi mcp.json; leaving untouched: " +
          (err && err.message ? err.message : String(err)),
      );
      return false;
    }
    try {
      doc = JSON.parse(raw);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        log("memory-server: kimi mcp.json is not an object; leaving untouched");
        return false;
      }
    } catch (err) {
      log(
        "memory-server: kimi mcp.json parse failed; leaving untouched: " +
          (err && err.message ? err.message : String(err)),
      );
      return false;
    }
  }

  if (!doc.mcpServers || typeof doc.mcpServers !== "object") {
    doc.mcpServers = {};
  }
  const mcpServersMap = /** @type {Record<string, unknown>} */ (doc.mcpServers);
  // Already correct when every desired entry is present and identical.
  try {
    const allMatch = Object.entries(desiredByName).every(
      ([name, desired]) =>
        mcpServersMap[name] &&
        JSON.stringify(mcpServersMap[name]) === JSON.stringify(desired),
    );
    if (allMatch) {
      return true;
    }
  } catch {
    // fall through to write
  }

  // Backup once before first modification of an existing file.
  if (existed) {
    const backupPath = mcpPath + ".coder-backup";
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(mcpPath, backupPath);
      } catch (err) {
        log(
          "memory-server: failed to backup kimi mcp.json: " +
            (err && err.message ? err.message : String(err)),
        );
        return false;
      }
    }
  }

  for (const [name, desired] of Object.entries(desiredByName)) {
    mcpServersMap[name] = desired;
  }
  try {
    const dir = path.dirname(mcpPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeSecretFile(mcpPath, JSON.stringify(doc, null, 2) + "\n");
  } catch (err) {
    log(
      "memory-server: failed to write kimi mcp.json: " +
        (err && err.message ? err.message : String(err)),
    );
    return false;
  }
  return true;
}

const GROK_MCP_TIMEOUT_MS = 10000;

/** One grok CLI at a time against ~/.grok/config.toml (#626). */
let grokMcpChain = Promise.resolve();

/**
 * Drop our entries from kimi's mcp.json. Their bearer tokens must not outlive
 * the server they authenticate against: the file is user-global, so a stale
 * entry follows every kimi session on the machine. Best-effort, never throws.
 *
 * Runs regardless of whether the kimi binary is still installed — an
 * uninstalled kimi leaves the config (and the token) behind all the same.
 *
 * @param {string[]} names
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {boolean} true if the file was rewritten
 */
function removeKimiMcpEntries(names, opts = {}) {
  const log = opts.log || ((msg) => console.warn(msg));
  const env = opts.env || process.env;
  if (!Array.isArray(names) || names.length === 0) return false;

  const mcpPath = resolveKimiMcpPath(env);
  if (!fs.existsSync(mcpPath)) return false;
  /** @type {Record<string, unknown>} */
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  } catch (err) {
    log(
      "memory-server: cannot read kimi mcp.json for cleanup; leaving untouched: " +
        (err && err.message ? err.message : String(err)),
    );
    return false;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const map = doc.mcpServers;
  if (!map || typeof map !== "object") return false;

  let changed = false;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      delete map[name];
      changed = true;
    }
  }
  if (!changed) return false;
  try {
    writeSecretFile(mcpPath, JSON.stringify(doc, null, 2) + "\n");
  } catch (err) {
    log(
      "memory-server: failed to clean kimi mcp.json: " +
        (err && err.message ? err.message : String(err)),
    );
    return false;
  }
  return true;
}

/**
 * Resolve grok's user config (env override for tests; grok itself has none).
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveGrokConfigPath(env = process.env) {
  if (env.CODER_GROK_CONFIG_PATH) return String(env.CODER_GROK_CONFIG_PATH);
  return path.join(osHomedir(), ".grok", "config.toml");
}

/**
 * Conservative TOML check for grok's config.toml. Catches torn writes
 * (truncated keys, incomplete tables, unclosed quotes) without a parser.
 * @param {string} text
 * @returns {boolean}
 */
function grokTomlLooksValid(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      if (!/^\[[^\]]+\][ \t]*(#.*)?$/.test(line)) return false;
      continue;
    }
    if (!line.includes("=")) return false;
    let quotes = 0;
    let braces = 0;
    for (const ch of line) {
      if (ch === '"') quotes += 1;
      else if (ch === "{") braces += 1;
      else if (ch === "}") braces -= 1;
      if (braces < 0) return false;
    }
    if (quotes % 2 !== 0 || braces !== 0) return false;
  }
  return true;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function looksGrokConfigCorrupt(text) {
  return /Failed to load config:[\s\S]*TOML parse error/i.test(String(text || ""));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function grokConfigCorruptMessage(env = process.env) {
  return `grok's config is corrupt — repair ${resolveGrokConfigPath(env)}`;
}

/** @returns {Promise<void>} settles when every queued grok mcp CLI has finished */
function whenGrokMcpIdle() {
  return grokMcpChain;
}

/**
 * @param {() => (void | Promise<void>)} task
 * @returns {Promise<void>}
 */
function enqueueGrokMcp(task) {
  const run = grokMcpChain.then(task, task);
  grokMcpChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Error | null>}
 */
function execGrokMcp(bin, args, env) {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        { timeout: GROK_MCP_TIMEOUT_MS, encoding: "utf8", env },
        (err) => resolve(err || null),
      );
    } catch (err) {
      resolve(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * @param {string} configPath
 * @returns {{ exists: boolean, data: Buffer | null, skipRestore?: boolean }}
 */
function snapshotGrokConfig(configPath) {
  try {
    return { exists: true, data: fs.readFileSync(configPath) };
  } catch (err) {
    if (err && err.code === "ENOENT") return { exists: false, data: null };
    return { exists: false, data: null, skipRestore: true };
  }
}

/**
 * @param {string} configPath
 * @returns {boolean}
 */
function grokConfigParses(configPath) {
  try {
    if (!fs.existsSync(configPath)) return true;
    return grokTomlLooksValid(fs.readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
}

/**
 * @param {string} configPath
 * @param {{ exists: boolean, data: Buffer | null, skipRestore?: boolean }} snapshot
 * @param {(msg: string) => void} log
 */
function restoreGrokConfigIfCorrupt(configPath, snapshot, log) {
  if (grokConfigParses(configPath)) return;
  if (snapshot.skipRestore) {
    log(
      "memory-server: grok config.toml is corrupt and could not be restored: " +
        configPath,
    );
    return;
  }
  try {
    if (snapshot.exists) {
      fs.writeFileSync(configPath, snapshot.data || Buffer.alloc(0));
      chmodSecret(configPath);
    } else {
      try {
        fs.unlinkSync(configPath);
      } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }
    log(
      "memory-server: grok config.toml was corrupt after mcp write; restored the pre-write copy (" +
        configPath +
        ")",
    );
  } catch (err) {
    log(
      "memory-server: grok config.toml is corrupt and restore failed: " +
        (err && err.message ? err.message : String(err)),
    );
  }
}

/**
 * Grok binary path when grok is installed and the MCP integration is enabled,
 * else "". Shared by the add and remove paths.
 * @param {NodeJS.ProcessEnv} env
 * @param {(msg: string) => void} log
 */
function resolveGrokBin(env, log) {
  // Structural test kill switch: -s user has no path override.
  if (String(env.CODER_GROK_MCP_DISABLE || "") === "1") return "";
  try {
    const {
      getProvider,
      resolveBin,
      isBinAvailable,
    } = require("./providers.js");
    const entry = getProvider("grok");
    if (!entry) return "";
    const bin = resolveBin(entry, env);
    return isBinAvailable(bin, undefined, env) ? bin : "";
  } catch (err) {
    log(
      "memory-server: grok availability check failed: " +
        (err && err.message ? err.message : String(err)),
    );
    return "";
  }
}

/**
 * `grok mcp remove <name> --scope user` for each name, so the bearer tokens grok
 * persisted in ~/.grok/config.toml die with the server. Fire-and-forget as a
 * batch (never block quit); members of the batch share the grok mcp queue
 * with ensureGrokMcpConfig so they cannot tear the file (#626).
 *
 * @param {string[]} names
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {boolean} true if at least one removal was kicked off
 */
function removeGrokMcpEntries(names, opts = {}) {
  const log = opts.log || ((msg) => console.warn(msg));
  const env = opts.env || process.env;
  if (!Array.isArray(names) || names.length === 0) return false;

  const bin = resolveGrokBin(env, log);
  if (!bin) return false;

  const jobs = names.map((name) => ["mcp", "remove", name, "--scope", "user"]);
  enqueueGrokMcp(async () => {
    const configPath = resolveGrokConfigPath(env);
    const snapshot = snapshotGrokConfig(configPath);
    for (const args of jobs) {
      const err = await execGrokMcp(bin, args, env);
      // grok exits 1 when the name was never registered, which is the
      // common case on quit; the log line is informational, not an alarm.
      if (err) {
        log(
          "memory-server: grok mcp remove failed: " +
            (err && err.message ? err.message : String(err)),
        );
      }
    }
    restoreGrokConfigIfCorrupt(configPath, snapshot, log);
  });
  return true;
}

/**
 * Revoke persisted registrations for `names` from the providers that store
 * them in user-global config (kimi's mcp.json, grok's config.toml). Claude and
 * codex read config we own per launch, so they need no cleanup.
 *
 * @param {string[]} names
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function forgetExternalMcp(names, opts = {}) {
  try {
    removeKimiMcpEntries(names, opts);
  } catch {
    // ignore
  }
  try {
    removeGrokMcpEntries(names, opts);
  } catch {
    // ignore
  }
}

/**
 * When at least one MCP server is up and the grok binary is available,
 * register each server via `grok mcp add ...` (idempotent into
 * ~/.grok/config.toml). Never throws; log-and-continue on any failure.
 *
 * Solenta-spawned grok turns do NOT use this path: they get a per-thread
 * GROK_HOME overlay (#706) so MCP URLs are bound to that project and a
 * boot-time stall cannot race the run. This function remains the fallback
 * for ssh/WSL (overlay is local-host) and for the user's own `grok` CLI
 * after markHealthy.
 *
 * Fire-and-forget as a batch (10s timeout per CLI) so a stalling grok binary
 * cannot freeze the Electron main process at boot / adopt. Members of the
 * batch run one at a time on the shared grok mcp queue — concurrent grok
 * processes tear config.toml (#626). After the batch, parse the file and
 * restore the pre-write copy if it is syntactically broken.
 *
 * Kill switch: CODER_GROK_MCP_DISABLE=1 returns false immediately (tests use
 * this because -s user has no path override and would write ~/.grok/config.toml).
 * Binary override: CODER_GROK_BIN via the providers registry.
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.projectPath]
 * @param {string} [opts.projectId]
 * @returns {boolean} true if the mcp add was kicked off; false if skipped
 */
function ensureGrokMcpConfig(opts = {}) {
  const log = opts.log || ((msg) => console.warn(msg));
  const env = opts.env || process.env;

  const servers = activeServers();
  if (servers.length === 0) {
    return false;
  }

  const bin = resolveGrokBin(env, log);
  if (!bin) return false;

  const jobs = servers
    .map((s) => {
      if (isStdioServer(s)) {
        if (typeof s.cwd === "string" && s.cwd) {
          log(
            `memory-server: grok cannot express stdio cwd for ${s.name}; skipping`,
          );
          return null;
        }
        // Official local syntax: `grok mcp add <name> -- <command> <args>`.
        // Env values never go on argv. Where the CLI accepts `-e`, we persist
        // `${VAR}` references (not literals) and merge getGrokMcpEnv() into
        // every Grok spawn so expansion can resolve.
        const args = ["mcp", "add", s.name, "--scope", "user"];
        if (s.env && typeof s.env === "object") {
          for (const k of Object.keys(s.env)) {
            args.push("-e", `${k}=\${${k}}`);
          }
        }
        args.push("--", s.command, ...(Array.isArray(s.args) ? s.args : []));
        return args;
      }
      const args = [
        "mcp",
        "add",
        "--transport",
        s.transport === "sse" ? "sse" : "http",
        s.name,
        boundSolentaMcpUrl(s.url, s.name, opts),
      ];
      if (s.token) {
        args.push(
          "--header",
          `Authorization: Bearer \${${codexTokenEnvVar(s.name)}}`,
        );
      }
      if (s.headers && typeof s.headers === "object") {
        for (const [k, v] of Object.entries(s.headers)) {
          if (typeof v !== "string") continue;
          if (k.toLowerCase() === "authorization" && s.token) continue;
          args.push("--header", `${k}: \${${headerEnvVar(s.name, k)}}`);
        }
      }
      args.push("--scope", "user");
      return args;
    })
    .filter(Boolean);

  enqueueGrokMcp(async () => {
    const configPath = resolveGrokConfigPath(env);
    const snapshot = snapshotGrokConfig(configPath);
    const spawnEnv = { ...env, ...getGrokMcpEnv() };
    for (const args of jobs) {
      const err = await execGrokMcp(bin, args, spawnEnv);
      if (err) {
        log(
          "memory-server: grok mcp add failed: " +
            (err && err.message ? err.message : String(err)),
        );
      }
    }
    // grok writes config.toml 0644; it now holds our bearer token.
    chmodSecret(configPath);
    restoreGrokConfigIfCorrupt(configPath, snapshot, log);
  });
  return true;
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
 * When `token` is a non-empty string, challenge with a nonce and require an
 * HMAC proof so we never send the bearer token to an unverified listener.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @param {string} [token]
 * @returns {Promise<boolean>}
 */
function probeHealth(port, timeoutMs = HEALTH_TIMEOUT_MS, token) {
  return new Promise((resolve) => {
    const useProof = typeof token === "string" && token.length > 0;
    // Nonce is a challenge, not a secret: the token stays on this side.
    const nonce = useProof ? crypto.randomBytes(16).toString("hex") : null;
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: useProof ? `/health?nonce=${encodeURIComponent(nonce)}` : "/health",
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
            if (!(obj && obj.ok === true)) {
              resolve(false);
              return;
            }
            if (!useProof) {
              resolve(true);
              return;
            }
            const proof = typeof obj.proof === "string" ? obj.proof : "";
            const expected = crypto
              .createHmac("sha256", token)
              .update(nonce)
              .digest("hex");
            const a = Buffer.from(proof);
            const b = Buffer.from(expected);
            // timingSafeEqual throws on mismatched lengths.
            if (a.length !== b.length) {
              resolve(false);
              return;
            }
            resolve(crypto.timingSafeEqual(a, b));
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
 * Resolve a node binary: CODER_NODE_BIN, PATH lookup, nvm newest, homebrew.
 * PATH lookup uses providers.defaultWhich so win32 gets `where`, not `which`.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
function resolveNodeBinary(env = process.env, platform = process.platform) {
  if (env.CODER_NODE_BIN) {
    const p = String(env.CODER_NODE_BIN).trim();
    if (p && fs.existsSync(p)) return p;
    // Explicit override that does not exist: fail (do not fall through).
    if (p) return null;
  }

  const out = defaultWhich("node", env, platform);
  if (out && fs.existsSync(out)) return out;

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
 * MCP servers document for Claude `--mcp-config`. The global file is
 * unbound (concurrent runs share it). Per-run copies bind coder-memory
 * with `?project=` so the server owns the scope (issue #710).
 * @param {string} [projectPath]
 */
function mcpServersDoc(projectPath, opts = {}) {
  /** @type {Record<string, unknown>} */
  const mcpServers = {};
  const names = Array.isArray(opts.names) ? new Set(opts.names) : null;
  for (const s of activeServers()) {
    if (names && !names.has(s.name)) continue;
    if (isStdioServer(s)) {
      const entry = {
        type: "stdio",
        command: s.command,
        args: Array.isArray(s.args) ? s.args : [],
        env: s.env && typeof s.env === "object" ? { ...s.env } : {},
      };
      if (typeof s.cwd === "string" && s.cwd) entry.cwd = s.cwd;
      if (s.env && Object.keys(s.env).length) {
        try {
          recordSecretUse({ purpose: "mcp-inject", key: `mcp:${s.name}` });
        } catch {
          // Audit must never block writing the CLI config.
        }
      }
      mcpServers[s.name] = entry;
      continue;
    }
    const entry = {
      type: s.transport === "sse" ? "sse" : "http",
      url: boundCoderMemoryUrl(s.url, s.name, projectPath),
      headers: { ...(s.headers && typeof s.headers === "object" ? s.headers : {}) },
    };
    if (s.token) {
      entry.headers.Authorization = `Bearer ${s.token}`;
      try {
        recordSecretUse({ purpose: "mcp-inject", key: `mcp:${s.name}` });
      } catch {
        // Audit must never block writing the CLI config.
      }
    }
    mcpServers[s.name] = entry;
  }
  return { mcpServers };
}

/**
 * Write mcp-coder-memory.json for the current set of active servers.
 * The file name is historical; it lists every server we inject into claude.
 * Unbound on purpose: concurrent Claude runs share this file.
 * @param {string} userDataPath
 */
function writeMcpConfig(userDataPath) {
  globalUserDataPath = userDataPath;
  const mcpPath = path.join(userDataPath, MCP_CONFIG_NAME);
  writeSecretFile(mcpPath, JSON.stringify(mcpServersDoc(), null, 2));
  globalMcpConfigPath = mcpPath;
  return mcpPath;
}

/**
 * Per-project bound copy so two Claude runs on different repos cannot
 * clobber each other's `?project=` (issue #710).
 * @param {string} userDataPath
 * @param {string} projectPath
 */
function writeBoundMcpConfig(userDataPath, projectPath, opts = {}) {
  const key = crypto
    .createHash("sha1")
    .update(String(projectPath))
    .digest("hex")
    .slice(0, 12);
  const dir = path.join(userDataPath, "mcp-bound");
  fs.mkdirSync(dir, { recursive: true });
  const suffix = opts.memoryOnly === true ? "-memory" : "";
  const mcpPath = path.join(dir, `${key}${suffix}.json`);
  const docOpts = opts.memoryOnly === true ? { names: ["coder-memory"] } : {};
  writeSecretFile(
    mcpPath,
    JSON.stringify(mcpServersDoc(projectPath, docOpts), null, 2),
  );
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
  globalToken = opts.token || null;
  globalUserDataPath = opts.userDataPath || null;
  writeMcpConfig(opts.userDataPath);
  // Merge coder-memory into kimi's mcp.json when kimi is installed (best-effort).
  ensureKimiMcpConfig({
    log: opts.log,
    env: opts.env,
  });
  // Register coder-memory in grok's user MCP config when grok is installed.
  ensureGrokMcpConfig({
    log: opts.log,
    env: opts.env,
  });
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
    globalToken = null;
    ownedChild = null;

    // (a) Read the config when present. A MISSING config is the normal first
    // run: the server itself creates it, so we fall through to spawn.
    // An existing-but-corrupt config degrades: the server would refuse to
    // start on it anyway, so spawning would just loop.
    /** @type {{ port: number, token: string } | null} */
    let cfg = null;
    if (fs.existsSync(configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const port = Number(parsed.port);
        const token = typeof parsed.token === "string" ? parsed.token : "";
        if (!port || !Number.isFinite(port)) {
          log("memory-server: invalid port in config; continuing without memory");
          return;
        }
        cfg = { port, token };
      } catch (err) {
        log(
          "memory-server: invalid config JSON; continuing without memory: " +
            (err && err.message ? err.message : String(err)),
        );
        return;
      }
    }

    // (b) Adopt only a listener that proves it knows our token.
    // A config with no token is unverifiable — do not adopt.
    if (cfg && typeof cfg.token === "string" && cfg.token.length > 0) {
      if (await probeHealth(cfg.port, HEALTH_TIMEOUT_MS, cfg.token)) {
        markHealthy({
          port: cfg.port,
          token: cfg.token,
          userDataPath,
          adopted: true,
          log,
          env,
        });
        log(`memory-server: adopted existing server on port ${cfg.port}`);
        return;
      }
      // Listener answered /health but could not prove the shared secret.
      if (await probeHealth(cfg.port, HEALTH_TIMEOUT_MS)) {
        log(
          `memory-server: unverified listener on port ${cfg.port} (not ours); spawning our own`,
        );
      }
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
        // detached:false only shares our process group; it does NOT kill the
        // child if we crash. The server watches its own ppid for that
        // (memory-server/src/orphan.js).
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
            globalToken = null;
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

    // Port may move: the server rewrites memory-server.json on EADDRINUSE.
    // Re-read the file each tick and prove the current port knows our token.
    // Inlined (not a shared waitForHealth) because the port is not stable.
    const deadline = Date.now() + SPAWN_WAIT_MS * 2;
    let sawConfig = Boolean(cfg);
    while (Date.now() < deadline) {
      if (fs.existsSync(configPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
          const port = Number(parsed.port);
          const token = typeof parsed.token === "string" ? parsed.token : "";
          if (port && Number.isFinite(port)) {
            sawConfig = true;
            cfg = { port, token };
          }
        } catch {
          // partially written; keep polling
        }
      }
      if (
        cfg &&
        cfg.token &&
        (await probeHealth(
          cfg.port,
          Math.min(HEALTH_TIMEOUT_MS, 400),
          cfg.token,
        ))
      ) {
        markHealthy({
          port: cfg.port,
          token: cfg.token,
          userDataPath,
          adopted: false,
          log,
          env,
        });
        log(`memory-server: spawned and healthy on port ${cfg.port}`);
        return;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }

    if (!sawConfig) {
      log(
        "memory-server: config never appeared within " +
          SPAWN_WAIT_MS +
          "ms; continuing without memory",
      );
    } else {
      log(
        "memory-server: health never came up within " +
          SPAWN_WAIT_MS +
          "ms; continuing without memory",
      );
    }
    killOwnedChild();
  }

  /** Kill a hung spawn attempt if still around. */
  function killOwnedChild() {
    if (ownedChild) {
      try {
        ownedChild.kill("SIGTERM");
      } catch {
        // ignore
      }
      ownedChild = null;
    }
  }

  /**
   * Terminate only a child we spawned (not an adopted server).
   */
  function stop() {
    // Revoke the registrations that live in the user's home before we drop the
    // servers: their tokens are useless once we exit, but kimi/grok would keep
    // offering them to every session on the machine forever (issue #125). An
    // adopted server belongs to another instance, which is still serving it.
    if (!globalStatus.adopted) {
      forgetExternalMcp(
        activeServers().map((s) => s.name),
        { log, env },
      );
    }
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
      globalToken = null;
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
  getCodexMcpArgs,
  tomlEscape,
  getCodexMcpEnv,
  getGrokMcpEnv,
  mergeGrokSpawnEnv,
  ensureKimiMcpConfig,
  kimiMcpServersForRun,
  withQuery,
  boundCoderMemoryUrl,
  boundSolentaMcpUrl,
  ensureGrokMcpConfig,
  removeKimiMcpEntries,
  removeGrokMcpEntries,
  forgetExternalMcp,
  registerMcpServer,
  unregisterMcpServer,
  syncUserMcpServers,
  activeServers,
  resolveKimiMcpPath,
  resolveGrokConfigPath,
  grokTomlLooksValid,
  looksGrokConfigCorrupt,
  grokConfigCorruptMessage,
  whenGrokMcpIdle,
  getMemoryStatus,
  resetMemorySupForTests,
  resolveNodeBinary,
  probeHealth,
  CONFIG_NAME,
  MCP_CONFIG_NAME,
  GROK_MCP_TIMEOUT_MS,
};
