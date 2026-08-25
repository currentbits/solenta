"use strict";

/** User MCP server names: lowercase slug, same rule as skill names. */
const MCP_SERVER_NAME_RE = /^[a-z0-9-]+$/;
const MCP_NAME_MAX = 64;
const MCP_URL_MAX = 2048;
const MCP_TOKEN_MAX = 8 * 1024;
const MCP_HEADER_VALUE_MAX = 8 * 1024;
const MCP_HEADER_MAX = 32;
const MCP_COMMAND_MAX = 1024;
const MCP_ARGS_MAX = 128;
const MCP_ARG_MAX = 8 * 1024;
const MCP_ENV_MAX = 64;
const MCP_ENV_VALUE_MAX = 32 * 1024;
const MCP_CWD_MAX = 4096;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const BLOCKED_ENV_KEYS = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
]);

/** Built-in servers owned by the app; user entries may never use these. */
const RESERVED_MCP_NAMES = new Set(["coder-memory", "coder-threads"]);

const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
const POSIX_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BAD_CHARS_RE = /[\0\r\n]/;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} u
 * @returns {boolean}
 */
function isHttpUrl(u) {
  if (typeof u !== "string" || !u) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {boolean} strict
 * @returns {boolean}
 */
function checkHttpUrl(url, strict) {
  if (typeof url !== "string" || !url) {
    if (strict) throw new Error(`MCP server URL must be http(s) (got "${url}")`);
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      if (strict) throw new Error(`MCP server URL must be http(s) (got "${url}")`);
      return false;
    }
    if (parsed.username || parsed.password) {
      if (strict) {
        throw new Error("MCP server URL must not contain embedded credentials");
      }
      return false;
    }
    return true;
  } catch (err) {
    if (strict && err && /credential/i.test(String(err.message))) throw err;
    if (strict) throw new Error(`MCP server URL must be http(s) (got "${url}")`);
    return false;
  }
}

/**
 * @param {unknown} name
 * @returns {string}
 */
function trimName(name) {
  return typeof name === "string" ? name.trim() : "";
}

/**
 * @param {string} name
 * @param {boolean} strict
 */
