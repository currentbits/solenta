"use strict";

// Git exec seam (setExecFile), git read caches, WSL path wrapping and shared git helpers.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { execCommand, wrapCommand, SYNC_TIMEOUT_MS } = require("./ssh.js");
const { pathSide, isWindowsMount, wslTarget, buildWslCommand } = require("./wsl.js");

/** @type {typeof execFile} */
let execFileImpl = execFile;

/**
 * Test hook: swap async execFile (hot git reads) for a fake spawn.
 * Pass null/undefined to restore the real implementation.
 * @param {typeof execFile | null | undefined} fn
 */
function setExecFile(fn) {
  execFileImpl = typeof fn === "function" ? fn : execFile;
}

const PATCH_TRUNCATE = 100_000;

/**
 * The one git wrap for a path. A WSL UNC cwd means git must run *inside*
 * the distro at that path — Windows git over 9p is the slow/broken case
 * the boundary rule exists to prevent. Off win32 this is a no-op so macOS
 * and Linux stay byte-for-byte unchanged.
 *
 * Args that are themselves WSL UNCs (worktree add/remove) are rewritten to
 * the linux path git inside the distro can address.
 *
 * No file watcher lives in this process: status/diff are on-demand and PR
 * refresh is interval-polled. inotify would not cross the boundary anyway;
 * a future watcher must poll when the target is WSL-side.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 * @returns {{ bin: string, args: string[], cwd?: string }}
 */
function resolveGitCommand(cwd, args, platform = process.platform) {
  const argv = Array.isArray(args) ? args : [];
  const side = pathSide(cwd, platform);
  if (side.side !== "wsl") {
    return { bin: "git", args: argv, cwd };
  }
  const linuxArgs = argv.map((a) => {
    const s = pathSide(typeof a === "string" ? a : "", platform);
    return s.side === "wsl" ? s.linuxPath : a;
  });
  const cmd = buildWslCommand(side.distro, side.linuxPath, ["git", ...linuxArgs]);
  return { bin: cmd.bin, args: cmd.args };
}

/**
 * Turn a linux path inside a distro back into the same UNC flavour the
 * project used (\\wsl$ vs \\wsl.localhost), so Windows-side existsSync
 * and later pathSide() still recognise it.
 * @param {string} projectPath
 * @param {string} linuxPath
 */
