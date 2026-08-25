/**
 * Browser-safe MCP model: same validation, redaction, and secret-merge
 * rules as electron/mcp.js. DevCoder / FakeCoder must not require Electron.
 */

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
const RESERVED_MCP_NAMES = new Set(["coder-memory", "coder-threads"]);
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
const POSIX_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BAD_CHARS_RE = /[\0\r\n]/;

export type McpTransport = "http" | "sse" | "stdio";

export type StoredMcpServer = {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  url?: string;
  token?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  trusted?: boolean;
  provenance?: "added" | "curated";
  catalogId?: string;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isHttpUrl(u: unknown): boolean {
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

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

function isBlockedEnvKey(key: string): boolean {
  const u = String(key).toUpperCase();
  if (BLOCKED_ENV_KEYS.has(u)) return true;
  return u.startsWith("LD_") || u.startsWith("DYLD_") || u.startsWith("ELECTRON_");
}

function trimName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

function checkName(name: string, strict: boolean): boolean {
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

function rejectBadChars(
  value: unknown,
  label: string,
  max: number,
  strict: boolean,
): value is string {
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

function checkHttpUrl(url: string, strict: boolean): boolean {
  if (!url) {
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
    if (strict && err instanceof Error && /credential/i.test(err.message)) {
      throw err;
    }
    if (strict) throw new Error(`MCP server URL must be http(s) (got "${url}")`);
    return false;
  }
}

function parseHeaders(
  raw: unknown,
  strict: boolean,
): Record<string, string> | undefined {
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
  const out: Record<string, string> = {};
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

function parseEnv(
  raw: unknown,
  strict: boolean,
): Record<string, string> | undefined {
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
  const out: Record<string, string> = {};
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

function parseArgs(raw: unknown, strict: boolean): string[] | null {
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
  const out: string[] = [];
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

function inferTransport(item: Record<string, unknown>): McpTransport | "" {
  const t = item.transport;
  if (t === "http" || t === "sse" || t === "stdio") return t;
  if (t != null && t !== "") return "";
  if (typeof item.command === "string" && item.command && !item.url) return "stdio";
  if (typeof item.url === "string" && item.url) return "http";
  return "";
}

function parseOne(item: unknown, strict: boolean): StoredMcpServer | null {
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
    let cwd: string | undefined;
    if (item.cwd != null && item.cwd !== "") {
      if (typeof item.cwd !== "string") {
        if (strict) throw new Error("MCP server cwd must be a string");
        return null;
      }
      if (CONTROL_CHARS_RE.test(item.cwd)) {
        if (strict) {
          throw new Error(
            "MCP server cwd must not contain CR, LF, NUL, or control characters",
          );
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
    const entry: StoredMcpServer = {
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
  if (!checkHttpUrl(urlRaw, strict)) return null;
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
  const entry: StoredMcpServer = {
    name,
    transport,
    url,
    enabled,
    headers: headers || {},
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
  if (provenance) entry.provenance = provenance;
  if (catalogId) entry.catalogId = catalogId;
  return entry;
}

function applyEnvAgreement(
  servers: StoredMcpServer[],
  strict: boolean,
): StoredMcpServer[] {
  const agreed = new Map<string, string>();
  const out: StoredMcpServer[] = [];
  for (const entry of servers) {
    if (entry.transport !== "stdio" || entry.enabled === false) {
      out.push(entry);
      continue;
    }
    const env = entry.env && typeof entry.env === "object" ? entry.env : {};
    let conflict: string | null = null;
    for (const [k, v] of Object.entries(env)) {
      if (agreed.has(k) && agreed.get(k) !== v) {
        conflict = k;
        break;
      }
    }
    if (conflict) {
      if (strict) throw new Error(`Conflicting MCP env key: ${conflict}`);
      continue;
    }
    for (const [k, v] of Object.entries(env)) agreed.set(k, v);
    out.push(entry);
  }
  return out;
}

export function validateMcpServers(raw: unknown): StoredMcpServer[] {
  if (!Array.isArray(raw)) {
    throw new Error("mcpServers must be an array");
  }
  const seen = new Set<string>();
  const parsed = raw.map((item) => {
    const entry = parseOne(item, true);
    if (!entry) throw new Error("MCP server entry is invalid");
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate MCP server name: ${entry.name}`);
    }
    seen.add(entry.name);
    return entry;
  });
  return applyEnvAgreement(parsed, true);
}

export function normalizeMcpServers(raw: unknown): StoredMcpServer[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredMcpServer[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = parseOne(item, false);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return applyEnvAgreement(out, false);
}

export function redactMcpServer(stored: unknown): Record<string, unknown> {
  if (!stored || typeof stored !== "object") {
    return stored as Record<string, unknown>;
  }
  const s = stored as StoredMcpServer;
  const provenance =
    s.provenance === "added" || s.provenance === "curated" ? s.provenance : undefined;
  const catalogId =
    typeof s.catalogId === "string" && s.catalogId ? s.catalogId : undefined;
  if (s.transport === "stdio") {
    const env = s.env && typeof s.env === "object" ? s.env : {};
    const row: Record<string, unknown> = {
      name: s.name,
      transport: "stdio",
      command: s.command,
      args: Array.isArray(s.args) ? [...s.args] : [],
      envNames: Object.keys(env),
      hasSecrets: Object.keys(env).length > 0,
      enabled: s.enabled !== false,
      trusted: s.trusted === true,
    };
    if (typeof s.cwd === "string" && s.cwd) row.cwd = s.cwd;
    if (provenance) row.provenance = provenance;
    if (catalogId) row.catalogId = catalogId;
    return row;
  }
  const headers = s.headers && typeof s.headers === "object" ? s.headers : {};
  const row: Record<string, unknown> = {
    name: s.name,
    transport: s.transport === "sse" ? "sse" : "http",
    url: s.url,
    headerNames: Object.keys(headers),
    hasToken: Boolean(s.token),
    enabled: s.enabled !== false,
  };
  if (provenance) row.provenance = provenance;
  if (catalogId) row.catalogId = catalogId;
  return row;
}

export function redactMcpServers(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) return [];
  return list.map((s) => redactMcpServer(s));
}

function mergeSecretMap(
  existing: Record<string, string> | undefined,
  incoming: unknown,
  present: boolean,
): Record<string, string> | undefined {
  if (!present) {
    return existing && Object.keys(existing).length ? { ...existing } : undefined;
  }
  if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
    return undefined;
  }
  const next = { ...(existing || {}) };
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    if (v === "" || v == null) delete next[k];
    else if (typeof v === "string") next[k] = v;
  }
  return Object.keys(next).length ? next : undefined;
}

export function upsertMcpServer(list: unknown, input: unknown): StoredMcpServer[] {
  if (!input || typeof input !== "object") {
    throw new Error("MCP server input must be an object");
  }
  const current = Array.isArray(list) ? (list as StoredMcpServer[]) : [];
  const rec = input as Record<string, unknown>;
  const name = trimName(rec.name);
  const existing = current.find((s) => s && s.name === name) || null;
  const transport =
    inferTransport(rec) || (existing && existing.transport) || "";
  const switched = Boolean(existing && existing.transport !== transport);
  const merged: Record<string, unknown> = { ...rec, name, transport };

  if (transport === "stdio") {
    if (switched) {
      delete merged.token;
      delete merged.headers;
      delete merged.url;
    } else if (existing && existing.transport === "stdio") {
      if (!Object.prototype.hasOwnProperty.call(input, "env")) {
        if (existing.env) merged.env = { ...existing.env };
      } else {
        merged.env = mergeSecretMap(existing.env, rec.env, true);
      }
      if (!Object.prototype.hasOwnProperty.call(input, "args") && Array.isArray(existing.args)) {
        merged.args = [...existing.args];
      }
      if (!Object.prototype.hasOwnProperty.call(input, "command") && existing.command) {
        merged.command = existing.command;
      }
      if (!Object.prototype.hasOwnProperty.call(input, "cwd") && existing.cwd) {
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
      } else if (rec.token === "") {
        delete merged.token;
      }
      if (!Object.prototype.hasOwnProperty.call(input, "headers")) {
        if (existing.headers) merged.headers = { ...existing.headers };
      } else {
        merged.headers = mergeSecretMap(existing.headers, rec.headers, true);
      }
    } else if (Object.prototype.hasOwnProperty.call(input, "token") && rec.token === "") {
      delete merged.token;
    }
    if (
      Object.prototype.hasOwnProperty.call(input, "headers") &&
      rec.headers &&
      typeof rec.headers === "object"
    ) {
      merged.headers = mergeSecretMap(
        switched ? undefined : existing?.headers,
        rec.headers,
        true,
      );
    }
  }

  const parsed = parseOne(merged, true);
  if (!parsed) throw new Error("MCP server entry is invalid");
  const next = current.filter((s) => !s || s.name !== name);
  next.push(parsed);
  return validateMcpServers(next);
}

function isRedactedPublic(item: unknown): boolean {
  return Boolean(
    item &&
      typeof item === "object" &&
      (Object.prototype.hasOwnProperty.call(item, "headerNames") ||
        Object.prototype.hasOwnProperty.call(item, "hasToken") ||
        Object.prototype.hasOwnProperty.call(item, "envNames") ||
        Object.prototype.hasOwnProperty.call(item, "hasSecrets")),
  );
}

export function sanitizeMcpInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
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

export function mergeMcpSettingsPatch(
  current: unknown,
  incoming: unknown,
): StoredMcpServer[] {
  if (!Array.isArray(incoming)) {
    throw new Error("mcpServers must be an array");
  }
  const curr = Array.isArray(current) ? (current as StoredMcpServer[]) : [];
  const out: StoredMcpServer[] = [];
  for (const item of incoming) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      out.push(item as StoredMcpServer);
      continue;
    }
    const name = trimName((item as { name?: unknown }).name);
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

export function redactSettings<T extends { mcpServers?: unknown }>(settings: T): T {
  return {
    ...settings,
    mcpServers: redactMcpServers(settings.mcpServers),
  };
}

export function slugMcpName(name: unknown): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MCP_NAME_MAX);
}

function notesInstallScripts(
  obj: Record<string, unknown>,
  warnings: string[],
): void {
  const scripts = obj.scripts;
  if (!isPlainObject(scripts)) return;
  if (scripts.install || scripts.preinstall || scripts.postinstall) {
    warnings.push("Package install scripts were not executed");
  }
}

function collectConfigEntries(
  obj: unknown,
  warnings: string[],
): Array<{ name: string; def: Record<string, unknown> }> {
  const entries: Array<{ name: string; def: Record<string, unknown> }> = [];
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
  const mcp = obj.mcp;
  if (isPlainObject(mcp) && isPlainObject(mcp.servers)) {
    for (const [name, def] of Object.entries(mcp.servers)) {
      if (isPlainObject(def)) entries.push({ name, def });
    }
    return entries;
  }
  if (obj.name || obj.url || obj.command) {
    entries.push({ name: trimName(obj.name), def: obj });
  }
  return entries;
}

function blankStringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(raw)) return out;
  for (const k of Object.keys(raw)) {
    if (k) out[k] = "";
  }
  return out;
}

export type McpConfigParseMeta = {
  envNames: string[];
  headerNames: string[];
  hasToken: boolean;
  requiresTrust: boolean;
  warnings: string[];
};

export type McpConfigParsedServer = {
  stored: StoredMcpServer;
  meta: McpConfigParseMeta;
};

function buildFromConfigDef(
  name: string,
  def: Record<string, unknown>,
  warnings: string[],
): { stored: Record<string, unknown>; meta: McpConfigParseMeta } | null {
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
  let transport: McpTransport | "" = "";
  if (type === "http" || type === "sse" || type === "stdio") transport = type;
  else if (hasCommand && !hasUrl) transport = "stdio";
  else if (hasUrl) transport = "http";
  if (!transport) {
    warnings.push(`${slug}: missing command or URL`);
    return null;
  }
  const warningBits: string[] = [];
  if (transport === "stdio") {
    const env = blankStringMap(def.env);
    const envNames = Object.keys(env);
    if (envNames.length) warningBits.push("environment values were stripped");
    const stored: Record<string, unknown> = {
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
        warnings: warningBits,
      },
    };
  }
  const headers = blankStringMap(def.headers);
  const headerNames = Object.keys(headers);
  const hasToken = typeof def.token === "string" && def.token.length > 0;
  if (headerNames.length || hasToken) {
    warningBits.push("credentials were stripped");
  }
  return {
    stored: {
      name: slug,
      transport,
      url: def.url,
      enabled: true,
      headers,
    },
    meta: {
      envNames: [],
      headerNames,
      hasToken,
      requiresTrust: false,
      warnings: warningBits,
    },
  };
}

export function parseMcpConfigDocument(input: unknown): {
  servers: McpConfigParsedServer[];
  warnings: string[];
} {
  const warnings: string[] = [];
  let obj: unknown = input;
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
    (err as Error & { mcpWarnings?: string[] }).mcpWarnings = warnings;
    throw err;
  }
  const servers: McpConfigParsedServer[] = [];
  const seen = new Set<string>();
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
        `${slugMcpName(name) || name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!servers.length) throw new Error("No MCP servers found in config");
  return { servers, warnings };
}

const IMPORT_JSON_MAX_BYTES = 512 * 1024;
const IMPORT_JSON_MAX_DEPTH = 8;
const IMPORT_SECRET_MAX = 64;
const IMPORT_SECRET_BYTES = 32 * 1024;

export type McpRequiredSecret = {
  id: string;
  server: string;
  field: string;
  label: string;
};

export type McpImportParsedServer = {
  stored: StoredMcpServer;
  requiredSecrets: McpRequiredSecret[];
  warnings: string[];
};

function secretDescriptorId(server: string, field: string, label: string): string {
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

function extractTemplateLabels(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  const out: string[] = [];
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function requiredSecretsFor(stored: StoredMcpServer): McpRequiredSecret[] {
  const out: McpRequiredSecret[] = [];
  const server = stored.name;
  const push = (field: string, value: unknown) => {
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
  if (stored.headers) {
    for (const [k, v] of Object.entries(stored.headers)) push(`headers.${k}`, v);
  }
  if (stored.env) {
    for (const [k, v] of Object.entries(stored.env)) push(`env.${k}`, v);
  }
  return out;
}

function substituteTemplate(template: unknown, label: string, value: string): string {
  return String(template ?? "").split("${" + label + "}").join(value);
}

export function applyImportSecrets(
  stored: StoredMcpServer,
  descriptors: McpRequiredSecret[],
  secrets: Record<string, string> | undefined,
): StoredMcpServer {
  const next = JSON.parse(JSON.stringify(stored)) as StoredMcpServer;
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
        [name]: substituteTemplate(next.headers?.[name], d.label, value),
      };
    } else if (d.field.startsWith("env.")) {
      const name = d.field.slice("env.".length);
      next.env = {
        ...(next.env || {}),
        [name]: substituteTemplate(next.env?.[name], d.label, value),
      };
    }
  }
  return next;
}

export function sanitizeImportSecrets(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (!isPlainObject(raw)) throw new Error("secrets must be a plain object");
  const keys = Object.keys(raw);
  if (keys.length > IMPORT_SECRET_MAX) {
    throw new Error("Too many secrets (max 64)");
  }
  const out: Record<string, string> = {};
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

function isPlausibleMcpDefinition(v: unknown): v is Record<string, unknown> {
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

function looksLikeNamedServer(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.name === "string" &&
    obj.name.trim().length > 0 &&
    isPlausibleMcpDefinition(obj)
  );
}

function assertJsonDepth(value: unknown, max: number, depth: number): void {
  if (depth > max) throw new Error("MCP config JSON is too deep");
  if (!value || typeof value !== "object") return;
  const vals = Array.isArray(value) ? value : Object.values(value);
  for (const child of vals) assertJsonDepth(child, max, depth + 1);
}

function entriesFromMap(
  map: Record<string, unknown>,
): Array<{ name: string; def: Record<string, unknown> }> {
  const entries: Array<{ name: string; def: Record<string, unknown> }> = [];
  const seen = new Set<string>();
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

function collectImportEntries(
  obj: unknown,
): Array<{ name: string; def: Record<string, unknown> }> {
  if (!isPlainObject(obj)) {
    throw new Error("MCP config must be a JSON object");
  }
  const wrappers: string[] = [];
  let wrapperMap: Record<string, unknown> | null = null;
  if (isPlainObject(obj.mcpServers)) {
    wrappers.push("mcpServers");
    wrapperMap = obj.mcpServers;
  }
  if (isPlainObject(obj.servers)) {
    wrappers.push("servers");
    if (!wrapperMap) wrapperMap = obj.servers;
  }
  const mcp = obj.mcp;
  if (isPlainObject(mcp) && isPlainObject(mcp.servers)) {
    wrappers.push("mcp.servers");
    if (!wrapperMap) wrapperMap = mcp.servers;
  }
  const extraPlausible: string[] = [];
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

function importDefToItem(
  name: string,
  def: Record<string, unknown>,
): Record<string, unknown> {
  const type = typeof def.type === "string" ? def.type.trim().toLowerCase() : "";
  const transport =
    def.transport === "http" || def.transport === "sse" || def.transport === "stdio"
      ? def.transport
      : type === "http" || type === "sse" || type === "stdio"
        ? type
        : undefined;
  const item: Record<string, unknown> = {
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

export function parseMcpImportDocument(input: unknown): {
  servers: McpImportParsedServer[];
  warnings: string[];
} {
  let obj: unknown = input;
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
  const warnings: string[] = [];
  if (isPlainObject(obj)) notesInstallScripts(obj, warnings);
  const entries = collectImportEntries(obj);
  if (!entries.length) throw new Error("No MCP servers found in config");
  const servers: McpImportParsedServer[] = [];
  const seen = new Set<string>();
  for (const { name, def } of entries) {
    const trimmed = trimName(name);
    if (!trimmed) {
      throw new Error(
        `MCP server name must be lowercase letters, digits, dashes (got "${name}")`,
      );
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
