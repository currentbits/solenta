"use strict";

/**
 * Provider-reported account quotas. Separate from the local byDay ledger:
 * this never infers percentages from spend, and a missing window is omitted
 * rather than 0%.
 *
 * Sources (read-only, no LLM turn):
 * - Codex: `codex app-server --listen stdio://` JSON-RPC
 *   initialize + initialized + account/rateLimits/read. Labels come from
 *   windowDurationMins, not primary/secondary order. Distinct pools from
 *   rateLimitsByLimitId; the aggregate `codex` duplicate is skipped.
 * - Grok: `grok agent --no-leader stdio` ACP initialize then `_x.ai/billing`.
 *   Period type/duration from currentPeriod; no invented 5-hour window.
 * - Claude / Kimi: `readClaudeUsage` / `readKimiUsage` from
 *   ./providerUsageManaged.js (other worker). Missing module → unavailable.
 *
 * Cursor, OpenCode, and Muse have no documented quota endpoint.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const spawn = require("cross-spawn");
const {
  getProvider,
  knownProviderIds,
  resolveBin,
  isBinAvailable,
  defaultWhich,
} = require("./providers.js");
const { killTree, agentSpawnOptions } = require("./proc.js");

const TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SIGKILL_AFTER_MS = 1_000;
const FIVE_HOUR_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 24 * 3600;

const UNSUPPORTED = {
  cursor: "Cursor CLI has no documented usage or quota command.",
  opencode: "OpenCode CLI reports local stats, not account quotas.",
  muse: "Muse CLI has no documented usage or quota command.",
};

/**
 * @param {string} provider
 * @param {"ok"|"unavailable"|"error"} status
 * @param {object[]} [windows]
 * @param {number|null} [fetchedAt]
 * @param {string} [message]
 */
function usageRow(provider, status, windows, fetchedAt, message) {
  /** @type {{provider:string,status:string,windows:object[],fetchedAt:number|null,message?:string}} */
  const row = {
    provider,
    status,
    windows: Array.isArray(windows) ? windows : [],
    fetchedAt: fetchedAt == null ? null : fetchedAt,
  };
  if (message) row.message = message;
  return row;
}

function okUsage(provider, windows, fetchedAt) {
  return usageRow(provider, "ok", windows, fetchedAt);
}

function unavailable(provider, message) {
  return usageRow(provider, "unavailable", [], null, message);
}

function errorUsage(provider, message) {
  return usageRow(provider, "error", [], null, message);
}

/** Fixed IPC messages. Never copy child/RPC text (it can contain tokens). */
const MSG_UNAVAILABLE = "usage unavailable";
const MSG_SIGNED_OUT = "not signed in";
const MSG_TIMEOUT = "request timed out";
const MSG_FAILED = "usage request failed";

function fromCliError(err) {
  const msg = err && typeof err.message === "string" ? err.message : "";
  if (msg === "timed out") return { status: "error", message: MSG_TIMEOUT };
  if (msg === "not signed in") return { status: "unavailable", message: MSG_SIGNED_OUT };
  return { status: "error", message: MSG_FAILED };
}