function checkName(name, strict) {
  if (!MCP_SERVER_NAME_RE.test(name)) {
    if (strict) {
      throw new Error(
        `MCP server name must be lowercase letters, digits, dashes (got "${name}")`,
      );
    }
    return false;
  }
  if (name.length > MCP_NAME_MAX) {
    if (strict) {
      throw new Error(`MCP server name must be at most ${MCP_NAME_MAX} characters`);
    }
    return false;
  }
  if (RESERVED_MCP_NAMES.has(name)) {
    if (strict) {
      throw new Error(
        `MCP server name "${name}" is reserved for a built-in server`,
      );
    }
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} max
 * @param {boolean} strict
 * @returns {boolean}
 */
function isAbsolutePath(p) {
  return (
    typeof p === "string" &&
    (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\"))
  );
}

function isBlockedEnvKey(key) {
  const u = String(key).toUpperCase();
  if (BLOCKED_ENV_KEYS.has(u)) return true;
  return u.startsWith("LD_") || u.startsWith("DYLD_") || u.startsWith("ELECTRON_");
}

function rejectBadChars(value, label, max, strict) {
  if (typeof value !== "string") {
    if (strict) throw new Error(`${label} must be a string`);
    return false;
  }
  if (BAD_CHARS_RE.test(value)) {
    if (strict) throw new Error(`${label} must not contain CR, LF, or NUL`);
    return false;
  }
  if (value.length > max) {
    if (strict) throw new Error(`${label} must be at most ${max} characters`);
    return false;
  }
  return true;
}

/**
 * @param {unknown} raw
 * @param {boolean} strict
 * @returns {Record<string, string> | undefined}
 */
function parseHeaders(raw, strict) {
  if (raw == null) return undefined;
  if (!isPlainObject(raw)) {
    if (strict) throw new Error("MCP server headers must be a plain object");
    return undefined;
  }
  const keys = Object.keys(raw);
  if (keys.some((k) => PROTOTYPE_KEYS.has(k))) {
    if (strict) {
      throw new Error("MCP server headers must not include prototype keys");
    }
    return undefined;
  }
  if (keys.length > MCP_HEADER_MAX) {
    if (strict) {
      throw new Error(`MCP server headers must have at most ${MCP_HEADER_MAX} entries`);
    }
    return undefined;
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!HTTP_HEADER_NAME_RE.test(k)) {
      if (strict) throw new Error(`MCP server header name is invalid: ${k}`);
      continue;
    }
    if (typeof v !== "string") {
      if (strict) throw new Error("MCP server header values must be strings");
      continue;
    }
    if (!rejectBadChars(v, "MCP server header value", MCP_HEADER_VALUE_MAX, strict)) {
      continue;
    }
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {unknown} raw
 * @param {boolean} strict
 * @returns {Record<string, string> | undefined}
 */
function parseEnv(raw, strict) {
  if (raw == null) return undefined;
  if (!isPlainObject(raw)) {
    if (strict) throw new Error("MCP server env must be a plain object");
    return undefined;
  }
  const keys = Object.keys(raw);
  if (keys.some((k) => PROTOTYPE_KEYS.has(k))) {
    if (strict) {
      throw new Error("MCP server env must not include prototype keys");
    }
    return undefined;
  }
  if (keys.some((k) => isBlockedEnvKey(k))) {
    if (strict) {
      throw new Error("MCP server env includes a process-control key");
    }
    return undefined;
  }
  if (keys.length > MCP_ENV_MAX) {
    if (strict) {
      throw new Error(`MCP server env must have at most ${MCP_ENV_MAX} entries`);
    }
    return undefined;
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!POSIX_ENV_NAME_RE.test(k)) {
      if (strict) throw new Error(`MCP server env key is invalid: ${k}`);
      continue;
    }
    if (typeof v !== "string") {
      if (strict) throw new Error("MCP server env values must be strings");
      continue;
    }
    if (!rejectBadChars(v, "MCP server env value", MCP_ENV_VALUE_MAX, strict)) {
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * @param {unknown} raw
 * @param {boolean} strict
 * @returns {string[] | null}
 */
function parseArgs(raw, strict) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    if (strict) throw new Error("MCP server args must be an array");
    return null;
  }
  if (raw.length > MCP_ARGS_MAX) {
    if (strict) {
      throw new Error(`MCP server args must have at most ${MCP_ARGS_MAX} entries`);
    }
    return null;
  }
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      if (strict) throw new Error("MCP server args must be strings");
      return null;
    }
    if (BAD_CHARS_RE.test(item)) {
      if (strict) throw new Error("MCP server args must not contain CR, LF, or NUL");
      return null;
    }
    if (item.length > MCP_ARG_MAX) {
      if (strict) {
        throw new Error(`MCP server arg must be at most ${MCP_ARG_MAX} characters`);
      }
      return null;
    }
    out.push(item);
  }
  return out;
}

/**
 * @param {unknown} item
 * @returns {"http" | "sse" | "stdio" | ""}
 */
function inferTransport(item) {
  if (!item || typeof item !== "object") return "";
  const t = item.transport;
  if (t === "http" || t === "sse" || t === "stdio") return t;
  if (t != null && t !== "") return "";
  if (typeof item.command === "string" && item.command && !item.url) {
    return "stdio";
  }
  if (typeof item.url === "string" && item.url) return "http";
  return "";
}

/**
 * @param {unknown} item
 * @param {boolean} strict
 * @returns {object | null}
 */
function parseOne(item, strict) {
  if (!isPlainObject(item)) {
    if (strict) throw new Error("MCP server entry must be a plain object");
    return null;
  }
  const name = trimName(item.name);
  if (!checkName(name, strict)) return null;

  const provenance =
    item.provenance === "added" || item.provenance === "curated"
      ? item.provenance
      : undefined;
  const catalogId =
    typeof item.catalogId === "string" && item.catalogId.trim()
      ? item.catalogId.trim()
      : undefined;
  const enabled = item.enabled !== false;
  const transport = inferTransport(item);

  if (transport === "stdio") {
    const command = typeof item.command === "string" ? item.command : "";
    if (
      !rejectBadChars(command, "MCP server command", MCP_COMMAND_MAX, strict) ||
      !command
    ) {
      if (strict && !command) throw new Error("MCP server command is required");
      return null;
    }
    const args = parseArgs(item.args, strict);
    if (!args) return null;
    const env = parseEnv(item.env, strict);
    let cwd;
    if (item.cwd != null && item.cwd !== "") {
      if (typeof item.cwd !== "string") {
        if (strict) throw new Error("MCP server cwd must be a string");
        return null;
      }
      if (CONTROL_CHARS_RE.test(item.cwd)) {
        if (strict) {
          throw new Error("MCP server cwd must not contain CR, LF, NUL, or control characters");
        }
        return null;
      }
      if (!rejectBadChars(item.cwd, "MCP server cwd", MCP_CWD_MAX, strict)) {
        return null;
      }
      if (!isAbsolutePath(item.cwd)) {
        if (strict) throw new Error("MCP server cwd must be an absolute path");
        return null;
      }
      cwd = item.cwd;
    }
    const trusted = item.trusted === true;
    if (enabled && trusted !== true) {
      if (strict) {
        throw new Error("MCP stdio server must be trusted to enable");
      }
      return null;
    }
    const entry = {
      name,
      transport: "stdio",
      command,
      args,
      env: env || {},
      enabled,
      trusted,
    };
    if (cwd) entry.cwd = cwd;
    if (provenance) entry.provenance = provenance;
    if (catalogId) entry.catalogId = catalogId;
    return entry;
  }

  if (transport !== "http" && transport !== "sse") {
    if (strict) {
      throw new Error('MCP server transport must be "http", "sse", or "stdio"');
    }
    return null;
  }

  const urlRaw = typeof item.url === "string" ? item.url.trim() : "";
  if (CONTROL_CHARS_RE.test(urlRaw)) {
    if (strict) throw new Error("MCP server URL must not contain control characters");
    return null;
  }
  if (!checkHttpUrl(urlRaw, strict)) {
    return null;
  }
  if (urlRaw.length > MCP_URL_MAX) {
    if (strict) {
      throw new Error(`MCP server URL must be at most ${MCP_URL_MAX} characters`);
    }
    return null;
  }
  let url = urlRaw;
  try {
    url = new URL(urlRaw).href;
  } catch {
    if (strict) throw new Error(`MCP server URL must be http(s) (got "${urlRaw}")`);
    return null;
  }
  if (url.length > MCP_URL_MAX) {
    if (strict) {
      throw new Error(`MCP server URL must be at most ${MCP_URL_MAX} characters`);
    }
    return null;
  }

  const headers = parseHeaders(item.headers, strict);
  const entry = {
    name,
    transport,
    url,
    enabled,
  };
  if (item.token !== undefined && item.token !== null) {
    if (typeof item.token !== "string") {
      if (strict) throw new Error("MCP server token must be a string");
    } else if (
      rejectBadChars(item.token, "MCP server token", MCP_TOKEN_MAX, strict) &&
      item.token
    ) {
      entry.token = item.token;
    } else if (strict && item.token) {
      return null;
    }
  }
  entry.headers = headers || {};
  if (provenance) entry.provenance = provenance;
  if (catalogId) entry.catalogId = catalogId;
  return entry;
}

/**
 * Lenient normalization for values read from disk: drops invalid entries,
 * coerces enabled (default true), dedupes by name. Never throws.
 * @param {unknown} raw
 */
/**
 * Enabled stdio servers may not disagree on the same env key.
 * Strict throws; lenient drops the later conflicting entry.
 * @param {object[]} servers
 * @param {boolean} strict
 */
function applyEnvAgreement(servers, strict) {
  /** @type {Map<string, string>} */
  const agreed = new Map();
  const out = [];
  for (const entry of servers) {
    if (entry.transport !== "stdio" || entry.enabled === false) {
      out.push(entry);
      continue;
    }
    const env =
      entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
        ? entry.env
        : {};
    let conflict = null;
    for (const [k, v] of Object.entries(env)) {
      if (agreed.has(k) && agreed.get(k) !== v) {
        conflict = k;
        break;
      }
    }
    if (conflict) {
      if (strict) {
        throw new Error(`Conflicting MCP env key: ${conflict}`);
      }
      continue;
    }
    for (const [k, v] of Object.entries(env)) agreed.set(k, v);
    out.push(entry);
  }
  return out;
}

function normalizeMcpServers(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const entry = parseOne(item, false);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return applyEnvAgreement(out, false);
}

/**
 * Strict validation for settings:set / mcp.save. Throws on the first problem.
 * @param {unknown} raw
 */
function validateMcpServers(raw) {
  if (!Array.isArray(raw)) {
    throw new Error("mcpServers must be an array");
  }
  const seen = new Set();
  const parsed = raw.map((item) => {
    const entry = parseOne(item, true);
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate MCP server name: ${entry.name}`);
    }
    seen.add(entry.name);
    return entry;
  });
  return applyEnvAgreement(parsed, true);
}

/**
 * @param {object} stored
 */
function redactMcpServer(stored) {
  if (!stored || typeof stored !== "object") return stored;
  const provenance =
    stored.provenance === "added" || stored.provenance === "curated"
      ? stored.provenance
      : undefined;
  const catalogId =
    typeof stored.catalogId === "string" && stored.catalogId
      ? stored.catalogId
      : undefined;
  if (stored.transport === "stdio") {
    const env =
      stored.env && typeof stored.env === "object" && !Array.isArray(stored.env)
        ? stored.env
        : {};
    const row = {
      name: stored.name,
      transport: "stdio",
      command: stored.command,
      args: Array.isArray(stored.args) ? [...stored.args] : [],
      envNames: Object.keys(env),
      hasSecrets: Object.keys(env).length > 0,
      enabled: stored.enabled !== false,
      trusted: stored.trusted === true,
    };
    if (typeof stored.cwd === "string" && stored.cwd) row.cwd = stored.cwd;
    if (provenance) row.provenance = provenance;
    if (catalogId) row.catalogId = catalogId;
    return row;
  }
  const headers =
    stored.headers &&
    typeof stored.headers === "object" &&
    !Array.isArray(stored.headers)
      ? stored.headers
      : {};
  const row = {
    name: stored.name,
    transport: stored.transport === "sse" ? "sse" : "http",
    url: stored.url,
    headerNames: Object.keys(headers),
    hasToken: Boolean(stored.token),
    enabled: stored.enabled !== false,
  };
  if (provenance) row.provenance = provenance;
  if (catalogId) row.catalogId = catalogId;
  return row;
}

/**
 * @param {unknown} list
 */
function redactMcpServers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => redactMcpServer(s));
}

/**
 * @param {Record<string, string> | undefined} existing
 * @param {unknown} incoming
 * @param {boolean} present
 * @returns {Record<string, string> | undefined}
 */
function mergeSecretMap(existing, incoming, present) {
  if (!present) {
    return existing && Object.keys(existing).length ? { ...existing } : undefined;
  }
  if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
    return undefined;
  }
  const next = { ...(existing || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === "" || v == null) delete next[k];
    else if (typeof v === "string") next[k] = v;
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * Whole-definition upsert. Omitted secret fields keep existing secrets;
 * explicit empty token/header/env values remove them. Changing transport
 * drops secrets from the old transport. Enabling a local server requires
 * trusted === true.
 * @param {unknown} list
 * @param {unknown} input
 */
function upsertMcpServer(list, input) {
  if (!input || typeof input !== "object") {
    throw new Error("MCP server input must be an object");
  }
  const current = Array.isArray(list) ? list : [];
  const name = trimName(input.name);
  const existing = current.find((s) => s && s.name === name) || null;
  const transport = inferTransport(input) || (existing && existing.transport) || "";
  const switched = Boolean(existing && existing.transport !== transport);

  /** @type {Record<string, unknown>} */
  const merged = { ...input, name, transport };

  if (transport === "stdio") {
    if (switched) {
      delete merged.token;
      delete merged.headers;
      delete merged.url;
    } else if (existing && existing.transport === "stdio") {
      if (!Object.prototype.hasOwnProperty.call(input, "env")) {
        if (existing.env) merged.env = { ...existing.env };
      } else {
        merged.env = mergeSecretMap(
          existing.env,
          input.env,
          true,
        );
      }
      if (
        !Object.prototype.hasOwnProperty.call(input, "args") &&
        Array.isArray(existing.args)
      ) {
        merged.args = [...existing.args];
      }
      if (
        !Object.prototype.hasOwnProperty.call(input, "command") &&
        existing.command
      ) {
        merged.command = existing.command;
      }
      if (
        !Object.prototype.hasOwnProperty.call(input, "cwd") &&
        existing.cwd
      ) {
        merged.cwd = existing.cwd;
      }
      if (
        !Object.prototype.hasOwnProperty.call(input, "trusted") &&
        existing.trusted === true
      ) {
        merged.trusted = true;
      }
    }
    const enabled = merged.enabled !== false;
    const trusted = merged.trusted === true;
    if (enabled && trusted !== true) {
      throw new Error("Local MCP server must be trusted to enable");
    }
  } else {
    if (switched) {
      delete merged.env;
      delete merged.command;
      delete merged.args;
      delete merged.cwd;
      delete merged.trusted;
    } else if (existing && existing.transport !== "stdio") {
      if (!Object.prototype.hasOwnProperty.call(input, "token")) {
        if (existing.token) merged.token = existing.token;
      } else if (input.token === "") {
        delete merged.token;
      }
      if (!Object.prototype.hasOwnProperty.call(input, "headers")) {
        if (existing.headers) merged.headers = { ...existing.headers };
      } else {
        merged.headers = mergeSecretMap(existing.headers, input.headers, true);
      }
    } else if (Object.prototype.hasOwnProperty.call(input, "token") && input.token === "") {
      delete merged.token;
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "headers") &&
      input.headers &&
      typeof input.headers === "object"
    ) {
      merged.headers = mergeSecretMap(
        switched ? undefined : existing && existing.headers,
        input.headers,
        true,
      );
    }
  }

  const parsed = parseOne(merged, true);
  const next = current.filter((s) => !s || s.name !== name);
  next.push(parsed);
  return validateMcpServers(next);
}

/**
 * Strip renderer-injected runner/hook/sync fields from an MCP write.
 * @param {unknown} input
 */
function isRedactedPublic(item) {
  return Boolean(
    item &&
      typeof item === "object" &&
      (Object.prototype.hasOwnProperty.call(item, "headerNames") ||
        Object.prototype.hasOwnProperty.call(item, "hasToken") ||
        Object.prototype.hasOwnProperty.call(item, "envNames") ||
        Object.prototype.hasOwnProperty.call(item, "hasSecrets")),
  );
}

/**
 * Merge a settings.mcpServers patch: omitted or redacted secret fields
 * keep same-name/same-transport secrets. Removals and transport switches
 * drop the old secrets.
 * @param {unknown} current
 * @param {unknown} incoming
 */
function mergeMcpSettingsPatch(current, incoming) {
  if (!Array.isArray(incoming)) {
    throw new Error("mcpServers must be an array");
  }
  const curr = Array.isArray(current) ? current : [];
  const out = [];
  for (const item of incoming) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      out.push(item);
      continue;
    }
    const name = trimName(/** @type {{ name?: unknown }} */ (item).name);
    const existing = curr.find((s) => s && s.name === name);
    const cleaned = sanitizeMcpInput(item);
    if (isRedactedPublic(item)) {
      delete cleaned.token;
      delete cleaned.headers;
      delete cleaned.env;
    }
    const merged = upsertMcpServer(existing ? [existing] : [], cleaned);
    const row = merged.find((s) => s.name === name);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Public settings clone: mcpServers redacted, other fields copied.
 * @param {object} settings
 */
function redactSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  return {
    ...settings,
    mcpServers: redactMcpServers(settings.mcpServers),
  };
}

function sanitizeMcpInput(input) {
  if (!input || typeof input !== "object") return {};
  const src = /** @type {Record<string, unknown>} */ (input);
  /** @type {Record<string, unknown>} */
  const out = {};
  const keep = [
    "name",
    "transport",
    "url",
    "headers",
    "token",
    "enabled",
    "command",
    "args",
    "env",
    "cwd",
    "trusted",
    "provenance",
    "catalogId",
  ];
  for (const key of keep) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  return out;
}

function slugMcpName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MCP_NAME_MAX);
}

function notesInstallScripts(obj, warnings) {
  if (!isPlainObject(obj) || !isPlainObject(obj.scripts)) return;
  const scripts = obj.scripts;
  if (scripts.install || scripts.preinstall || scripts.postinstall) {
    warnings.push("Package install scripts were not executed");
  }
}

function collectConfigEntries(obj, warnings) {
  /** @type {Array<{ name: string, def: object }>} */
  const entries = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (!isPlainObject(item)) continue;
      const name = trimName(item.name) || slugMcpName(item.command || item.url);
      entries.push({ name, def: item });
    }
    return entries;
  }
  if (!isPlainObject(obj)) return entries;
  notesInstallScripts(obj, warnings);
  if (isPlainObject(obj.mcpServers)) {
    for (const [name, def] of Object.entries(obj.mcpServers)) {
      if (isPlainObject(def)) entries.push({ name, def });
    }
    return entries;
  }
  if (isPlainObject(obj.mcp) && isPlainObject(obj.mcp.servers)) {
    for (const [name, def] of Object.entries(obj.mcp.servers)) {
      if (isPlainObject(def)) entries.push({ name, def });
    }
    return entries;
  }
  if (isPlainObject(obj.servers)) {
    for (const [name, def] of Object.entries(obj.servers)) {
      if (isPlainObject(def) && (def.url || def.command || def.type)) {
        entries.push({ name, def });
      }
    }
    if (entries.length) return entries;
  }
  if (obj.name || obj.url || obj.command) {
    entries.push({ name: trimName(obj.name), def: obj });
  }
  return entries;
}

const TEMPLATE_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

function extractTemplateSecrets(values, prefix) {
  /** @type {Array<{ id: string, label: string }>} */
  const out = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(values || {})) {
    if (typeof value !== "string") continue;
    TEMPLATE_RE.lastIndex = 0;
    let m;
    while ((m = TEMPLATE_RE.exec(value))) {
      const label = m[1];
      const id = `${prefix}:${key}:${label}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label });
    }
  }
  return out;
}

