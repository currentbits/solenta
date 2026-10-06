"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { walkClaudeSessions } = require("./cli-sessions-claude.js");
const { resolveCodexHome, walkCodexRollouts } = require("./cli-sessions-codex.js");
const { walkGrokSessions } = require("./cli-sessions-grok.js");
const { walkKimiSessions } = require("./cli-sessions-kimi.js");
const {
  resolveOpenCodeHome,
  openOpenCodeDb,
  closeOpenCodeDb,
} = require("./cli-sessions-opencode.js");
const { gitOutAsync } = require("./worktrees-git.js");
const { slugFromRemoteUrl, normalizePathKey } = require("./services-projects.js");

/**
 * First-run project discovery (#1501 G1): repos the user worked in recently
 * with a provider CLI, found with the cli-sessions scanners.
 *
 * Read-only. Session files are opened for reading and the OpenCode db with
 * readOnly; nothing in a CLI's data dir is written.
 *
 * Cursor is skipped: its project dir names flatten "/" and "-" alike, so a
 * cwd cannot be recovered. Muse buries the cwd in nested event records.
 */

/** Newest sessions read per CLI. */
const PER_SOURCE = 300;
/** Distinct cwds resolved with git, newest first. */
const MAX_DIRS = 80;
const MAX_GROUPS = 20;
const HEAD_BYTES = 64 * 1024;
/** A group is pre-selected when it was active this recently... */
const PRESELECT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** ...and it is one of the newest this many. */
const PRESELECT_MAX = 3;

/** @param {string} file */
function readHead(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * First `"cwd": "…"` in the file head. Claude jsonl lines and the Codex
 * session_meta line both carry one.
 * @param {string} file
 */
function cwdField(file) {
  const m = readHead(file).match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/);
  return m ? JSON.parse(m[1]) : null;
}

/**
 * @typedef {{
 *   provider: string,
 *   walk: (home: string | undefined, onFile: (info: { file: string, mtimeMs: number }) => void) => void,
 *   cwd: (file: string) => string | null,
 * }} SessionSource
 */

/** @type {SessionSource[]} */
const SOURCES = [
  { provider: "claude", walk: walkClaudeSessions, cwd: cwdField },
  {
    provider: "codex",
    walk: (home, onFile) => walkCodexRollouts(resolveCodexHome(home), onFile),
    cwd: cwdField,
  },
  // sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl. Long cwds are
  // hashed instead; those decode to a non-path and drop out below.
  {
    provider: "grok",
    walk: walkGrokSessions,
    cwd: (file) => decodeURIComponent(path.basename(path.dirname(path.dirname(file)))),
  },
  // sessions/<wd>/<id>/agents/main/wire.jsonl, with the cwd in <id>/state.json.
  {
    provider: "kimi",
    walk: walkKimiSessions,
    cwd: (file) =>
      JSON.parse(
        fs.readFileSync(path.join(path.dirname(file), "..", "..", "state.json"), "utf8"),
      ).cwd,
  },
];

/**
 * @typedef {{ claude?: string, codex?: string, grok?: string, kimi?: string, opencode?: string }} CliHomes
 */

/**
 * cwd → newest activity and which CLIs were used there.
 *
 * @param {CliHomes} homes
 * @returns {Map<string, { lastActiveMs: number, providers: Set<string> }>}
 */
function collectSessionDirs(homes) {
  /** @type {Map<string, { lastActiveMs: number, providers: Set<string> }>} */
  const dirs = new Map();
  const note = (/** @type {unknown} */ cwd, /** @type {number} */ ms, /** @type {string} */ provider) => {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return;
    const cur = dirs.get(cwd);
    if (cur) {
      cur.lastActiveMs = Math.max(cur.lastActiveMs, ms);
      cur.providers.add(provider);
    } else {
      dirs.set(cwd, { lastActiveMs: ms, providers: new Set([provider]) });
    }
  };

  for (const source of SOURCES) {
    /** @type {{ file: string, mtimeMs: number }[]} */
    const files = [];
    try {
      source.walk(homes[/** @type {keyof CliHomes} */ (source.provider)], (info) => files.push(info));
    } catch {
      continue;
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { file, mtimeMs } of files.slice(0, PER_SOURCE)) {
      try {
        note(source.cwd(file), mtimeMs, source.provider);
      } catch {
        // unreadable or unparseable session: skip it
      }
    }
  }

  const db = openOpenCodeDb(path.join(resolveOpenCodeHome(homes.opencode), "opencode.db"));
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT directory, MAX(time_updated) AS t FROM session GROUP BY directory ORDER BY t DESC LIMIT ?",
        )
        .all(PER_SOURCE);
      for (const row of rows) note(row.directory, Number(row.t) || 0, "opencode");
    } catch {
      // pre-1.14 layout or a schema we do not know
    } finally {
      closeOpenCodeDb(db);
    }
  }
  return dirs;
}