function liveCliAllowed(opts, env, providerId) {
  if (opts && (opts.spawn || opts.allowLive)) return true;
  if (!process.env.NODE_TEST_CONTEXT) return true;
  const entry = getProvider(providerId);
  return Boolean(entry && entry.binEnv && env && env[entry.binEnv]);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Finite nonnegative usedPercent. Null/NaN/Infinity/negative are missing
 * (never coerced to 0%). Values above 100 are kept (overage).
 * @param {unknown} n
 * @returns {number|null}
 */
function usedPercentOf(n) {
  const v = asNumber(n);
  if (v == null || v < 0) return null;
  return v;
}

/**
 * Provider timestamps are Unix seconds, epoch ms, or ISO-8601.
 * @param {unknown} value
 * @returns {number|null} epoch milliseconds
 */
function toEpochMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return toEpochMs(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function labelForWindowSeconds(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "quota";
  if (Math.abs(seconds - FIVE_HOUR_SECONDS) <= 120) return "5-hour";
  if (Math.abs(seconds - WEEK_SECONDS) <= 3600) return "weekly";
  if (Math.abs(seconds - 3600) <= 30) return "1-hour";
  if (Math.abs(seconds - 86400) <= 60) return "daily";
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1-hour" : `${hours}-hour`;
  }
  if (seconds % 60 === 0) {
    const mins = seconds / 60;
    return mins === 1 ? "1-minute" : `${mins}-minute`;
  }
  return "quota";
}

function windowSecondsFromMins(mins) {
  const n = asNumber(mins);
  if (n == null || n <= 0) return null;
  return Math.round(n * 60);
}

/**
 * @param {unknown} usedPercent
 * @param {unknown} resetsAt
 * @param {number|null} windowSeconds
 * @param {string} [label]
 * @returns {object|null}
 */
function makeWindow(usedPercent, resetsAt, windowSeconds, label) {
  const pct = usedPercentOf(usedPercent);
  if (pct == null) return null;
  return {
    label: label || labelForWindowSeconds(windowSeconds),
    usedPercent: pct,
    resetsAt: toEpochMs(resetsAt),
    windowSeconds:
      windowSeconds == null || !Number.isFinite(windowSeconds) || windowSeconds <= 0
        ? null
        : Math.round(windowSeconds),
  };
}

function addWindow(out, win) {
  if (!win) return;
  const key = `${win.label}:${win.windowSeconds}:${win.usedPercent}:${win.resetsAt}`;
  if (out.some((w) => `${w.label}:${w.windowSeconds}:${w.usedPercent}:${w.resetsAt}` === key)) {
    return;
  }
  out.push(win);
}

function poolPrefix(snap, id) {
  if (!snap || typeof snap !== "object") return "";
  const s = /** @type {Record<string, unknown>} */ (snap);
  const name = typeof s.limitName === "string" ? s.limitName.trim() : "";
  const lid =
    typeof s.limitId === "string" && s.limitId.trim()
      ? s.limitId.trim()
      : String(id || "").trim();
  if (name && !/^codex$/i.test(name)) return name;
  if (lid && !/^codex$/i.test(lid)) return lid;
  return "";
}

function windowsFromCodexSnap(snap, prefix) {
  if (!snap || typeof snap !== "object") return [];
  const s = /** @type {Record<string, unknown>} */ (snap);
  const out = [];
  for (const key of ["primary", "secondary"]) {
    const bucket = s[key];
    if (!bucket || typeof bucket !== "object") continue;
    const b = /** @type {Record<string, unknown>} */ (bucket);
    const seconds = windowSecondsFromMins(b.windowDurationMins);
    const durationLabel = labelForWindowSeconds(seconds);
    const label = prefix ? `${prefix} ${durationLabel}` : durationLabel;
    addWindow(out, makeWindow(b.usedPercent, b.resetsAt, seconds, label));
  }
  return out;
}

function poolIdentity(snap, mapKey) {
  if (snap && typeof snap === "object") {
    const lid = /** @type {Record<string, unknown>} */ (snap).limitId;
    if (typeof lid === "string" && lid.trim()) return lid.trim();
  }
  return String(mapKey || "").trim();
}

/**
 * Codex `account/rateLimits/read` result.
 * Live primary can be weekly (10080 min); never assume primary = 5-hour.
 * Emit `rateLimits` first, then byId pools. Skip a byId entry only when
 * its identity (limitId, else map key) matches the aggregate (limitId,
 * else "codex"). Same quota numbers on a different id are kept.
 * @param {unknown} result
 * @returns {object[]}
 */
function normalizeCodexRateLimits(result) {
  if (!result || typeof result !== "object") return [];
  const root = /** @type {Record<string, unknown>} */ (result);
  const aggregate =
    root.rateLimits && typeof root.rateLimits === "object"
      ? /** @type {Record<string, unknown>} */ (root.rateLimits)
      : null;
  const byId =
    root.rateLimitsByLimitId && typeof root.rateLimitsByLimitId === "object"
      ? /** @type {Record<string, unknown>} */ (root.rateLimitsByLimitId)
      : null;

  const out = [];
  const aggId = aggregate ? poolIdentity(aggregate, "codex") || "codex" : "";
  if (aggregate) {
    for (const w of windowsFromCodexSnap(aggregate, poolPrefix(aggregate, aggId))) {
      addWindow(out, w);
    }
  }
  if (byId) {
    for (const [id, snap] of Object.entries(byId)) {
      if (!snap || typeof snap !== "object") continue;
      const rec = /** @type {Record<string, unknown>} */ (snap);
      if (aggId && poolIdentity(rec, id) === aggId) continue;
      for (const w of windowsFromCodexSnap(rec, poolPrefix(rec, id))) {
        addWindow(out, w);
      }
    }
  }
  return out;
}

function grokPeriodTypeLabel(type) {
  const t = String(type || "").toUpperCase();
  if (!t) return null;
  if (t.includes("WEEK")) return "weekly";
  if (t.includes("MONTH")) return "monthly";
  if (t.includes("DAY")) return "daily";
  if (t.includes("HOUR")) return "hourly";
  return null;
}

function grokPeriodSeconds(period) {
  if (!period || typeof period !== "object") return null;
  const p = /** @type {Record<string, unknown>} */ (period);
  const start = toEpochMs(p.start);
  const end = toEpochMs(p.end);
  if (start != null && end != null && end > start) {
    return Math.round((end - start) / 1000);
  }
  const label = grokPeriodTypeLabel(p.type);
  if (label === "weekly") return WEEK_SECONDS;
  if (label === "daily") return 86400;
  return null;
}

/**
 * Live Grok `_x.ai/billing` result. Label from currentPeriod.type / duration.
 * Never invents a 5-hour window.
 * @param {unknown} result
 * @returns {object[]}
 */
function normalizeGrokBilling(result) {
  if (!result || typeof result !== "object") return [];
  const root = /** @type {Record<string, unknown>} */ (result);
  const config =
    root.config && typeof root.config === "object"
      ? /** @type {Record<string, unknown>} */ (root.config)
      : root;
  const pct = usedPercentOf(config.creditUsagePercent);
  if (pct == null) return [];
  const period =
    config.currentPeriod && typeof config.currentPeriod === "object"
      ? /** @type {Record<string, unknown>} */ (config.currentPeriod)
      : null;
  const typeLabel = grokPeriodTypeLabel(period && period.type);
  const seconds = grokPeriodSeconds(period);
  const durationLabel = typeLabel || labelForWindowSeconds(seconds);
  const resets = period && period.end != null ? period.end : config.billingPeriodEnd;
  const win = makeWindow(pct, resets, seconds, durationLabel);
  return win ? [win] : [];
}

function parseJsonLine(line) {
  const s = String(line || "").trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function rpcIsSignedOut(error) {
  if (!error || typeof error !== "object") return false;
  const msg = /** @type {{message?: unknown}} */ (error).message;
  return typeof msg === "string" && /authentication required|not signed in|unauthorized/i.test(msg);
}

/**
 * One-shot JSON-RPC over stdio. Always kills the child. Neutral cwd is the
 * caller's job. Never emits provider text; Errors are our own tags.
 *
 * @param {object} opts
 * @returns {Promise<unknown>}
 */
function runStdioJsonRpc(opts) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const maxBytes = opts.maxBytes || MAX_OUTPUT_BYTES;
  const spawnFn = opts.spawn || spawn;
  const sigkillAfterMs = opts.sigkillAfterMs || SIGKILL_AFTER_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let child = null;
    let bytes = 0;
    let buf = "";
    let handshakeDone = false;

    const timeout = setTimeout(() => {
      finish(new Error("timed out"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      try {
        if (child && child.stdin && !child.stdin.destroyed) child.stdin.end();
      } catch {
        // ignore
      }
      if (child && child.pid && !child.killed) {
        killTree(child, sigkillAfterMs);
      }
    }

    function finish(err, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    }

    function writeMessages(messages) {
      if (settled || !child || !child.stdin || child.stdin.destroyed) return;
      try {
        for (const msg of messages) {
          if (settled || child.stdin.destroyed) return;
          child.stdin.write(`${JSON.stringify(msg)}\n`);
        }
      } catch {
        finish(new Error("usage request failed"));
      }
    }

    function handleLine(line) {
      if (settled) return;
      const msg = parseJsonLine(line);
      if (!msg || typeof msg !== "object") return;
      if (!handshakeDone && msg.id === opts.handshakeId) {
        if (msg.error) {
          finish(new Error(rpcIsSignedOut(msg.error) ? "not signed in" : "usage request failed"));
          return;
        }
        handshakeDone = true;
        writeMessages(opts.followup || []);
        return;
      }
      if (handshakeDone && msg.id === opts.matchId) {
        if (msg.error) {
          finish(new Error(rpcIsSignedOut(msg.error) ? "not signed in" : "usage request failed"));
          return;
        }
        finish(null, msg.result);
      }
    }

    try {
      child = spawnFn(
        opts.bin,
        opts.args,
        agentSpawnOptions({
          cwd: opts.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: opts.env,
        }),
      );
    } catch {
      finish(new Error("usage request failed"));
      return;
    }

    if (!child || !child.stdout) {
      finish(new Error("usage request failed"));
      return;
    }

    if (child.stdin) {
      child.stdin.on("error", (err) => {
        if (settled) return;
        if (err && (err.code === "EPIPE" || err.code === "ECONNRESET")) {
          finish(new Error("usage request failed"));
          return;
        }
        finish(new Error("usage request failed"));
      });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes) {
        finish(new Error("usage request failed"));
        return;
      }
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stdout.on("error", () => {
      if (!settled) finish(new Error("usage request failed"));
    });
    if (child.stderr) {
      child.stderr.on("data", () => {});
      child.stderr.on("error", () => {});
    }
    child.on("error", () => {
      finish(new Error("usage request failed"));
    });
    child.on("exit", () => {
      if (!settled) finish(new Error("usage request failed"));
    });

    writeMessages(opts.handshake || []);
  });
}

async function withNeutralCwd(opts, run) {
  let cwd = opts.cwd;
  let created = false;
  if (!cwd) {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "solenta-usage-"));
    created = true;
  }
  try {
    return await run(cwd);
  } finally {
    if (created) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

async function fetchCodex(opts = {}) {
  const env = opts.env || process.env;
  if (!liveCliAllowed(opts, env, "codex")) {
    return unavailable("codex", MSG_UNAVAILABLE);
  }
  const entry = getProvider("codex");
  const bin = resolveBin(entry, env);
  const whichFn = opts.which || defaultWhich;
  if (!isBinAvailable(bin, whichFn, env)) {
    return unavailable("codex", MSG_UNAVAILABLE);
  }
  try {
    const result = await withNeutralCwd(opts, (cwd) =>
      runStdioJsonRpc({
        bin,
        args: ["app-server", "--listen", "stdio://"],
        cwd,
        env: { ...env, RUST_LOG: "off" },
        handshake: [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "solenta", version: "1" },
              capabilities: {},
            },
          },
        ],
        handshakeId: 1,
        followup: [
          { jsonrpc: "2.0", method: "initialized" },
          { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
        ],
        matchId: 2,
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        sigkillAfterMs: opts.sigkillAfterMs,
        spawn: opts.spawn,
      }),
    );
    const windows = normalizeCodexRateLimits(result);
    if (!windows.length) return unavailable("codex", MSG_UNAVAILABLE);
    const fetchedAt = opts.nowMs ? opts.nowMs() : Date.now();
    return okUsage("codex", windows, fetchedAt);
  } catch (err) {
    const mapped = fromCliError(err);
    return usageRow("codex", mapped.status, [], null, mapped.message);
  }
}

