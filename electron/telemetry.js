"use strict";
/**
 * Anonymous daily usage ping, for the Solenta team only (no in-app surface).
 * Sends a random install id, app version, OS, arch and which agent providers
 * were used in the last 30 days. No paths, prompts, repo names or usernames;
 * the server does not store the IP. Totals show on the private
 * stats.solenta.app dashboard (stats-api/).
 *
 * Off when DO_NOT_TRACK=1 or SOLENTA_TELEMETRY=0, and in unpackaged dev runs.
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const ENDPOINT =
  process.env.SOLENTA_PING_URL || "https://stats.solenta.app/ping";
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_FILE = "install-id";

/** @param {NodeJS.ProcessEnv} env */
function telemetryDisabled(env) {
  return env.DO_NOT_TRACK === "1" || env.SOLENTA_TELEMETRY === "0";
}

/** @param {string} userData */
function installId(userData) {
  const file = path.join(userData, ID_FILE);
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    // First launch.
  }
  const id = randomUUID();
  fs.writeFileSync(file, id);
  return id;
}

/**
 * Provider ids (instance suffix stripped) of threads touched in 30 days.
 * @param {Array<{provider?: string, updatedAt?: number}>} threads
 * @param {number} now
 */
function recentProviders(threads, now) {
  const set = new Set();
  for (const t of threads || []) {
    if (t && t.provider && (t.updatedAt || 0) > now - 30 * DAY_MS) {
      set.add(String(t.provider).split(":")[0]);
    }
  }
  return [...set].sort();
}

/**
 * @param {{userData: string, version: string, getThreads: () => any[],
 *   fetch?: typeof fetch, now?: () => number}} opts
 */
async function sendPing(opts) {
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now ? opts.now() : Date.now();
  await doFetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installId: installId(opts.userData),
      version: opts.version,
      platform: process.platform,
      arch: process.arch,
      providers: recentProviders(opts.getThreads(), now),
    }),
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * First ping a minute after boot, then daily. Unref'd: never keeps the app up.
 * Failures are silent; the next tick retries.
 * @param {Parameters<typeof sendPing>[0]} opts
 */
function startTelemetry(opts) {
  if (telemetryDisabled(process.env)) return;
  const tick = () => sendPing(opts).catch(() => {});
  setTimeout(tick, 60_000).unref();
  setInterval(tick, DAY_MS).unref();
}

module.exports = {
  ENDPOINT,
  telemetryDisabled,
  installId,
  recentProviders,
  sendPing,
  startTelemetry,
};