function copyStringMap(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === "string" && k && typeof v === "string") out[k] = v;
  }
  return out;
}

function buildFromConfigDef(name, def, warnings) {
  const slug = slugMcpName(name);
  if (!slug) {
    warnings.push(`Skipped invalid MCP server name "${name}"`);
    return null;
  }
  if (RESERVED_MCP_NAMES.has(slug)) {
    warnings.push(`"${slug}" is reserved for a built-in server`);
    return null;
  }
  const type = typeof def.type === "string" ? def.type.trim().toLowerCase() : "";
  const hasCommand = typeof def.command === "string" && def.command.trim();
  const hasUrl = typeof def.url === "string" && def.url.trim();
  /** @type {"http" | "sse" | "stdio" | ""} */
  let transport = "";
  if (type === "http" || type === "sse" || type === "stdio") transport = type;
  else if (hasCommand && !hasUrl) transport = "stdio";
  else if (hasUrl) transport = "http";
  if (!transport) {
    warnings.push(`${slug}: missing command or URL`);
    return null;
  }

  /** @type {string[]} */
  const warningBits = [];
  if (transport === "stdio") {
    const env = copyStringMap(def.env);
    const envNames = Object.keys(env);
    const requiredSecrets = extractTemplateSecrets(env, `${slug}:env`);
    const stored = {
      name: slug,
      transport: "stdio",
      command: def.command,
      args: Array.isArray(def.args) ? def.args : [],
      env,
      enabled: false,
      trusted: false,
    };
    if (typeof def.cwd === "string" && def.cwd) stored.cwd = def.cwd;
    return {
      stored,
      meta: {
        envNames,
        headerNames: [],
        hasToken: false,
        requiresTrust: true,
        requiredSecrets,
        warnings: warningBits,
      },
    };
  }

  const headers = copyStringMap(def.headers);
  const headerNames = Object.keys(headers);
  const hasToken = typeof def.token === "string" && def.token.length > 0;
  const requiredSecrets = extractTemplateSecrets(headers, `${slug}:header`);
  const stored = {
    name: slug,
    transport,
    url: def.url,
    enabled: true,
    headers,
  };
  return {
    stored,
    meta: {
      envNames: [],
      headerNames,
      hasToken,
      requiresTrust: false,
      requiredSecrets,
      warnings: warningBits,
    },
  };
}