async function fetchGrok(opts = {}) {
  const env = opts.env || process.env;
  if (!liveCliAllowed(opts, env, "grok")) {
    return unavailable("grok", MSG_UNAVAILABLE);
  }
  const entry = getProvider("grok");
  const bin = resolveBin(entry, env);
  const whichFn = opts.which || defaultWhich;
  if (!isBinAvailable(bin, whichFn, env)) {
    return unavailable("grok", MSG_UNAVAILABLE);
  }
  try {
    const result = await withNeutralCwd(opts, (cwd) =>
      runStdioJsonRpc({
        bin,
        args: ["agent", "--no-leader", "stdio"],
        cwd,
        env,
        handshake: [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 1,
              clientCapabilities: {},
              clientInfo: { name: "solenta", version: "1" },
            },
          },
        ],
        handshakeId: 1,
        followup: [{ jsonrpc: "2.0", id: 2, method: "_x.ai/billing", params: {} }],
        matchId: 2,
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        sigkillAfterMs: opts.sigkillAfterMs,
        spawn: opts.spawn,
      }),
    );
    const windows = normalizeGrokBilling(result);
    if (!windows.length) return unavailable("grok", MSG_UNAVAILABLE);
    const fetchedAt = opts.nowMs ? opts.nowMs() : Date.now();
    return okUsage("grok", windows, fetchedAt);
  } catch (err) {
    const mapped = fromCliError(err);
    return usageRow("grok", mapped.status, [], null, mapped.message);
  }
}

