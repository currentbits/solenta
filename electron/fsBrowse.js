"use strict";

/**
 * Environment-scoped directory listing for add-project (#609) and the
 * clone destination step (#459). Local readdir, or ls over SSH when
 * `environment` is a user@host. Empty / `~` / `~/` also prepends a
 * bounded frecency list of already-added project paths.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execCommandAsync } = require("./ssh.js");

const FRECENCY_LIMIT = 8;
const ENTRY_CAP = 200;

/**
 * Expand `~` / `~/…` against the given home directory (local homedir by
 * default). A bare `~user` is left alone — we only expand the current user.
 * @param {string} raw
 * @param {string} [home]
 */
function expandUserPath(raw, home) {
  const value = String(raw ?? "");
  const base = home || os.homedir();
  if (value === "~") return base;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(base, value.slice(2));
  }
  return value;
}

function isWindowsDrivePath(value) {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

function isUncPath(value) {
  return value.startsWith("\\\\");
}

function isWindowsAbsolutePath(value) {
  return isUncPath(value) || isWindowsDrivePath(value);
}

function isExplicitRelativePath(value) {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function endsWithSeparator(value) {
  return /[\\/]$/.test(value) || value === "~";
}

function isEmptyBrowseQuery(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" || trimmed === "~" || trimmed === "~/" || trimmed === "~\\";
}

/**
 * @param {string} raw
 * @param {{ cwd?: string | null, home?: string, platform?: NodeJS.Platform }} [opts]
 */
function resolveBrowseTarget(raw, opts) {
  const platform = opts && opts.platform ? opts.platform : process.platform;
  const input = String(raw ?? "").trim();
  if (isWindowsAbsolutePath(input) && platform !== "win32") {
    const err = new Error(
      "Windows-style paths are only supported on Windows environments.",
    );
    err.code = "windows_path_unsupported";
    throw err;
  }
  if (isExplicitRelativePath(input)) {
    const cwd = opts && opts.cwd ? String(opts.cwd) : "";
    if (!cwd) {
      const err = new Error(
        "Relative paths require an active project in this environment.",
      );
      err.code = "current_project_required";
      throw err;
    }
    return path.resolve(expandUserPath(cwd, opts && opts.home), input);
  }
  const expanded = expandUserPath(input || "~", opts && opts.home);
  return path.resolve(expanded);
}

/**
 * Directory entries that are directories, including symlink-to-dir.
 * Matches the skill-dir rule: dirent.isDirectory() is false for a symlink.
 * @param {string} dir
 * @param {string} [prefix]
 */
function listLocalDirectories(dir, prefix) {
  /** @type {Array<{ name: string, fullPath: string }>} */
  const entries = [];
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = err && err.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { existed: false, entries };
    if (code === "EACCES" || code === "EPERM") return { existed: true, entries };
    throw err;
  }
  const lowerPrefix = (prefix || "").toLowerCase();
  for (const d of dirents) {
    if (entries.length >= ENTRY_CAP) break;
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    if (lowerPrefix && !d.name.toLowerCase().startsWith(lowerPrefix)) continue;
    const fullPath = path.join(dir, d.name);
    if (d.isSymbolicLink()) {
      try {
        if (!fs.statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    entries.push({ name: d.name, fullPath });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { existed: true, entries };
}

/**
 * @param {string} stdout
 * @param {string} parentPath
 * @param {string} [prefix]
 */
function parseLsDirectories(stdout, parentPath, prefix) {
  const lowerPrefix = (prefix || "").toLowerCase();
  /** @type {Array<{ name: string, fullPath: string }>} */
  const entries = [];
  const posix = parentPath.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (entries.length >= ENTRY_CAP) break;
    const raw = line.trim();
    if (!raw.endsWith("/")) continue;
    const name = raw.replace(/\/+$/, "");
    if (!name || name === "." || name === "..") continue;
    if (lowerPrefix && !name.toLowerCase().startsWith(lowerPrefix)) continue;
    const fullPath = posix === "/" ? `/${name}` : `${posix}/${name}`;
    entries.push({ name, fullPath });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * @param {import('./store').Store | null | undefined} store
 * @param {string | null | undefined} environment
 */
function recentProjectEntries(store, environment) {
  if (!store || typeof store.getProjects !== "function") return [];
  const host = environment ? String(environment).trim() : "";
  const projects = store.getProjects().slice().reverse();
  /** @type {Array<{ name: string, fullPath: string, recent: true }>} */
  const out = [];
  const seen = new Set();
  for (const project of projects) {
    if (out.length >= FRECENCY_LIMIT) break;
    const projectHost = project && project.remoteHost ? String(project.remoteHost).trim() : "";
    if (host) {
      if (projectHost !== host) continue;
    } else if (projectHost) {
      continue;
    }
    const fullPath = host
      ? String(project.remotePath || project.path || "")
      : String(project.path || "");
    if (!fullPath) continue;
    const key = fullPath.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = path.basename(fullPath.replace(/[\\/]+$/, "")) || fullPath;
    out.push({ name, fullPath, recent: true });
  }
  return out;
}

/**
 * List directories at `input.path` on `input.environment` (local or SSH).
 * @param {{
 *   store?: import('./store').Store,
 *   path?: string,
 *   environment?: string | null,
 *   cwd?: string | null,
 *   home?: string,
 *   platform?: NodeJS.Platform,
 * }} input
 */
async function browseFilesystem(input) {
  const raw = input && input.path != null ? String(input.path) : "";
  const environment =
    input && input.environment ? String(input.environment).trim() : "";
  const cwd = input && input.cwd ? String(input.cwd) : "";
  const platform = input && input.platform ? input.platform : process.platform;
  const emptyQuery = isEmptyBrowseQuery(raw);
  const recent = emptyQuery
    ? recentProjectEntries(input && input.store, environment || null)
    : [];

  if (environment) {
    let home = input && input.home;
    if (!home && (emptyQuery || raw.trim().startsWith("~"))) {
      try {
        home = String(
          await execCommandAsync(
            { remoteHost: environment, remotePath: "/" },
            "printenv",
            ["HOME"],
            { encoding: "utf8" },
          ),
        ).trim();
      } catch {
        home = "/";
      }
    }
    const resolved = resolveBrowseTarget(emptyQuery ? "~" : raw, {
      cwd,
      home,
      platform,
    });
    const listDir = endsWithSeparator(raw) || emptyQuery || raw.trim() === "~"
      ? resolved
      : path.posix.dirname(resolved.replace(/\\/g, "/"));
    const prefix = endsWithSeparator(raw) || emptyQuery || raw.trim() === "~"
      ? ""
      : path.posix.basename(resolved.replace(/\\/g, "/"));
    let stdout = "";
    let existed = true;
    try {
      stdout = String(
        await execCommandAsync(
          { remoteHost: environment, remotePath: listDir },
          "ls",
          ["-1", "-p", "-A"],
          { encoding: "utf8" },
        ),
      );
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      if (/No such file|not a directory|ENOENT/i.test(msg)) {
        existed = false;
      } else if (/Permission denied|EACCES/i.test(msg)) {
        existed = true;
      } else {
        throw new Error(`Failed to browse ${listDir} on ${environment}: ${msg}`);
      }
    }
    const entries = existed ? parseLsDirectories(stdout, listDir, prefix) : [];
    return {
      parentPath: listDir,
      entries: mergeRecent(recent, entries),
      existed,
    };
  }

  const resolved = resolveBrowseTarget(emptyQuery ? "~" : raw, {
    cwd,
    home: input && input.home,
    platform,
  });
  const listDir =
    endsWithSeparator(raw) || emptyQuery || raw.trim() === "~"
      ? resolved
      : path.dirname(resolved);
  const prefix =
    endsWithSeparator(raw) || emptyQuery || raw.trim() === "~"
      ? ""
      : path.basename(resolved);
  const listed = listLocalDirectories(listDir, prefix);
  return {
    parentPath: listDir,
    entries: mergeRecent(recent, listed.entries),
    existed: listed.existed,
  };
}

/**
 * @param {Array<{ name: string, fullPath: string, recent?: boolean }>} recent
 * @param {Array<{ name: string, fullPath: string }>} entries
 */
function mergeRecent(recent, entries) {
  if (recent.length === 0) return entries;
  const seen = new Set(
    entries.map((e) => e.fullPath.replace(/[\\/]+$/, "").toLowerCase()),
  );
  const extra = recent.filter(
    (e) => !seen.has(e.fullPath.replace(/[\\/]+$/, "").toLowerCase()),
  );
  return extra.concat(entries).slice(0, ENTRY_CAP);
}

module.exports = {
  FRECENCY_LIMIT,
  ENTRY_CAP,
  expandUserPath,
  resolveBrowseTarget,
  browseFilesystem,
  listLocalDirectories,
};
