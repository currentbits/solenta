"use strict";

const { createHash } = require("node:crypto");
const { CLAUDE_USAGE_URL, claudeUsageHeaders, parseClaudeWindows } = require("./providerUsageManaged.js");

const DEFAULTS = { enabled: false, managementUrl: "", managementKey: null };
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Dashboard, server root and legacy management API URLs share one endpoint. */
function normalizeManagementUrl(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) {
    throw new Error("Enter a CLIProxy management URL");
  }
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error("Enter a valid CLIProxy management URL"); }
  if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
    throw new Error("CLIProxy URL must use HTTP or HTTPS without embedded credentials");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use HTTPS for a remote CLIProxy server");
  }
  const base = url.pathname.replace(/\/+$/, "").replace(/\/(?:management\.html|v0\/management)$/i, "");
  url.pathname = `${base}/v0/management`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Stored config is opt-in; corrupt settings never trigger a request. */
function normalizeCliProxyUsage(raw, strict = false) {
  const fail = (message) => { if (strict) throw new Error(message); return { ...DEFAULTS }; };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("CLIProxy usage must be an object");
  if (raw.enabled != null && typeof raw.enabled !== "boolean") return fail("CLIProxy enabled must be a boolean");
  let managementUrl = "";
  try {
    if (raw.managementUrl) managementUrl = normalizeManagementUrl(raw.managementUrl);
  } catch (err) { return fail(err.message); }
  const key = raw.managementKey;
  if (key != null && (typeof key !== "string" || key.length > 8192 || /[\r\n\0]/.test(key))) {
    return fail("CLIProxy management key must be a single line of text");
  }
  if (raw.enabled && !managementUrl) return fail("Enter a CLIProxy management URL before enabling usage");
  return { enabled: raw.enabled === true, managementUrl, managementKey: typeof key === "string" ? key.trim() || null : null };
}

/** An omitted key survives edits only while the destination stays the same. */
function mergeCliProxyUsage(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("CLIProxy usage must be an object");
  const next = normalizeCliProxyUsage({ ...current, ...patch }, true);
  if (next.managementUrl !== current.managementUrl && !Object.hasOwn(patch, "managementKey")) next.managementKey = null;
  return next;
}

function row(provider, label, status, message, windows = [], fetchedAt = null) {
  return { provider, label, source: "cliproxy", status, windows, fetchedAt, ...(message ? { message } : {}) };
}

function statusError(status, management) {
  const err = new Error("usage request failed");
  err.usageStatus = status === 401 || status === 403 || status === 404 ? "unavailable" : "error";
  err.usageMessage = status === 401 || status === 403
    ? management ? "CLIProxy management key rejected" : "CLIProxy account authorization expired"
    : status === 404 ? "CLIProxy usage unavailable"
      : status === 429 ? "CLIProxy usage rate limited; try again later" : "CLIProxy usage request failed";
  return err;
}

/** Never follow redirects with the management key, or expose server error text. */
async function requestJson(url, key, payload, opts) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      const err = new Error("timeout");
      err.name = "AbortError";
      reject(err);
    }, opts.timeoutMs ?? 8000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const res = await (opts.fetch || globalThis.fetch)(url, {
        method: payload ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: "error", signal: ctrl.signal,
      });
      if (res.status < 200 || res.status >= 300) throw statusError(res.status, true);
      if (res.url && new URL(res.url).origin !== new URL(url).origin) throw statusError(0, true);
      const text = await res.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw statusError(0, true);
      return JSON.parse(text);
    })()]);
  } finally { clearTimeout(timer); }
}

function failedRow(provider, label, err) {
  return row(provider, label, err?.usageStatus || "error", err?.name === "AbortError" ? "CLIProxy request timed out" : err?.usageMessage || "CLIProxy usage request failed");
}

/**
 * Read-only auth-files + api-call, as documented by CLIProxyAPI. The proxy
 * substitutes $TOKEN$ itself; Solenta never downloads account credentials.
 * https://github.com/router-for-me/CLIProxyAPIDocs/blob/main/docs/en/management/api.md
 */
async function readCliProxyUsage(raw, opts = {}) {
  const config = normalizeCliProxyUsage(raw);
  if (!config.enabled) return [];
  const sourceId = `cliproxy:${createHash("sha256").update(config.managementUrl).digest("hex").slice(0, 16)}`;
  const sourceLabel = "Claude · CLIProxy";
  if (!config.managementKey) return [row(sourceId, sourceLabel, "unavailable", "Set a CLIProxy management key in Settings > Providers")];
  try {
    const listed = await requestJson(`${config.managementUrl}/auth-files`, config.managementKey, null, opts);
    if (!listed || !Array.isArray(listed.files)) throw statusError(0, true);
    const accounts = listed.files.filter((file) => file && (file.provider || file.type) === "claude");
    if (!accounts.length) return [row(sourceId, sourceLabel, "unavailable", "No Claude accounts in CLIProxy")];
    const seen = new Set();
    const results = await Promise.all(accounts.map(async (file) => {
      const index = typeof file.auth_index === "string" || typeof file.auth_index === "number" ? String(file.auth_index).trim() : "";
      const identity = index || file.id || file.name;
      if (!identity || seen.has(identity)) return null;
      seen.add(identity);
      const provider = `${sourceId}:${createHash("sha256").update(String(identity)).digest("hex").slice(0, 16)}`;
      const account = [file.label, file.email, file.name, file.id].find((value) => typeof value === "string" && value.trim());
      const label = `${sourceLabel}${account ? ` · ${account.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 140)}` : ""}`;
      if (file.disabled === true || !index) {
        return row(provider, label, "unavailable", file.disabled ? "CLIProxy account disabled" : "CLIProxy account has no usage identifier");
      }
      try {
        const result = await requestJson(`${config.managementUrl}/api-call`, config.managementKey, {
          auth_index: index, method: "GET", url: CLAUDE_USAGE_URL,
          header: claudeUsageHeaders("$TOKEN$"),
        }, opts);
        if (!Number.isInteger(result?.status_code) || result.status_code < 200 || result.status_code >= 300) throw statusError(result?.status_code, false);
        const body = typeof result.body === "string" ? JSON.parse(result.body) : result.body;
        const windows = parseClaudeWindows(body);
        return windows.length ? row(provider, label, "ok", null, windows, opts.nowMs ? opts.nowMs() : Date.now()) : row(provider, label, "unavailable", "CLIProxy usage unavailable");
      } catch (err) { return failedRow(provider, label, err); }
    }));
    const rows = results.filter(Boolean);
    return rows.length ? rows : [row(sourceId, sourceLabel, "unavailable", "CLIProxy accounts have no usage identifiers")];
  } catch (err) { return [failedRow(sourceId, sourceLabel, err)]; }
}

module.exports = { normalizeManagementUrl, normalizeCliProxyUsage, mergeCliProxyUsage, readCliProxyUsage };