async function fetchClaude(opts = {}) {
  const { readClaudeUsage } = require("./providerUsageManaged.js");
  return readClaudeUsage(opts);
}

async function fetchKimi(opts = {}) {
  const { readKimiUsage } = require("./providerUsageManaged.js");
  return readKimiUsage(opts);
}

function unsupportedFetcher(id) {
  return async () => unavailable(id, UNSUPPORTED[id]);
}

const DEFAULT_FETCHERS = {
  claude: fetchClaude,
  codex: fetchCodex,
  grok: fetchGrok,
  opencode: unsupportedFetcher("opencode"),
  kimi: fetchKimi,
  cursor: unsupportedFetcher("cursor"),
  muse: unsupportedFetcher("muse"),
};

/**
 * One row per real provider in electron/providers.js (not simulate), then
 * one per named instance in `opts.instances`.
 * Failures are isolated: one provider error never rejects the list.
 *
 * @param {object} [opts]
 * @returns {Promise<object[]>}
 */
async function fetchProviderLimits(opts = {}) {
  // `only` (#1857): skip the other base providers; callers pass only the
  // instances they want.
  const ids = knownProviderIds().filter((id) => !opts.only || id === opts.only);
  const env = opts.env || process.env;
  const probes = opts.instances || [];
  const rows = await Promise.all(
    ids.map(async (id) => {
      const fn =
        (opts.fetchers && opts.fetchers[id]) ||
        DEFAULT_FETCHERS[id] ||
        unsupportedFetcher(id);
      // A probe whose ref is the base id is the default account's own env
      // (base overlay, #1714): fetch the base row under it, not twice.
      const overlay = probes.find((inst) => inst.ref === id);
      try {
        const row = await fn({
          ...opts,
          providerId: id,
          ...(overlay ? { env: { ...env, ...overlay.env } } : {}),
        });
        if (row && typeof row === "object" && row.provider) return row;
        return errorUsage(id, MSG_FAILED);
      } catch {
        return errorUsage(id, MSG_FAILED);
      }
    }),
  );
  // Named instances (#453): the base fetcher under the instance's env (its
  // config dir holds a different login), reported under the instance ref.
  const instanceRows = await Promise.all(
    probes.filter((inst) => !ids.includes(inst.ref)).map(async (inst) => {
      const fn =
        (opts.fetchers && opts.fetchers[inst.provider]) ||
        DEFAULT_FETCHERS[inst.provider];
      if (!fn) return unavailable(inst.ref, MSG_UNAVAILABLE);
      try {
        const row = await fn({
          ...opts,
          providerId: inst.provider,
          env: { ...env, ...inst.env },
        });
        if (row && typeof row === "object" && row.provider) {
          return { ...row, provider: inst.ref };
        }
        return errorUsage(inst.ref, MSG_FAILED);
      } catch {
        return errorUsage(inst.ref, MSG_FAILED);
      }
    }),
  );
  return [...rows, ...instanceRows];
}

