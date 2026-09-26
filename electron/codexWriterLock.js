"use strict";

/**
 * Codex thread-store single-writer locks (#1226).
 *
 * Isolation must not share `thread-writer-locks/` with ~/.codex: Desktop's
 * app-server holds flock there for hours. Existing overlays still symlink
 * that dir; skip-on-create is not enough — repair on materialize.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const LOCK_DIR = "thread-writer-locks";
const SESSION_RE =
  /thread\s+([0-9a-z][0-9a-z-]{15,})\s+already has an active writer/i;

/**
 * @param {string} dest overlay CODEX_HOME
 * @returns {string} real lock directory
 */
function ensurePrivateWriterLockDir(dest) {
  const root = path.resolve(String(dest || ""));
  if (!root) throw new Error("ensurePrivateWriterLockDir: dest required");
  const lockDest = path.join(root, LOCK_DIR);
  let st = null;
  try {
    st = fs.lstatSync(lockDest);
  } catch {
    st = null;
  }
  if (st && st.isSymbolicLink()) {
    fs.unlinkSync(lockDest);
    st = null;
  } else if (st && !st.isDirectory()) {
    fs.unlinkSync(lockDest);
    st = null;
  }
  if (!st) fs.mkdirSync(lockDest, { recursive: true });
  return lockDest;
}

/**
 * @param {string} codexHome
 * @param {string} sessionId
 */
function writerLockPath(codexHome, sessionId) {
  return path.join(String(codexHome || ""), LOCK_DIR, `${sessionId}.lock`);
}

/**
 * @param {unknown} text
 * @returns {string | null}
 */
function sessionIdFromWriterLock(text) {
  const m = String(text || "").match(SESSION_RE);
  return m ? m[1] : null;
}

/**
 * Parse `lsof -nP -Fpc -- <file>` into holders.
 * @param {string} stdout
 * @returns {Array<{ pid: number, command: string }>}
 */
function parseLsofHolders(stdout) {
  /** @type {Array<{ pid: number, command: string }>} */
  const holders = [];
  let pid = null;
  let command = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line) continue;
    const code = line[0];
    const value = line.slice(1);
    if (code === "p") {
      if (pid != null) holders.push({ pid, command });
      const n = Number(value);
      pid = Number.isInteger(n) && n > 0 ? n : null;
      command = "";
      continue;
    }
    if (code === "c") command = value;
  }
  if (pid != null) holders.push({ pid, command });
  return holders;
}

function defaultLsofFile(lockPath) {
  try {
    return execFileSync("lsof", ["-nP", "-Fpc", "--", lockPath], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.sessionId]
 * @param {string} [opts.errText]
 * @param {string} [opts.codexHome]
 * @param {Iterable<number> | Set<number>} [opts.ourPids]
 * @param {(lockPath: string) => string} [opts.lsofFile]
 */
function inspectWriterLock(opts) {
  const sessionId =
    String((opts && opts.sessionId) || "") ||
    sessionIdFromWriterLock(opts && opts.errText) ||
    "";
  const codexHome = String(
    (opts && opts.codexHome) ||
      process.env.CODEX_HOME ||
      path.join(os.homedir(), ".codex"),
  );
  const lockDir = path.join(codexHome, LOCK_DIR);
  const lockPath = sessionId ? writerLockPath(codexHome, sessionId) : lockDir;
  let lockDirShared = false;
  try {
    lockDirShared = fs.lstatSync(lockDir).isSymbolicLink();
  } catch {
    // missing is fine
  }
  const lsofFile = (opts && opts.lsofFile) || defaultLsofFile;
  const holders = sessionId ? parseLsofHolders(lsofFile(lockPath)) : [];
  const holder = holders[0] || null;
  const ourPids = new Set(opts && opts.ourPids ? opts.ourPids : []);
  const holderPid = holder ? holder.pid : null;
  // Private overlay lock dir is this Solenta thread's namespace. A holder
  // there is ours. A shared ~/.codex symlink may be Desktop — only kill
  // when the pid is a child we spawned.
  const ours =
    holderPid != null &&
    (ourPids.has(holderPid) || !lockDirShared);
  return {
    sessionId: sessionId || null,
    codexHome,
    lockDir,
    lockPath: sessionId ? lockPath : null,
    lockDirShared,
    holderPid,
    holderCommand: holder ? holder.command || null : null,
    ours,
    stale: Boolean(sessionId) && holderPid == null,
  };
}

/**
 * @param {ReturnType<typeof inspectWriterLock> | null | undefined} info
 */
function formatWriterLockDiagnosis(info) {
  if (!info) return "";
  const lines = [];
  if (info.lockDirShared) {
    lines.push(
      "Lock dir is a symlink onto ~/.codex; Desktop can block resume.",
    );
  }
  if (info.holderPid) {
    const who = info.ours
      ? "Solenta Codex child"
      : `${info.holderCommand || "other process"} — not a Solenta child`;
    const action = info.ours
      ? "Released it; send again."
      : "Quit that process, then send again.";
    lines.push(`Holder: pid ${info.holderPid} (${who}). ${action}`);
  } else if (info.stale) {
    lines.push(
      "No process holds the lock file (stale). Send again; the session was kept.",
    );
  }
  if (info.codexHome) lines.push(`CODEX_HOME=${info.codexHome}`);
  if (info.lockPath) lines.push(`lock=${info.lockPath}`);
  return lines.join("\n");
}

/**
 * @param {{ ours?: boolean, holderPid?: number | null } | null | undefined} info
 * @param {(pid: number) => void} killPid
 */
function releaseWriterLockHolder(info, killPid) {
  if (!info || !info.ours || !info.holderPid) return false;
  const pid = Number(info.holderPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  killPid(pid);
  return true;
}

/**
 * SIGTERM the process group, then SIGKILL. Never our own pid.
 * Win32 goes through signalPid so a `.cmd` grandchild is included.
 * @param {number} pid
 */
function killPidTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  if (n === process.pid) return;
  const { signalPid } = require("./proc.js");
  signalPid(n, "SIGTERM");
  const timer = setTimeout(() => {
    signalPid(n, "SIGKILL");
  }, 3000);
  if (typeof timer.unref === "function") timer.unref();
}

module.exports = {
  LOCK_DIR,
  ensurePrivateWriterLockDir,
  writerLockPath,
  sessionIdFromWriterLock,
  parseLsofHolders,
  inspectWriterLock,
  formatWriterLockDiagnosis,
  releaseWriterLockHolder,
  killPidTree,
};