/**
 * Parse a Claude/Cursor/VS Code MCP config (object or JSON text).
 * Secret values are dropped; names are kept. Never executes scripts.
 * @param {unknown} input
 * @returns {{
 *   servers: Array<{
 *     stored: object,
 *     meta: {
 *       envNames: string[],
 *       headerNames: string[],
 *       hasToken: boolean,
 *       requiresTrust: boolean,
 *       warnings: string[],
 *     },
 *   }>,
 *   warnings: string[],
 * }}
 */
function parseMcpConfigDocument(input) {
  const warnings = [];
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      throw new Error("MCP config is not valid JSON");
    }
  }
  const entries = collectConfigEntries(obj, warnings);
  if (!entries.length) {
    const err = new Error("No MCP servers found in config");
    err.mcpWarnings = warnings;
    throw err;
  }
  const servers = [];
  const seen = new Set();
  for (const { name, def } of entries) {
    const built = buildFromConfigDef(name, def, warnings);
    if (!built) continue;
    try {
      const parsed = parseOne(built.stored, true);
      if (!parsed) continue;
      if (seen.has(parsed.name)) {
        warnings.push(`Duplicate name "${parsed.name}" skipped`);
        continue;
      }
      seen.add(parsed.name);
      servers.push({ stored: parsed, meta: built.meta });
    } catch (err) {
      warnings.push(
        `${slugMcpName(name) || name}: ${err && err.message ? err.message : err}`,
      );
    }
  }
  if (!servers.length) throw new Error("No MCP servers found in config");
  return { servers, warnings };
}