function linuxPathToUnc(projectPath, linuxPath) {
  const m = String(projectPath).match(/^(\\\\wsl(?:\$|\.localhost)\\[^\\]+)/i);
  const prefix = m ? m[1] : "\\\\wsl$\\unknown";
  const rest = String(linuxPath).replace(/^\/+/, "").replace(/\//g, "\\");
  return `${prefix}\\${rest}`;
}

/**
 * Where a thread worktree should live.
 *
 * Non-WSL: `<worktreeBase>/<threadId>` — today's userData path, unchanged.
 *
 * WSL-side: next to the repo, inside the distro
 * (`<repoParent>/.solenta/worktrees/<threadId>`). userData is a Windows
 * path; `git worktree add` running via wsl.exe --cd cannot address a UNC
 * or /mnt/<drive>, and crossing the boundary is the slow/no-inotify case.
 * Same-filesystem as the repo is also what git worktree wants. If the
 * repo itself lives on /mnt/<drive>, park under /tmp/solenta-worktrees
 * so we still land on real ext4.
 *
 * `dir` is what we store as worktreePath (a UNC Windows can still see).
 * `addPath` is the argument `git worktree add` must receive (linux).
 *
 * GC enumerates these WSL roots too (worktreeRoots in worktrees-gc.js).
 *
 * @param {{ path?: string, remoteHost?: string } | null | undefined} project
 * @param {string} worktreeBase
 * @param {string} threadId
 * @param {NodeJS.Platform} [platform]
 * @returns {{ dir: string, addPath: string }}
 */
function resolveWorktreeDir(project, worktreeBase, threadId, platform = process.platform) {
  const wsl = wslTarget(project, platform);
  if (!wsl) {
    const dir = path.join(worktreeBase, threadId);
    return { dir, addPath: dir };
  }
  let linuxDir = path.posix.join(
    path.posix.dirname(wsl.linuxPath),
    ".solenta",
    "worktrees",
    threadId,
  );
  if (isWindowsMount(linuxDir) || isWindowsMount(wsl.linuxPath)) {
    linuxDir = path.posix.join("/tmp", "solenta-worktrees", threadId);
  }
  if (isWindowsMount(linuxDir)) {
    throw new Error(
      "Worktree path resolved onto a Windows mount; refusing to cross the WSL boundary",
    );
  }
  return { dir: linuxPathToUnc(project.path, linuxDir), addPath: linuxDir };
}

/**
 * Base for NEW non-WSL worktrees (#1531): settings.worktreeRoot when it is
 * still a directory, else the default `worktreeBase`. Existing threads keep
 * the worktreePath they were created with.
 * @param {{ getSettings?: () => { worktreeRoot?: string | null } } | null | undefined} store
 * @param {string} worktreeBase
 * @returns {string}
 */
function effectiveWorktreeBase(store, worktreeBase) {
  const root = store && store.getSettings ? store.getSettings().worktreeRoot : null;
  if (!root) return worktreeBase;
  try {
    if (fs.statSync(root).isDirectory()) return root;
  } catch {
    // Unmounted volume or deleted folder: fall back rather than fail the run.
  }
  console.warn(`worktree location ${root} is unavailable; using ${worktreeBase}`);
  return worktreeBase;
}

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Idle git-status coalescing (#688). A completion-callback re-arm (header
 * git.diff, overlapping gcScan) was spawning ~65 `git status --porcelain
 * -uall`/s. Inflight shares one spawn; TTL absorbs the sequential re-arm.
 * Destructive paths (checkpoint, orphan sweep, gcClean) pass ttl 0.
 */
const GIT_READ_TTL_MS = 2_000;
const nowMs = () => Date.now();
/** @type {Map<string, { at: number, result?: unknown, pending: Promise<unknown> | null }>} */
const diffByCwd = new Map();
/** @type {Map<string, { at: number, result?: unknown, pending: Promise<unknown> | null }>} */
const inspectByDir = new Map();

function resetGitReadCaches() {
  diffByCwd.clear();
  inspectByDir.clear();
}

function invalidateGitReads(cwd) {
  if (!cwd) {
    resetGitReadCaches();
    return;
  }
  const key = path.resolve(String(cwd));
  diffByCwd.delete(key);
  inspectByDir.delete(key);
}

/**
 * @template T
 * @param {Map<string, { at: number, result?: T, pending: Promise<T> | null }>} map
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} produce
 * @returns {Promise<T>}
 */
function cachedRead(map, key, ttlMs, produce) {
  const hit = map.get(key);
  const t = nowMs();
  if (ttlMs > 0 && hit && hit.result !== undefined && !hit.pending && t - hit.at < ttlMs) {
    return Promise.resolve(hit.result);
  }
  if (hit && hit.pending) return hit.pending;
  const pending = Promise.resolve()
    .then(produce)
    .then((result) => {
      map.set(key, { at: nowMs(), result, pending: null });
      return result;
    })
    .catch((err) => {
      const cur = map.get(key);
      if (cur && cur.pending === pending) map.delete(key);
      throw err;
    });
  map.set(key, { at: t, result: hit ? hit.result : undefined, pending });
  return pending;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean }} [opts] - raw skips trimming (porcelain output
 *   carries a significant leading space in its XY status column)
 * @returns {string}
 */