/**
 * Live windows from runs (#1859): Claude's `rate_limit_event` and Codex's
 * `account/rateLimits/updated` arrive mid-turn. Listeners (the menu bar)
 * get `(ref, windows)` for the thread's account ref.
 * @type {Set<(ref: string, windows: object[]) => void>}
 */
const liveListeners = new Set();

/** @param {(ref: string, windows: object[]) => void} fn @returns {() => void} unsubscribe */
function onLiveUsage(fn) {
  liveListeners.add(fn);
  return () => liveListeners.delete(fn);
}

/** @param {string} ref @param {object[]} windows */
function reportLiveUsage(ref, windows) {
  if (!ref || !Array.isArray(windows) || !windows.length) return;
  for (const fn of liveListeners) {
    try {
      fn(ref, windows);
    } catch {
      // A listener bug never breaks a run.
    }
  }
}

const CLAUDE_LIMIT_TYPES = { five_hour: ["5-hour", FIVE_HOUR_SECONDS], seven_day: ["weekly", WEEK_SECONDS] };

/**
 * Claude stream-json `rate_limit_event.rate_limit_info`. `utilization` is a
 * 0-1 fraction (claude 2.1.x keeps its own alert thresholds, 0.75/0.9, in
 * the same field) and is often absent below them; then nothing is known.
 * @param {unknown} info
 * @returns {object[]}
 */
