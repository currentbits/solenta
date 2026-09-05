"use strict";

/**
 * First-party quota windows for Claude (subscription OAuth) and Kimi
 * (managed coding plan). Read-only: never refresh tokens, never write
 * login/config, never start a model turn. Missing/invalid counts are
 * omitted — never reported as 0%.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_ORIGIN = "https://api.anthropic.com";
const CLAUDE_USAGE_PATH = "/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_UA = "claude-code/2.1.219";
const CLAUDE_HTTP_TIMEOUT_MS = 5000;

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_ORIGIN = "https://api.kimi.com";
const KIMI_USAGE_PATH = "/coding/v1/usages";
const KIMI_HTTP_TIMEOUT_MS = 8000;

const LOCAL_READ_TIMEOUT_MS = 2000;
const KEYCHAIN_TIMEOUT_MS = 3000;
const MAX_ACCOUNT_BYTES = 64 * 1024;

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const MSG_UNAVAILABLE = "usage unavailable";
const MSG_NOT_SIGNED_IN = "not signed in";
const MSG_TIMEOUT = "request timed out";
const MSG_FAILED = "usage request failed";

/**
 * @param {object} fields
 * @returns {{ provider: string, status: "ok"|"unavailable"|"error", windows: object[], fetchedAt: number|null, message?: string }}
 */
function envelope(fields) {
  const out = {
    provider: fields.provider,
    status: fields.status,
    windows: Array.isArray(fields.windows) ? fields.windows : [],
    fetchedAt: fields.fetchedAt == null ? null : fields.fetchedAt,
  };
  if (fields.message) out.message = fields.message;
  return out;
}

function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Finite nonnegative percent. Missing/invalid/NaN/Infinity/negative → null
 * (never 0). Values >100 are kept: the provider reported overage; the UI
 * bar may cap, this field does not.
 */
function finitePercent(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Percent from a provider utilization field. Missing/invalid → null, never 0. */
function percentFromUtilization(raw) {
  return finitePercent(toNumber(raw));
}

/** Percent from used+limit. Both must be known; limit must be > 0. */
function percentFromCounts(used, limit) {
  const u = toNumber(used);
  const l = toNumber(limit);
  if (u === null || l === null || u < 0 || !(l > 0)) return null;
  return finitePercent((u / l) * 100);
}

function parseResetMs(raw) {
  if (raw == null) return null;
  let ms = null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    ms = raw > 1e12 ? Math.trunc(raw) : Math.trunc(raw * 1000);
  } else if (typeof raw === "string" && raw.trim() !== "") {
    const trimmed = raw.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      ms = n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
    } else {
      ms = Date.parse(trimmed);
    }
  }
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function finiteWindowSeconds(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function isExpired(expiresAt, nowMs) {
  const n = toNumber(expiresAt);
  if (n === null) return false;
  const expMs = n > 1e12 ? n : n * 1000;
  return expMs <= nowMs;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("timeout");
        err.code = "timeout";
        err.name = "AbortError";
        reject(err);
      }, ms);
    }),
  ]);
}

function isTimeoutErr(err) {
  return Boolean(
    err && (err.name === "AbortError" || err.code === "timeout"),
  );
}

function allowedUrl(raw, origin, pathname) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.origin.toLowerCase() !== origin) return null;
  const p = parsed.pathname.replace(/\/+$/, "") || "/";
  if (p !== pathname) return null;
  return parsed.toString();
}

