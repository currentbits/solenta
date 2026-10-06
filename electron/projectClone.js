"use strict";

/**
 * Add project from a URL (#1506 H3): `git clone` into a chosen folder with
 * live progress on "clone:progress" and a cancel, then the usual add.
 *
 * Only https:// and ssh (ssh:// or user@host:path) URLs: other transports
 * (file://, ext::, plain paths) can read local files or run commands.
 * The target must be missing or an empty folder; whatever this clone
 * created is removed again on failure or cancel.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { expandUserPath } = require("./fsBrowse.js");
const { killTree } = require("./proc.js");

/** Progress pushes at most this often; git rewrites its line many times a second. */
const PROGRESS_THROTTLE_MS = 100;

/** @type {Map<string, { cancel: () => void }>} */
const active = new Map();

let spawnFn = spawn;

/**
 * Test hook: swap the spawner. Pass null to restore.
 * @param {typeof spawn | null} fn
 */
function setCloneSpawnFn(fn) {
  spawnFn = typeof fn === "function" ? fn : spawn;
}

/**
 * Why `url` is not cloneable here, or null when it is.
 * @param {unknown} url
 * @returns {string | null}
 */
function cloneUrlError(url) {
  const u = typeof url === "string" ? url.trim() : "";
  if (!u) return "Repository URL is required";
  if (/\s/.test(u)) return "Repository URL cannot contain spaces";
  if (/^https:\/\/[^/\s]+\/.+/i.test(u) || /^ssh:\/\/[^/\s]+\/.+/i.test(u)) {
    return null;
  }
  // scp-like ssh: user@host:path. The user part is required so a Windows
  // drive path or a bare "host:path" local name is never taken for ssh.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\s].*/.test(u)) return null;
  return "Use an https:// or ssh URL (for example git@github.com:owner/repo.git)";
}

/**
 * Folder name git would pick: last path segment without `.git`.
 * @param {string} url
 */
function repoNameFromUrl(url) {
  const tail = String(url)
    .trim()
    .replace(/[/\\]+$/, "")
    .split(/[/:]/)
    .pop();
  return String(tail || "").replace(/\.git$/i, "");
}

/**
 * Last progress line from a stderr chunk ("Receiving objects:  42% ...").
 * @param {string} text
 */
function lastLine(text) {
  const lines = String(text)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * Clone and add. Resolves the added ProjectInfo; rejects with git's last
 * stderr lines on failure, or "Clone cancelled".
 *
 * @param {{
 *   url?: string,
 *   parentDir?: string,
 *   name?: string,
 *   cloneId?: string,
 * }} input
 * @param {{
 *   addProject: (target: string) => Promise<unknown>,
 *   broadcast?: (channel: string, payload: unknown) => void,
 * }} deps
 */
async function cloneProject(input, deps) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const urlErr = cloneUrlError(url);
  if (urlErr) throw new Error(urlErr);
  const parentDir =
    typeof input.parentDir === "string" ? input.parentDir.trim() : "";
  if (!parentDir) throw new Error("Location is required");
  const name =
    (typeof input.name === "string" && input.name.trim()) ||
    repoNameFromUrl(url);
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new Error("Folder name must be a plain folder name (no slashes)");
  }
  const parent = path.resolve(expandUserPath(parentDir));
  let stat;
  try {
    stat = fs.statSync(parent);
  } catch {
    throw new Error(`Path does not exist: ${parent}`);
  }
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${parent}`);

  const target = path.join(parent, name);
  const existed = fs.existsSync(target);
  if (existed) {
    let entries;
    try {
      entries = fs.readdirSync(target);
    } catch {
      throw new Error(`Already exists and is not a folder: ${target}`);
    }
    if (entries.length) {
      throw new Error(`Folder is not empty: ${target}`);
    }
  }

  const cloneId = typeof input.cloneId === "string" ? input.cloneId : "";
  const broadcast = deps.broadcast;
  const push = (/** @type {Record<string, unknown>} */ extra) => {
    if (cloneId && typeof broadcast === "function") {
      broadcast("clone:progress", { cloneId, ...extra });
    }
  };
  const cleanup = () => {
    try {
      if (existed) {
        for (const e of fs.readdirSync(target)) {
          fs.rmSync(path.join(target, e), { recursive: true, force: true });
        }
      } else {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // best effort: a half clone left behind is visible, not dangerous
    }
  };

  await new Promise((resolve, reject) => {
    const child = spawnFn("git", ["clone", "--progress", "--", url, target], {
      // No hidden credential prompt: fail fast with git's own message.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let cancelled = false;
    let tail = "";
    let lastPush = 0;
    if (cloneId) {
      active.set(cloneId, {
        cancel() {
          cancelled = true;
          killTree(child, 2000);
        },
      });
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (/** @type {string} */ chunk) => {
      tail = (tail + chunk).slice(-4000);
      const now = Date.now();
      if (now - lastPush < PROGRESS_THROTTLE_MS) return;
      lastPush = now;
      const line = lastLine(chunk);
      if (line) push({ line });
    });
    child.on("error", (err) => {
      if (cloneId) active.delete(cloneId);
      cleanup();
      reject(new Error(`Could not run git: ${err.message}`));
    });
    child.on("close", (code) => {
      if (cloneId) active.delete(cloneId);
      if (cancelled) {
        cleanup();
        reject(new Error("Clone cancelled"));
      } else if (code !== 0) {
        cleanup();
        const why = tail
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter((l) => l && !/^(Cloning into|remote: (Counting|Compressing|Enumerating))/.test(l))
          .slice(-3)
          .join("\n");
        reject(new Error(why || `git clone exited with code ${code}`));
      } else {
        resolve(null);
      }
    });
  });

  push({ line: "Adding project" });
  return deps.addProject(target);
}

/**
 * Stop an in-flight clone. Unknown / finished ids are a no-op.
 * @param {{ cloneId?: string }} input
 */
function cancelClone(input) {
  const id = input && typeof input.cloneId === "string" ? input.cloneId : "";
  const job = active.get(id);
  if (job) job.cancel();
}

module.exports = {
  cloneProject,
  cancelClone,
  cloneUrlError,
  repoNameFromUrl,
  setCloneSpawnFn,
};