function gitOut(cwd, args, opts) {
  // ponytail: worktree write paths (setup/merge/push/commit/revert/cleanup)
  // stay sync — they fire once per click and are already bounded at 15s by #88.
  // Every read path, PR paths included, uses the Async pair (#228). Ceiling: a
  // slow local repo still stalls the UI for one click; convert only if the
  // CODER_LOOP_LAG probe puts a click path in p99.
  // execCommand, not execFileSync: it owns the default timeout that keeps a
  // hung git off the main-process event loop.
  const cmd = resolveGitCommand(cwd, args);
  const execOpts = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  };
  if (cmd.cwd) execOpts.cwd = cmd.cwd;
  const raw = execCommand(null, cmd.bin, cmd.args, execOpts);
  const out = raw == null ? "" : String(raw);
  return opts && opts.raw ? out : out.trim();
}

/**
 * Run git without throwing. Returns { ok, stdout, stderr, combined }.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean, env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 */
function gitTry(cwd, args, opts) {
  try {
    /** @type {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} */
    const execOpts = {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
    };
    if (opts && opts.env) {
      execOpts.env = { ...process.env, ...opts.env };
    }
    if (opts && opts.timeout != null) {
      execOpts.timeout = opts.timeout;
    }
    const cmd = resolveGitCommand(cwd, args);
    if (cmd.cwd) execOpts.cwd = cmd.cwd;
    else delete execOpts.cwd;
    // execCommand defaults the timeout when the caller did not set one.
    const raw = execCommand(null, cmd.bin, cmd.args, execOpts);
    const out = raw == null ? "" : String(raw);
    const stdout = opts && opts.raw ? out : out.trim();
    return { ok: true, stdout, stderr: "", combined: stdout };
  } catch (err) {
    const stdout = err && err.stdout != null ? String(err.stdout) : "";
    const stderr = err && err.stderr != null ? String(err.stderr) : "";
    const msg = err && err.message ? String(err.message) : String(err);
    const timedOut =
      (err && err.code === "ETIMEDOUT") ||
      (err && err.killed && /ETIMEDOUT|timed out/i.test(msg));
    const combined = [stdout, stderr, msg].filter(Boolean).join("\n");
    return {
      ok: false,
      stdout,
      stderr,
      combined,
      error: err,
      timedOut: Boolean(timedOut),
    };
  }
}

/**
 * Async gitOut. Never blocks the Electron main process.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
function gitOutAsync(cwd, args, opts) {
  return gitExecThrowAsync(null, cwd, args, opts);
}

/**
 * gitOut for the diff path: prefix git with ssh when the project is remote.
 * WSL-side cwds wrap inside gitOut via resolveGitCommand. Other worktrees
 * operations stay local (worktrees/PRs are out of scope on remotes).
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} project
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
function gitOutForDiffAsync(project, cwd, args, opts) {
  if (project && project.remoteHost) {
    return gitExecThrowAsync(project, cwd, args, opts);
  }
  return gitOutAsync(cwd, args, opts);
}

/**
 * execFile through wrapCommand. Drops cwd on remotes (same as execCommand).
 * Throws on failure so callers match gitOut / gitOutForDiffAsync.
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} project
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ raw?: boolean, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
function gitExecThrowAsync(project, cwd, args, opts) {
  const timeout =
    opts && opts.timeout != null ? opts.timeout : SYNC_TIMEOUT_MS;
  /** @type {import("node:child_process").ExecFileOptionsWithStringEncoding} */
  const execOpts = {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  };
  let cmd;
  if (project && project.remoteHost) {
    cmd = wrapCommand(project, "git", args);
  } else {
    cmd = resolveGitCommand(cwd, args);
    if (cmd.cwd) execOpts.cwd = cmd.cwd;
  }
  return new Promise((resolve, reject) => {
    execFileImpl(cmd.bin, cmd.args, execOpts, (err, stdout, stderr) => {
      if (err) {
        if (err.stdout == null && stdout != null) err.stdout = stdout;
        if (err.stderr == null && stderr != null) err.stderr = stderr;
        reject(err);
        return;
      }
      const out = stdout == null ? "" : String(stdout);
      resolve(opts && opts.raw ? out : out.trim());
    });
  });
}

/**
 * git output (one path per line) as a trimmed, non-empty list.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Verbatim git failure text. Prefer stderr (what the user needs to see);
 * fall back to stdout, then the Error message. Never first-line-only.
 * @param {any} err
 * @returns {string}
 */