function claudeRateLimitWindows(info) {
  if (!info || typeof info !== "object") return [];
  const i = /** @type {Record<string, unknown>} */ (info);
  const kind = CLAUDE_LIMIT_TYPES[/** @type {keyof typeof CLAUDE_LIMIT_TYPES} */ (String(i.rateLimitType))];
  const u = asNumber(i.utilization);
  if (!kind || u == null) return [];
  const win = makeWindow(u * 100, i.resetsAt, kind[1], kind[0]);
  return win ? [win] : [];
}

/** An account at or above this in its 5-hour or weekly window is skipped. */
const PICK_SKIP_PERCENT = 95;

/**
 * `<provider>:auto` (#1857): the account with the lowest max(5-hour %,
 * weekly %), ties to the soonest reset of that window. Accounts at
 * PICK_SKIP_PERCENT or more are skipped. With no usage known for any
 * candidate the default account (refs[0]) wins.
 *
 * ponytail: only the unprefixed "5-hour"/"weekly" windows count, so
 * Claude's per-model weekly windows and Codex's per-model pools are ignored.
 *
 * @param {string[]} refs - candidates, the default account first
 * @param {object[]} rows - fetchProviderLimits rows
 * @returns {{ ref: string, note: string }}
 */
function pickAccountByQuota(refs, rows) {
  /** @type {{ ref: string, top: { label: string, usedPercent: number, resetsAt: number | null } }[]} */
  const open = [];
  const unknown = [];
  const full = [];
  for (const ref of refs) {
    const row = (rows || []).find((r) => r && r.provider === ref && r.status === "ok");
    const wins = row
      ? row.windows.filter((w) => w && (w.label === "5-hour" || w.label === "weekly"))
      : [];
    if (wins.length === 0) {
      unknown.push(ref);
      continue;
    }
    const top = wins.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    if (top.usedPercent >= PICK_SKIP_PERCENT) full.push(ref);
    else open.push({ ref, top });
  }
  const resetOf = (/** @type {{ resetsAt: number | null }} */ w) =>
    w.resetsAt == null ? Infinity : w.resetsAt;
  open.sort(
    (a, b) =>
      a.top.usedPercent - b.top.usedPercent || resetOf(a.top) - resetOf(b.top) || 0,
  );
  if (open.length > 0) {
    const { ref, top } = open[0];
    return { ref, note: `Picked ${ref}, ${Math.round(top.usedPercent)}% of ${top.label} used` };
  }
  if (unknown.length > 0) {
    const ref = unknown.includes(refs[0]) ? refs[0] : unknown[0];
    return { ref, note: `Picked ${ref}, no usage known for ${unknown.join(", ")}` };
  }
  throw new Error(
    `Every account is at least ${PICK_SKIP_PERCENT}% used (${full.join(", ")}). ` +
      "Pass one of them explicitly to run anyway, or wait for a reset.",
  );
}

module.exports = {
  onLiveUsage,
  reportLiveUsage,
  claudeRateLimitWindows,
  TIMEOUT_MS,
  FIVE_HOUR_SECONDS,
  WEEK_SECONDS,
  MSG_UNAVAILABLE,
  MSG_SIGNED_OUT,
  MSG_TIMEOUT,
  MSG_FAILED,
  fetchProviderLimits,
  pickAccountByQuota,
  PICK_SKIP_PERCENT,
  fetchClaude,
  fetchCodex,
  fetchGrok,
  fetchKimi,
  normalizeCodexRateLimits,
  normalizeGrokBilling,
  toEpochMs,
  usedPercentOf,
  labelForWindowSeconds,
  runStdioJsonRpc,
};
