"use strict";

/**
 * Kernel-side Seatbelt denials (#803). Every deny rule seatbelt.js compiles
 * carries `(with message "solenta:<threadId>")`, and macOS logs each denial
 * as `Sandbox: proc(pid) deny(1) op target\nsolenta:<threadId>`. One
 * `log stream` child follows those lines for the app's life once any run is
 * wrapped; a denial is reported once per (thread, op, target) per window.
 */

const { spawn } = require("node:child_process");

const DEDUPE_MS = 10_000;
const LINE =
  /^Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: ([^\n]*))?\nsolenta:(\S+)/;

/**
 * @typedef {{ threadId: string, process: string, pid: number, op: string, target: string }} Denial
 */

/**
 * Parse one `log stream --style ndjson` line. null for anything else
 * (the "Filtering…" banner, duplicate-report summaries, other sandboxes).
 * @param {string} line
 * @returns {Denial | null}
 */
function parseDenial(line) {
  let msg;
  try {
    msg = JSON.parse(line).eventMessage;
  } catch {
    return null;
  }
  const m = typeof msg === "string" ? LINE.exec(msg) : null;
  if (!m) return null;
  return {
    process: m[1],
    pid: Number(m[2]),
    op: m[3],
    target: (m[4] || "").trim(),
    threadId: m[5],
  };
}

/** @type {import("node:child_process").ChildProcess | null} */
let child = null;
/** @type {Set<(d: Denial) => void>} */
const listeners = new Set();
const recent = new Map();

/**
 * Subscribe to denials; starts the shared watcher on first use.
 * @param {(d: Denial) => void} fn
 * @param {{ spawnFn?: typeof spawn, log?: (msg: string) => void, now?: () => number }} [opts]
 */
function watchDenials(fn, opts = {}) {
  listeners.add(fn);
  if (child) return () => listeners.delete(fn);
  const now = opts.now || Date.now;
  const warn = opts.log || ((m) => console.warn(m));
  try {
    child = (opts.spawnFn || spawn)(
      "/usr/bin/log",
      [
        "stream",
        "--style",
        "ndjson",
        "--predicate",
        'sender == "Sandbox" AND eventMessage CONTAINS "solenta:"',
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (err) {
    // Enforcement is the kernel's; only the audit trail has a gap.
    warn(`seatbelt: cannot follow denials (${err && err.message})`);
    child = null;
    return () => listeners.delete(fn);
  }
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const d = parseDenial(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (!d) continue;
      const key = `${d.threadId}\0${d.op}\0${d.target}`;
      const t = now();
      if (t - (recent.get(key) || 0) < DEDUPE_MS) continue;
      recent.set(key, t);
      if (recent.size > 500) recent.clear();
      for (const l of listeners) {
        try {
          l(d);
        } catch {
          /* one listener must not starve the rest */
        }
      }
    }
  });
  child.on("error", (err) => {
    warn(`seatbelt: log stream failed (${err && err.message})`);
    child = null;
  });
  child.on("exit", () => {
    child = null;
  });
  child.unref();
  if (child.stdout.unref) child.stdout.unref();
  return () => listeners.delete(fn);
}

function stopWatching() {
  if (child) child.kill();
  child = null;
  listeners.clear();
  recent.clear();
}

module.exports = { parseDenial, watchDenials, stopWatching };