/**
 * The checkout a cwd belongs to: a linked worktree maps to its main checkout.
 *
 * @param {string} cwd
 * @param {typeof gitOutAsync} git
 * @returns {Promise<{ path: string, remoteUrl: string | null } | null>}
 */
async function resolveRepo(cwd, git) {
  let out;
  try {
    out = await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ], { timeout: 3_000 });
  } catch {
    return null;
  }
  const [top, common] = out.split("\n").map((s) => s.trim());
  if (!top || !common) return null;
  const main = path.basename(common) === ".git" ? path.dirname(common) : top;
  let remoteUrl = null;
  try {
    const urls = (await git(main, ["config", "--get-regexp", "^remote\\..*\\.url$"], { timeout: 3_000 }))
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
    const pick = urls.find(([key]) => key === "remote.origin.url") ?? urls[0];
    remoteUrl = (pick && pick[1]) || null;
  } catch {
    // no remotes
  }
  return { path: main, remoteUrl };
}

/**
 * @typedef {{
 *   path: string,
 *   name: string,
 *   lastActiveAt: number,
 *   providers: string[],
 *   preselected: boolean,
 * }} RecentRepo
 * @typedef {{ remote: string | null, repos: RecentRepo[] }} RecentRepoGroup
 */

/**
 * Recent repos grouped by git remote, newest group first. Paths already
 * added as projects, the home directory and temp dirs are left out.
 *
 * @param {{
 *   homes?: CliHomes,
 *   existingPaths?: string[],
 *   now?: number,
 *   git?: typeof gitOutAsync,
 *   homeDir?: string,
 *   tmpRoots?: string[],
 * }} [opts]
 * @returns {Promise<RecentRepoGroup[]>}
 */
async function discoverRecentRepos(opts = {}) {
  const git = opts.git || gitOutAsync;
  const now = opts.now ?? Date.now();
  const skip = new Set((opts.existingPaths || []).map(normalizePathKey));
  const homeDir = opts.homeDir || os.homedir();
  const tmpRoots = (
    opts.tmpRoots || [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  ).map(normalizePathKey);
  const isTmp = (/** @type {string} */ p) =>
    tmpRoots.some((t) => normalizePathKey(p).startsWith(`${t}/`));

  const dirs = [...collectSessionDirs(opts.homes || {})]
    .filter(([cwd]) => !isTmp(cwd) && fs.existsSync(cwd))
    .sort((a, b) => b[1].lastActiveMs - a[1].lastActiveMs)
    .slice(0, MAX_DIRS);

  const resolved = await Promise.all(dirs.map(([cwd]) => resolveRepo(cwd, git)));

  /** @type {Map<string, RecentRepo & { remoteUrl: string | null }>} */
  const repos = new Map();
  dirs.forEach(([, info], i) => {
    const repo = resolved[i];
    if (!repo) return;
    const key = normalizePathKey(repo.path);
    if (skip.has(key) || key === normalizePathKey(homeDir) || isTmp(repo.path)) return;
    const cur = repos.get(key);
    if (cur) {
      cur.lastActiveAt = Math.max(cur.lastActiveAt, info.lastActiveMs);
      for (const p of info.providers) if (!cur.providers.includes(p)) cur.providers.push(p);
      return;
    }
    repos.set(key, {
      path: repo.path,
      name: path.basename(repo.path),
      lastActiveAt: info.lastActiveMs,
      providers: [...info.providers],
      preselected: false,
      remoteUrl: repo.remoteUrl,
    });
  });

  /** @type {Map<string, RecentRepoGroup>} */
  const groups = new Map();
  for (const repo of [...repos.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
    const remote = repo.remoteUrl ? slugFromRemoteUrl(repo.remoteUrl) || repo.remoteUrl : null;
    // No remote: every such checkout stands alone.
    const key = remote ? `r:${remote.toLowerCase()}` : `p:${repo.path}`;
    const { remoteUrl: _drop, ...row } = repo;
    const group = groups.get(key);
    if (group) group.repos.push(row);
    else groups.set(key, { remote, repos: [row] });
  }

  const list = [...groups.values()].slice(0, MAX_GROUPS);
  list.slice(0, PRESELECT_MAX).forEach((g) => {
    const newest = g.repos[0];
    if (newest && now - newest.lastActiveAt <= PRESELECT_WINDOW_MS) newest.preselected = true;
  });
  return list;
}

module.exports = { discoverRecentRepos, collectSessionDirs };