function gitFailureText(err) {
  if (!err) return "unknown git error";
  const stderr = err.stderr != null ? String(err.stderr).trim() : "";
  if (stderr) return stderr;
  const stdout = err.stdout != null ? String(err.stdout).trim() : "";
  if (stdout) return stdout;
  return String(err.message || err).trim() || "unknown git error";
}

/**
 * Tail-trim stderr/combined the same way push does (last 300 chars).
 * @param {string} errText
 * @param {string} fallback
 * @returns {string}
 */
function tailErr(errText, fallback) {
  const t = String(errText || "").trim();
  if (!t) return fallback;
  return t.length <= 300 ? t : t.slice(-300);
}

const CHECKPOINT_GIT_TIMEOUT_MS = 30_000;

/**
 * Async git. Never blocks the Electron main process (round-47 discipline).
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeout?: number, env?: NodeJS.ProcessEnv, raw?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, combined: string, error?: any, timedOut?: boolean }>}
 */
function gitTryAsync(cwd, args, opts) {
  const timeout =
    opts && opts.timeout != null ? opts.timeout : CHECKPOINT_GIT_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...(opts && opts.env ? opts.env : {}),
    GIT_TERMINAL_PROMPT: "0",
  };
  const cmd = resolveGitCommand(cwd, args);
  /** @type {import("node:child_process").ExecFileOptionsWithStringEncoding} */
  const execOpts = {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    timeout,
    env,
  };
  if (cmd.cwd) execOpts.cwd = cmd.cwd;
  return new Promise((resolve) => {
    execFileImpl(
      cmd.bin,
      cmd.args,
      execOpts,
      (err, stdout, stderr) => {
        if (!err) {
          const out = opts && opts.raw ? String(stdout || "") : String(stdout || "").trim();
          resolve({ ok: true, stdout: out, stderr: "", combined: out });
          return;
        }
        const out = err && err.stdout != null ? String(err.stdout) : String(stdout || "");
        const errText =
          err && err.stderr != null ? String(err.stderr) : String(stderr || "");
        const msg = err && err.message ? String(err.message) : String(err);
        // execFileSync sets code=ETIMEDOUT; async execFile kills with
        // SIGTERM and leaves code=null. Both are a timeout.
        const timedOut =
          (err && err.code === "ETIMEDOUT") ||
          (err && err.killed && /ETIMEDOUT|timed out/i.test(msg)) ||
          (err && err.killed && err.signal != null && err.code == null);
        resolve({
          ok: false,
          stdout: out,
          stderr: errText,
          combined: [out, errText, msg].filter(Boolean).join("\n"),
          error: err,
          timedOut: Boolean(timedOut),
        });
      },
    );
  });
}

/**
 * Disk size of a worktree dir via `du -sk`. Never walks the tree in JS.
 * Failed du → 0 so a scan never rejects.
 * @param {string} dir
 * @returns {Promise<number>}
 */
function duBytes(dir) {
  return new Promise((resolve) => {
    execFileImpl(
      "du",
      ["-sk", dir],
      { encoding: "utf8", timeout: 30_000, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          resolve(0);
          return;
        }
        const kb = parseInt(String(stdout || "").trim().split(/\s+/)[0], 10);
        resolve(Number.isFinite(kb) && kb >= 0 ? kb * 1024 : 0);
      },
    );
  });
}

module.exports = {
  setExecFile,
  PATCH_TRUNCATE,
  resolveGitCommand,
  linuxPathToUnc,
  resolveWorktreeDir,
  effectiveWorktreeBase,
  GIT_MAX_BUFFER,
  GIT_READ_TTL_MS,
  diffByCwd,
  inspectByDir,
  resetGitReadCaches,
  invalidateGitReads,
  cachedRead,
  gitOut,
  gitTry,
  gitOutAsync,
  gitOutForDiffAsync,
  splitLines,
  gitFailureText,
  tailErr,
  gitTryAsync,
  duBytes,
};