const IMPORT_JSON_MAX_BYTES = 512 * 1024;
const IMPORT_JSON_MAX_DEPTH = 8;
const SECRET_TEMPLATE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const IMPORT_SECRET_MAX = 64;
const IMPORT_SECRET_BYTES = 32 * 1024;

function secretDescriptorId(server, field, label) {
  const s = `${server}\0${field}\0${label}`;
  let h1 = 2166136261;
  let h2 = 2166136261 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 16777619);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

function extractTemplateLabels(value) {
  if (typeof value !== "string" || !value) return [];
  const out = [];
  const re = new RegExp(SECRET_TEMPLATE_RE.source, "g");
  let m;
  while ((m = re.exec(value))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function requiredSecretsFor(stored) {
  /** @type {Array<{ id: string, server: string, field: string, label: string }>} */
  const out = [];
  const server = stored.name;
  const push = (field, value) => {
    for (const label of extractTemplateLabels(value)) {
      out.push({
        id: secretDescriptorId(server, field, label),
        server,
        field,
        label,
      });
    }
  };
  if (typeof stored.token === "string") push("token", stored.token);
  if (stored.headers && typeof stored.headers === "object") {
    for (const [k, v] of Object.entries(stored.headers)) {
      push(`headers.${k}`, v);
    }
  }
  if (stored.env && typeof stored.env === "object") {
    for (const [k, v] of Object.entries(stored.env)) {
      push(`env.${k}`, v);
    }
  }
  return out;
}

function substituteTemplate(template, label, value) {
  return String(template ?? "").split("${" + label + "}").join(value);
}

function applyImportSecrets(stored, descriptors, secrets) {
  const next = JSON.parse(JSON.stringify(stored));
  for (const d of descriptors || []) {
    if (!secrets || typeof secrets[d.id] !== "string") {
      throw new Error(`Missing secret for ${d.label}`);
    }
    const value = secrets[d.id];
    if (d.field === "token") {
      next.token = substituteTemplate(next.token, d.label, value);
    } else if (d.field.startsWith("headers.")) {
      const name = d.field.slice("headers.".length);
      next.headers = {
        ...(next.headers || {}),
        [name]: substituteTemplate(next.headers && next.headers[name], d.label, value),
      };
    } else if (d.field.startsWith("env.")) {
      const name = d.field.slice("env.".length);
      next.env = {
        ...(next.env || {}),
        [name]: substituteTemplate(next.env && next.env[name], d.label, value),
      };
    }
  }
  return next;
}

function sanitizeImportSecrets(raw) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) throw new Error("secrets must be a plain object");
  const keys = Object.keys(raw);
  if (keys.length > IMPORT_SECRET_MAX) {
    throw new Error("Too many secrets (max 64)");
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new Error("Secret values must be strings");
    if (v.includes("\0")) throw new Error("Secret must not contain NUL");
    if (v.length > IMPORT_SECRET_BYTES) {
      throw new Error("Secret exceeds 32KiB");
    }
    out[k] = v;
  }
  return out;
}

