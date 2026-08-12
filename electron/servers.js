"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");

const CACHE_TTL_MS = 5_000;
const LSOF_TIMEOUT_MS = 8_000;
const LSOF_MAX_BUFFER = 8 * 1024 * 1024;

/** @type {Map<string, { at: number, value: object[] }>} */
const cache = new Map();

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output into listen entries.
 * Ignores unknown field codes (lsof still emits `f` lines for fds).
 *
 * @param {string} stdout
 * @returns {Array<{ pid: number, command: string, host: string, port: number }>}
 */
function parseLsofListen(stdout) {
  const entries = [];
  let pid = null;
  let command = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line) continue;
    const code = line[0];
    const value = line.slice(1);
    if (code === "p") {
      const n = Number(value);
      pid = Number.isInteger(n) && n > 0 ? n : null;
      command = "";
      continue;
    }
    if (code === "c") {
      command = value;
      continue;
    }
    if (code !== "n" || pid == null) continue;
    const parsed = parseHostPort(value);
    if (!parsed) continue;
    entries.push({
      pid,
      command,
      host: parsed.host,
      port: parsed.port,
    });
  }
  return entries;
}

/**
 * Parse `lsof -a -p <pids> -d cwd -Fn` output into pid → cwd.
 *
 * @param {string} stdout
 * @returns {Map<number, string>}
 */
function parseLsofCwds(stdout) {
  /** @type {Map<number, string>} */
  const map = new Map();
  let pid = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line) continue;
    const code = line[0];
    const value = line.slice(1);
    if (code === "p") {
      const n = Number(value);
      pid = Number.isInteger(n) && n > 0 ? n : null;
      continue;
    }
    if (code !== "n" || pid == null || !value) continue;
    map.set(pid, value);
  }
  return map;
}

/**
 * @param {string} name  lsof NAME field, e.g. `*:3000`, `127.0.0.1:5173`, `[::1]:80`
 * @returns {{ host: string, port: number } | null}
 */
function parseHostPort(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const bracket = raw.match(/^(\[[^\]]+\]):(\d+)$/);
  if (bracket) {
    const port = Number(bracket[2]);
    if (!isValidPort(port)) return null;
    return { host: bracket[1], port };
  }
  const colon = raw.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = raw.slice(0, colon);
  const port = Number(raw.slice(colon + 1));
  if (!host || !isValidPort(port)) return null;
  return { host, port };
}

/**
 * @param {number} port
 */
function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Wildcard bind → localhost. A specific interface keeps its host.
 *
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
function buildServerUrl(host, port) {
  if (isWildcardHost(host)) {
    return `http://localhost:${port}`;
  }
  let h = String(host);
  if (h.includes(":") && !h.startsWith("[")) {
    h = `[${h}]`;
  }
  return `http://${h}:${port}`;
}

/**
 * @param {string} host
 */
function isWildcardHost(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  return h === "*" || h === "0.0.0.0" || h === "::";
}

/**
 * Keep entries whose cwd is the root or a descendant.
 *
 * @param {string} cwd
 * @param {string} root
 * @returns {boolean}
 */
function cwdInsideRoot(cwd, root) {
  if (!cwd || !root) return false;
  return cwd === root || cwd.startsWith(root + path.sep);
}

/**
 * Filter listen entries to those whose pid cwd is under root, dedupe by port,
 * and attach a url. First occurrence of a port wins.
 *
 * @param {Array<{ pid: number, command: string, host: string, port: number }>} entries
 * @param {Map<number, string> | Record<string, string>} cwdByPid
 * @param {string} rootPath
 * @returns {Array<{ pid: number, command: string, host: string, port: number, url: string }>}
 */
function filterServersByRoot(entries, cwdByPid, rootPath) {
  const root = String(rootPath || "");
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const cwd =
      cwdByPid instanceof Map
        ? cwdByPid.get(entry.pid)
        : cwdByPid[entry.pid] ?? cwdByPid[String(entry.pid)];
    if (!cwdInsideRoot(cwd, root)) continue;
    if (seen.has(entry.port)) continue;
    seen.add(entry.port);
    out.push({
      pid: entry.pid,
      command: entry.command,
      host: entry.host,
      port: entry.port,
      url: buildServerUrl(entry.host, entry.port),
    });
  }
  return out;
}

/**
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runLsof(args) {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      args,
      {
        encoding: "utf8",
        timeout: LSOF_TIMEOUT_MS,
        maxBuffer: LSOF_MAX_BUFFER,
        env: process.env,
      },
      (err, stdout) => {
        if (err && err.code === "ENOENT") {
          resolve("");
          return;
        }
        const out =
          stdout != null && stdout !== ""
            ? stdout
            : err && err.stdout != null
              ? String(err.stdout)
              : "";
        resolve(String(out || ""));
      },
    );
  });
}

/**
 * Listening TCP processes whose cwd is `rootPath` or inside it.
 * Failures (missing lsof, permissions, spawn errors) resolve to [].
 * Results are cached per root for 5 seconds.
 *
 * @param {string} rootPath
 * @returns {Promise<Array<{ pid: number, command: string, host: string, port: number, url: string }>>}
 */
async function listLocalServers(rootPath) {
  try {
    const root = String(rootPath || "");
    if (!root) return [];
    const now = Date.now();
    const hit = cache.get(root);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return hit.value;
    }
    const listenOut = await runLsof([
      "-nP",
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fpcn",
    ]);
    const entries = parseLsofListen(listenOut);
    if (entries.length === 0) {
      cache.set(root, { at: now, value: [] });
      return [];
    }
    const pids = [...new Set(entries.map((e) => e.pid))];
    const cwdOut = await runLsof([
      "-a",
      "-p",
      pids.join(","),
      "-d",
      "cwd",
      "-Fn",
    ]);
    const value = filterServersByRoot(entries, parseLsofCwds(cwdOut), root);
    cache.set(root, { at: now, value });
    return value;
  } catch {
    return [];
  }
}

module.exports = {
  listLocalServers,
  parseLsofListen,
  parseLsofCwds,
  parseHostPort,
  buildServerUrl,
  cwdInsideRoot,
  filterServersByRoot,
};