function redirectAway(res, origin) {
  const status = res && typeof res.status === "number" ? res.status : 0;
  if (status >= 300 && status < 400) return true;
  const finalUrl = res && typeof res.url === "string" ? res.url : "";
  if (!finalUrl) return false;
  try {
    return new URL(finalUrl).origin.toLowerCase() !== origin;
  } catch {
    return true;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.origin
 * @param {string} opts.pathname
 * @param {Record<string, string>} opts.headers
 * @param {number} opts.timeoutMs
 * @param {(input: string, init?: object) => Promise<{ status: number, ok?: boolean, url?: string, json?: Function, text?: Function }>} opts.fetchFn
 */
async function fetchUsageJson(opts) {
  const url = allowedUrl(opts.url, opts.origin, opts.pathname);
  if (!url) {
    const err = new Error("failed");
    err.code = "failed";
    throw err;
  }
  const fetchFn = opts.fetchFn;
  if (typeof fetchFn !== "function") {
    const err = new Error("failed");
    err.code = "failed";
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: opts.headers,
      signal: ctrl.signal,
      redirect: "error",
    });
    if (redirectAway(res, opts.origin)) {
      const err = new Error("failed");
      err.code = "failed";
      throw err;
    }
    const status = res && typeof res.status === "number" ? res.status : 0;
    if (status === 401 || status === 403) {
      const err = new Error("auth");
      err.code = "auth";
      throw err;
    }
    if (status === 404) {
      const err = new Error("unavailable");
      err.code = "unavailable";
      throw err;
    }
    if (!res || (res.ok === false && status !== 0) || (status !== 0 && (status < 200 || status >= 300))) {
      const err = new Error("failed");
      err.code = "failed";
      throw err;
    }
    let body;
    try {
      body = typeof res.json === "function" ? await res.json() : null;
    } catch (err) {
      if (isTimeoutErr(err)) throw err;
      const fail = new Error("failed");
      fail.code = "failed";
      throw fail;
    }
    return body;
  } catch (err) {
    if (err && (err.code === "auth" || err.code === "unavailable" || err.code === "failed")) {
      throw err;
    }
    if (isTimeoutErr(err)) {
      const te = new Error("timeout");
      te.code = "timeout";
      te.name = "AbortError";
      throw te;
    }
    const fail = new Error("failed");
    fail.code = "failed";
    throw fail;
  } finally {
    clearTimeout(timer);
  }
}

function failEnvelope(provider, err) {
  if (err && err.code === "auth") {
    return envelope({
      provider,
      status: "unavailable",
      message: MSG_NOT_SIGNED_IN,
    });
  }
  if (err && err.code === "unavailable") {
    return envelope({
      provider,
      status: "unavailable",
      message: MSG_UNAVAILABLE,
    });
  }
  if (isTimeoutErr(err)) {
    return envelope({
      provider,
      status: "error",
      message: MSG_TIMEOUT,
    });
  }
  return envelope({
    provider,
    status: "error",
    message: MSG_FAILED,
  });
}

function defaultReadFile(filePath) {
  return fs.promises.readFile(filePath, { encoding: "utf8" });
}

async function readAccountText(filePath, readFile, timeoutMs) {
  const fn = typeof readFile === "function" ? readFile : defaultReadFile;
  let text;
  try {
    text = await withTimeout(fn(filePath, "utf8"), timeoutMs);
  } catch (err) {
    if (isTimeoutErr(err)) throw err;
    return null;
  }
  if (typeof text !== "string") return null;
  if (Buffer.byteLength(text) > MAX_ACCOUNT_BYTES) return null;
  return text;
}

function parseJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function claudeTokenState(obj, nowMs) {
  if (!obj || typeof obj !== "object") return { token: null, expired: false };
  const oauth =
    obj.claudeAiOauth && typeof obj.claudeAiOauth === "object"
      ? obj.claudeAiOauth
      : obj;
  const token = oauth.accessToken;
  if (typeof token !== "string" || !token.trim()) {
    return { token: null, expired: false };
  }
  if (isExpired(oauth.expiresAt, nowMs)) return { token: null, expired: true };
  return { token: token.trim(), expired: false };
}

function kimiTokenState(obj, nowMs) {
  if (!obj || typeof obj !== "object") return { token: null, expired: false };
  const token = obj.access_token;
  if (typeof token !== "string" || !token.trim()) {
    return { token: null, expired: false };
  }
  if (isExpired(obj.expires_at, nowMs)) return { token: null, expired: true };
  return { token: token.trim(), expired: false };
}

function claudeHomedir(opts) {
  return opts && typeof opts.homedir === "string" && opts.homedir
    ? opts.homedir
    : os.homedir();
}

function claudeConfigDir(opts) {
  if (opts && typeof opts.home === "string" && opts.home) return opts.home;
  const env = (opts && opts.env) || process.env;
  if (env && typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR) {
    return env.CLAUDE_CONFIG_DIR;
  }
  return path.join(claudeHomedir(opts), ".claude");
}