function isPlausibleMcpDefinition(v) {
  if (!isPlainObject(v)) return false;
  if (typeof v.url === "string") return true;
  if (typeof v.command === "string") return true;
  const type = typeof v.type === "string" ? v.type.trim().toLowerCase() : "";
  const transport =
    typeof v.transport === "string" ? v.transport.trim().toLowerCase() : "";
  return (
    type === "http" ||
    type === "sse" ||
    type === "stdio" ||
    transport === "http" ||
    transport === "sse" ||
    transport === "stdio"
  );
}

function looksLikeNamedServer(obj) {
  return (
    isPlainObject(obj) &&
    typeof obj.name === "string" &&
    obj.name.trim() &&
    isPlausibleMcpDefinition(obj)
  );
}

function assertJsonDepth(value, max, depth) {
  if (depth > max) throw new Error("MCP config JSON is too deep");
  if (!value || typeof value !== "object") return;
  const vals = Array.isArray(value) ? value : Object.values(value);
  for (const child of vals) assertJsonDepth(child, max, depth + 1);
}

function entriesFromMap(map) {
  /** @type {Array<{ name: string, def: object }>} */
  const entries = [];
  const seen = new Set();
  for (const [name, def] of Object.entries(map)) {
    if (!isPlainObject(def)) {
      throw new Error("MCP config is not a plausible server map");
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate MCP server name "${name}"`);
    }
    seen.add(name);
    entries.push({ name, def });
  }
  return entries;
}

function collectImportEntries(obj) {
  if (!isPlainObject(obj)) {
    throw new Error("MCP config must be a JSON object");
  }
  /** @type {string[]} */
  const wrappers = [];
  /** @type {object | null} */
  let wrapperMap = null;
  if (isPlainObject(obj.mcpServers)) {
    wrappers.push("mcpServers");
    wrapperMap = obj.mcpServers;
  }
  if (isPlainObject(obj.servers)) {
    wrappers.push("servers");
    if (!wrapperMap) wrapperMap = obj.servers;
  }
  if (isPlainObject(obj.mcp) && isPlainObject(obj.mcp.servers)) {
    wrappers.push("mcp.servers");
    if (!wrapperMap) wrapperMap = obj.mcp.servers;
  }
  /** @type {string[]} */
  const extraPlausible = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "mcpServers" || key === "servers" || key === "mcp") continue;
    if (isPlausibleMcpDefinition(value)) extraPlausible.push(key);
  }
  if (wrappers.length > 1) {
    throw new Error("Ambiguous MCP config: mixed document shapes");
  }
  if (wrappers.length === 1 && (extraPlausible.length || looksLikeNamedServer(obj))) {
    throw new Error("Ambiguous MCP config: mixed document shapes");
  }
  if (wrappers.length === 1 && wrapperMap) {
    return entriesFromMap(wrapperMap);
  }
  if (looksLikeNamedServer(obj) && extraPlausible.length === 0) {
    return [{ name: String(obj.name).trim(), def: obj }];
  }
  const keys = Object.keys(obj);
  if (keys.length && keys.every((k) => isPlausibleMcpDefinition(obj[k]))) {
    return entriesFromMap(obj);
  }
  throw new Error("MCP config is not a plausible server map");
}

function importDefToItem(name, def) {
  if (!isPlainObject(def)) {
    throw new Error("MCP server entry must be a plain object");
  }
  const type = typeof def.type === "string" ? def.type.trim().toLowerCase() : "";
  const transport =
    def.transport === "http" || def.transport === "sse" || def.transport === "stdio"
      ? def.transport
      : type === "http" || type === "sse" || type === "stdio"
        ? type
        : undefined;
  const item = {
    name,
    transport,
    url: def.url,
    headers: def.headers,
    token: def.token,
    command: def.command,
    args: def.args,
    env: def.env,
    cwd: def.cwd,
    trusted: false,
  };
  const inferred = inferTransport(item);
  const resolved = inferred || transport || "";
  item.transport = resolved || item.transport;
  if (resolved === "stdio") {
    item.enabled = false;
    item.trusted = false;
  } else {
    item.enabled = def.enabled !== false;
  }
  return item;
}

/**
 * Strict MCP import parser. Rejects ambiguous, reserved, duplicate, oversized,
 * and too-deep documents. Keeps secret templates for main-process substitution.
 * @param {unknown} input
 */
function parseMcpImportDocument(input) {
  let obj = input;
  if (typeof input === "string") {
    if (input.length > IMPORT_JSON_MAX_BYTES) {
      throw new Error("MCP config JSON exceeds size limit");
    }
    try {
      obj = JSON.parse(input);
    } catch {
      throw new Error("MCP config is not valid JSON");
    }
  }
  assertJsonDepth(obj, IMPORT_JSON_MAX_DEPTH, 1);
  if (typeof input !== "string") {
    let encoded = "";
    try {
      encoded = JSON.stringify(obj);
    } catch {
      encoded = "";
    }
    if (encoded.length > IMPORT_JSON_MAX_BYTES) {
      throw new Error("MCP config JSON exceeds size limit");
    }
  }
  const warnings = [];
  if (isPlainObject(obj)) notesInstallScripts(obj, warnings);
  const entries = collectImportEntries(obj);
  if (!entries.length) throw new Error("No MCP servers found in config");
  const servers = [];
  const seen = new Set();
  for (const { name, def } of entries) {
    const trimmed = trimName(name);
    if (!trimmed) {
      throw new Error(`MCP server name must be lowercase letters, digits, dashes (got "${name}")`);
    }
    if (RESERVED_MCP_NAMES.has(trimmed)) {
      throw new Error(
        `MCP server name "${trimmed}" is reserved for a built-in server`,
      );
    }
    checkName(trimmed, true);
    if (seen.has(trimmed)) {
      throw new Error(`Duplicate MCP server name "${trimmed}"`);
    }
    seen.add(trimmed);
    const stored = parseOne(importDefToItem(trimmed, def), true);
    if (!stored) throw new Error(`Invalid MCP definition for "${trimmed}"`);
    servers.push({
      stored,
      requiredSecrets: requiredSecretsFor(stored),
      warnings: [...warnings],
    });
  }
  return { servers, warnings };
}

module.exports = {
  MCP_SERVER_NAME_RE,
  RESERVED_MCP_NAMES,
  MCP_NAME_MAX,
  isHttpUrl,
  normalizeMcpServers,
  validateMcpServers,
  redactMcpServer,
  redactMcpServers,
  upsertMcpServer,
  sanitizeMcpInput,
  mergeMcpSettingsPatch,
  redactSettings,
  parseMcpConfigDocument,
  parseMcpImportDocument,
  applyImportSecrets,
  sanitizeImportSecrets,
  requiredSecretsFor,
  slugMcpName,
};