/**
 * Claude Code 2.1.219 oG("-credentials"):
 *   r = secure !== undefined ? !secure : !CLAUDE_CONFIG_DIR
 *   n = secure !== undefined ? NFC(secure) : fn()
 *   service = `Claude Code-credentials` + (r ? "" : `-${sha256(n).hex[0:8]}`)
 * Empty CLAUDE_SECURESTORAGE_CONFIG_DIR forces the unhashed default even
 * when CLAUDE_CONFIG_DIR is set. Account is USER or os.userInfo().username,
 * else `claude-code-user`.
 */
function claudeKeychainService(opts, configDir) {
  const env = (opts && opts.env) || process.env || {};
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const configEnv = env.CLAUDE_CONFIG_DIR;
  const defaultDir = path.join(claudeHomedir(opts), ".claude");
  const customHome = Boolean(
    opts &&
      opts.home &&
      path.resolve(String(opts.home)) !== path.resolve(defaultDir),
  );
  const shouldHash =
    secure !== undefined
      ? Boolean(secure)
      : Boolean(configEnv || customHome);
  if (!shouldHash) return "Claude Code-credentials";
  const n = String(secure !== undefined ? secure : configDir).normalize("NFC");
  const hash = crypto.createHash("sha256").update(n).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function claudeKeychainAccount(opts) {
  const env = (opts && opts.env) || process.env || {};
  let name;
  try {
    name = env.USER || os.userInfo().username;
  } catch {
    name = "claude-code-user";
  }
  if (typeof name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    return "claude-code-user";
  }
  return name;
}

function kimiHomeDir(opts) {
  if (opts && typeof opts.home === "string" && opts.home) return opts.home;
  const env = (opts && opts.env) || process.env;
  if (env && typeof env.KIMI_CODE_HOME === "string" && env.KIMI_CODE_HOME) {
    return env.KIMI_CODE_HOME;
  }
  const homedir =
    opts && typeof opts.homedir === "string" && opts.homedir
      ? opts.homedir
      : os.homedir();
  return path.join(homedir, ".kimi-code");
}

function defaultDarwinAccount(opts, configDir) {
  const exec =
    opts && typeof opts.execFile === "function" ? opts.execFile : execFile;
  const account =
    opts && typeof opts.keychainAccount === "string" && opts.keychainAccount
      ? opts.keychainAccount
      : claudeKeychainAccount(opts);
  const service =
    opts && typeof opts.keychainService === "string" && opts.keychainService
      ? opts.keychainService
      : claudeKeychainService(opts, configDir);
  const timeoutMs =
    opts && Number.isFinite(opts.keychainTimeoutMs)
      ? opts.keychainTimeoutMs
      : KEYCHAIN_TIMEOUT_MS;
  return new Promise((resolve) => {
    try {
      exec(
        "security",
        ["find-generic-password", "-a", account, "-w", "-s", service],
        { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null);
          const text = String(stdout || "");
          if (!text.trim()) return resolve(null);
          resolve(text);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function loadClaudeToken(opts, nowMs) {
  const env = (opts && opts.env) || process.env;
  if (env && typeof env.CLAUDE_CODE_OAUTH_TOKEN === "string") {
    const t = env.CLAUDE_CODE_OAUTH_TOKEN.trim();
    if (t) return { token: t, expired: false };
  }
  const platform = (opts && opts.platform) || process.platform;
  const timeoutMs =
    opts && Number.isFinite(opts.readTimeoutMs)
      ? opts.readTimeoutMs
      : LOCAL_READ_TIMEOUT_MS;
  const configDir = claudeConfigDir(opts);

  if (platform === "darwin") {
    const readDarwin =
      opts && typeof opts.readDarwinAccount === "function"
        ? opts.readDarwinAccount
        : () => defaultDarwinAccount(opts, configDir);
    try {
      const text = await withTimeout(readDarwin(), timeoutMs);
      const state = claudeTokenState(
        parseJsonObject(typeof text === "string" ? text : ""),
        nowMs,
      );
      if (state.expired || state.token) return state;
    } catch (err) {
      if (isTimeoutErr(err)) throw err;
    }
  }

  const filePath = path.join(configDir, ".credentials.json");
  const text = await readAccountText(filePath, opts && opts.readFile, timeoutMs);
  if (text == null) return { token: null, expired: false };
  return claudeTokenState(parseJsonObject(text), nowMs);
}

async function loadKimiToken(opts, nowMs) {
  const timeoutMs =
    opts && Number.isFinite(opts.readTimeoutMs)
      ? opts.readTimeoutMs
      : LOCAL_READ_TIMEOUT_MS;
  const filePath = path.join(kimiHomeDir(opts), "credentials", "kimi-code.json");
  const text = await readAccountText(filePath, opts && opts.readFile, timeoutMs);
  if (text == null) return { token: null, expired: false };
  return kimiTokenState(parseJsonObject(text), nowMs);
}

function claudeWindow(raw, label, windowSeconds) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usedPercent = percentFromUtilization(
    raw.utilization ?? raw.used_percentage ?? raw.usedPercent,
  );
  const seconds = finiteWindowSeconds(windowSeconds);
  if (usedPercent === null || seconds === null) return null;
  return {
    label,
    usedPercent,
    resetsAt: parseResetMs(raw.resets_at ?? raw.resetsAt),
    windowSeconds: seconds,
  };
}

function parseClaudeWindows(body) {
  if (!body || typeof body !== "object") return [];
  const windows = [];
  const specs = [
    ["five_hour", "5-hour", FIVE_HOUR_SECONDS],
    ["seven_day", "weekly", WEEK_SECONDS],
    ["seven_day_sonnet", "weekly (Sonnet)", WEEK_SECONDS],
    ["seven_day_opus", "weekly (Opus)", WEEK_SECONDS],
  ];
  for (const [key, label, seconds] of specs) {
    const win = claudeWindow(body[key], label, seconds);
    if (win) windows.push(win);
  }
  return windows;
}

function timeUnit(raw) {
  switch (raw) {
    case "TIME_UNIT_MINUTE":
      return "minute";
    case "TIME_UNIT_HOUR":
      return "hour";
    case "TIME_UNIT_DAY":
      return "day";
    case "TIME_UNIT_WEEK":
      return "week";
    default:
      return null;
  }
}

function windowFromKimi(raw) {
  if (!raw || typeof raw !== "object") return null;
  const duration = toNumber(raw.duration);
  const unit = timeUnit(raw.timeUnit);
  if (duration === null || duration <= 0 || !unit) return null;
  if (unit === "minute" && duration >= 60 && duration % 60 === 0) {
    const seconds = finiteWindowSeconds(duration * 60);
    if (seconds === null) return null;
    return {
      duration: duration / 60,
      unit: "hour",
      seconds,
    };
  }
  const rawSeconds =
    unit === "minute"
      ? duration * 60
      : unit === "hour"
        ? duration * 3600
        : unit === "day"
          ? duration * 86400
          : duration * WEEK_SECONDS;
  const seconds = finiteWindowSeconds(rawSeconds);
  if (seconds === null) return null;
  return { duration, unit, seconds };
}

function labelFromKimiWindow(win) {
  if (!win) return null;
  if (win.unit === "hour" && win.duration === 5) return "5-hour";
  if (win.unit === "week" && win.duration === 1) return "weekly";
  if (win.unit === "hour" && win.duration === 1) return "1-hour";
  if (win.unit === "day" && win.duration === 1) return "daily";
  if (win.unit === "week") return `${win.duration}-week`;
  if (win.unit === "day") return `${win.duration}-day`;
  if (win.unit === "hour") return `${win.duration}-hour`;
  if (win.unit === "minute") return `${win.duration}-minute`;
  return null;
}

function kimiRowWindow(detail, windowHint) {
  if (!detail || typeof detail !== "object") return null;
  const usedPercent = percentFromCounts(detail.used, detail.limit);
  if (usedPercent === null || !windowHint) return null;
  const seconds = finiteWindowSeconds(windowHint.seconds);
  const label = labelFromKimiWindow(windowHint);
  if (!label || seconds === null) return null;
  return {
    label,
    usedPercent,
    resetsAt: parseResetMs(detail.resetTime ?? detail.resetAt),
    windowSeconds: seconds,
  };
}

function parseKimiWindows(body) {
  if (!body || typeof body !== "object") return [];
  const out = [];
  const seen = new Set();
  const add = (win) => {
    if (!win) return;
    if (seen.has(win.label) || seen.has(win.windowSeconds)) return;
    seen.add(win.label);
    seen.add(win.windowSeconds);
    out.push(win);
  };
  const summaryWin = { duration: 1, unit: "week", seconds: WEEK_SECONDS };
  add(kimiRowWindow(body.usage, summaryWin));
  const limits = Array.isArray(body.limits) ? body.limits : [];
  for (const item of limits) {
    if (!item || typeof item !== "object") continue;
    add(kimiRowWindow(item.detail, windowFromKimi(item.window)));
  }
  out.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return out;
}

function nowMs(opts) {
  if (opts && typeof opts.now === "function") return opts.now();
  if (opts && typeof opts.now === "number" && Number.isFinite(opts.now)) {
    return opts.now;
  }
  return Date.now();
}

function fetchImpl(opts) {
  if (opts && typeof opts.fetch === "function") return opts.fetch;
  return globalThis.fetch;
}

/**
 * Claude subscription quota: 5-hour + weekly windows from
 * GET https://api.anthropic.com/api/oauth/usage (verified in the
 * installed Claude Code binary as fetchUtilization).
 *
 * @param {object} [opts]
 * @returns {Promise<{ provider: "claude", status: "ok"|"unavailable"|"error", windows: object[], fetchedAt: number|null, message?: string }>}
 */
async function readClaudeUsage(opts = {}) {
  const provider = "claude";
  const now = nowMs(opts);
  let loaded;
  try {
    loaded = await loadClaudeToken(opts, now);
  } catch (err) {
    return failEnvelope(provider, err);
  }
  if (!loaded.token) {
    return envelope({
      provider,
      status: "unavailable",
      message: MSG_NOT_SIGNED_IN,
    });
  }
  const timeoutMs =
    opts && Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : CLAUDE_HTTP_TIMEOUT_MS;
  try {
    const body = await fetchUsageJson({
      url: CLAUDE_USAGE_URL,
      origin: CLAUDE_ORIGIN,
      pathname: CLAUDE_USAGE_PATH,
      timeoutMs,
      fetchFn: fetchImpl(opts),
      headers: {
        Authorization: `Bearer ${loaded.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "anthropic-version": CLAUDE_ANTHROPIC_VERSION,
        "User-Agent": CLAUDE_UA,
      },
    });
    const windows = parseClaudeWindows(body);
    if (!windows.length) {
      return envelope({
        provider,
        status: "unavailable",
        message: MSG_UNAVAILABLE,
      });
    }
    return envelope({
      provider,
      status: "ok",
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return failEnvelope(provider, err);
  }
}

/**
 * Kimi managed-plan quota: weekly summary plus windowed limits from
 * GET https://api.kimi.com/coding/v1/usages (Moonshot official
 * managed-usage.ts; confirmed in the installed Bun CLI).
 *
 * @param {object} [opts]
 * @returns {Promise<{ provider: "kimi", status: "ok"|"unavailable"|"error", windows: object[], fetchedAt: number|null, message?: string }>}
 */
async function readKimiUsage(opts = {}) {
  const provider = "kimi";
  const now = nowMs(opts);
  let loaded;
  try {
    loaded = await loadKimiToken(opts, now);
  } catch (err) {
    return failEnvelope(provider, err);
  }
  if (!loaded.token) {
    return envelope({
      provider,
      status: "unavailable",
      message: MSG_NOT_SIGNED_IN,
    });
  }
  const timeoutMs =
    opts && Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : KIMI_HTTP_TIMEOUT_MS;
  try {
    const body = await fetchUsageJson({
      url: KIMI_USAGE_URL,
      origin: KIMI_ORIGIN,
      pathname: KIMI_USAGE_PATH,
      timeoutMs,
      fetchFn: fetchImpl(opts),
      headers: {
        Authorization: `Bearer ${loaded.token}`,
        Accept: "application/json",
      },
    });
    const windows = parseKimiWindows(body);
    if (!windows.length) {
      return envelope({
        provider,
        status: "unavailable",
        message: MSG_UNAVAILABLE,
      });
    }
    return envelope({
      provider,
      status: "ok",
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return failEnvelope(provider, err);
  }
}

module.exports = {
  readClaudeUsage,
  readKimiUsage,
};
