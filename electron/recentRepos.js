"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isMainThread, parentPort, workerData } = require("node:worker_threads");
const { walkClaudeSessions } = require("./cli-sessions-claude.js");
const { resolveCodexHome, walkCodexRollouts } = require("./cli-sessions-codex.js");
const { walkGrokSessions } = require("./cli-sessions-grok.js");
const { walkCursorSessions } = require("./cli-sessions-cursor.js");
const { resolveMuseHome } = require("./cli-sessions-muse.js");
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
 * Read-only. Session files are opened for reading and the OpenCode and Muse
 * dbs with readOnly; nothing in a CLI's data dir is written.
 *
 * Also feeds "Add project → From CLI history" (#1858): discoverHistoryProjects.
 */

/** Newest sessions read per CLI. */
const PER_SOURCE = 300;
/** Distinct cwds resolved with git, newest first. */
const MAX_DIRS = 80;
const MAX_GROUPS = 20;
const HEAD_CHUNK = 16 * 1024;
/** Claude's first cwd can sit ~90KB in, after big hook attachment lines. */
const HEAD_MAX = 256 * 1024;
/** Folders "From CLI history" lists at most (#1858). */
const MAX_HISTORY = 200;
/** Newest sessions kept per folder, for the import offer after adding. */
const RECENT_SESSIONS = 3;
/** A group is pre-selected when it was active this recently... */
const PRESELECT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** ...and it is one of the newest this many. */
const PRESELECT_MAX = 3;

const CWD_FIELD = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;

/**
 * First `"cwd": "…"` in the file head. Claude jsonl lines and the Codex
 * session_meta line both carry one. Reads 16KB chunks and stops at the
 * first match, or at HEAD_MAX.
 * @param {string} file
 */
function cwdField(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_MAX);
    let len = 0;
    while (len < HEAD_MAX) {
      const n = fs.readSync(fd, buf, len, Math.min(HEAD_CHUNK, HEAD_MAX - len), len);
      if (n === 0) break;
      len += n;
      const m = buf.toString("utf8", 0, len).match(CWD_FIELD);
      if (m) return JSON.parse(m[1]);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Cursor names a project dir after its path with every non-alphanumeric
 * character flattened to "-", so "/" and "-" look alike. Walk down from /
 * matching flattened directory names; the first existing match wins.
 * ponytail: POSIX roots only; Windows drive-letter names drop out.
 *
 * @param {string} name e.g. "Users-me-code-my-app"
 * @param {Map<string, string[]>} cache dir → subdirectory names
 * @returns {string | null}
 */
function unflattenPath(name, cache) {
  const subdirs = (/** @type {string} */ dir) => {
    let names = cache.get(dir);
    if (!names) {
      try {
        names = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() || e.isSymbolicLink())
          .map((e) => e.name);
      } catch {
        names = [];
      }
      cache.set(dir, names);
    }
    return names;
  };
  /** @returns {string | null} */
  const walk = (/** @type {string} */ dir, /** @type {string} */ rest) => {
    for (const entry of subdirs(dir)) {
      const flat = entry.replace(/[^A-Za-z0-9]/g, "-");
      if (rest === flat) return path.join(dir, entry);
      if (rest.startsWith(`${flat}-`)) {
        const hit = walk(path.join(dir, entry), rest.slice(flat.length + 1));
        if (hit) return hit;
      }
    }
    return null;
  };
  const rest = name.replace(/^-/, "");
  return rest ? walk("/", rest) : null;
}

/**
 * @typedef {{
 *   provider: string,
 *   walk: (home: string | undefined, onFile: (info: { file: string, mtimeMs: number, sessionId?: string }) => void) => void,
 *   cwd: (file: string, cache: Map<string, string[]>) => string | null,
 *   group?: (file: string) => string,
 * }} SessionSource
 */

/** @type {SessionSource[]} */
const SOURCES = [
  // projects/<flattened-cwd>/<id>.jsonl. The flattening is lossy (my-app and
  // my/app share a dir), so every session's own cwd is read, not the dir's.
  { provider: "claude", walk: walkClaudeSessions, cwd: cwdField },
  {
    provider: "codex",
    walk: (home, onFile) => walkCodexRollouts(resolveCodexHome(home), onFile),
    cwd: cwdField,
  },
  // sessions/<encodeURIComponent(cwd)>/<id>/chat_history.jsonl. Long cwds are
  // hashed instead, with the real path in <group>/.cwd.
  {
    provider: "grok",
    walk: walkGrokSessions,
    cwd: (file) => {
      const group = path.dirname(path.dirname(file));
      const decoded = decodeURIComponent(path.basename(group));
      return path.isAbsolute(decoded)
        ? decoded
        : fs.readFileSync(path.join(group, ".cwd"), "utf8").trim();
    },
    group: (file) => path.dirname(path.dirname(file)),
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
  // projects/<flattened-cwd>/agent-transcripts/<id>/<id>.jsonl
  {
    provider: "cursor",
    walk: walkCursorSessions,
    cwd: (file, cache) => unflattenPath(path.basename(path.dirname(path.dirname(path.dirname(file)))), cache),
    group: (file) => path.dirname(path.dirname(path.dirname(file))),
  },
];

/**
 * @typedef {{ claude?: string, codex?: string, grok?: string, kimi?: string, opencode?: string, cursor?: string, muse?: string }} CliHomes
 * @typedef {{ provider: string, sessionId: string }} RecentSession
 * @typedef {{
 *   lastActiveMs: number,
 *   providers: Set<string>,
 *   sessions: number,
 *   recent: (RecentSession & { ms: number })[],
 * }} SessionDir
 */

/**
 * cwd → newest activity, which CLIs were used there, how many sessions, and
 * the newest few session ids.
 *
 * @param {CliHomes} homes
 * @param {{ perSource?: number }} [opts] newest sessions read per CLI
 * @returns {Map<string, SessionDir>}
 */
function collectSessionDirs(homes, opts = {}) {
  const perSource = opts.perSource ?? PER_SOURCE;
  /** @type {Map<string, SessionDir>} */
  const dirs = new Map();
  const note = (
    /** @type {unknown} */ cwd,
    /** @type {number} */ ms,
    /** @type {string} */ provider,
    /** @type {string | undefined} */ sessionId,
  ) => {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return;
    let cur = dirs.get(cwd);
    if (!cur) {
      cur = { lastActiveMs: ms, providers: new Set(), sessions: 0, recent: [] };
      dirs.set(cwd, cur);
    }
    cur.lastActiveMs = Math.max(cur.lastActiveMs, ms);
    cur.providers.add(provider);
    cur.sessions += 1;
    if (sessionId) {
      cur.recent.push({ provider, sessionId, ms });
      cur.recent.sort((a, b) => b.ms - a.ms);
      cur.recent.length = Math.min(cur.recent.length, RECENT_SESSIONS);
    }
  };
  /** @type {Map<string, string[]>} */
  const dirCache = new Map();

  for (const source of SOURCES) {
    /** @type {{ file: string, mtimeMs: number, sessionId?: string }[]} */
    const files = [];
    try {
      source.walk(homes[/** @type {keyof CliHomes} */ (source.provider)], (info) => files.push(info));
    } catch {
      continue;
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // Sources whose dir names the cwd read it once, from the newest session.
    /** @type {Map<string, string>} */
    const groupCwd = new Map();
    for (const { file, mtimeMs, sessionId } of files.slice(0, perSource)) {
      const group = source.group ? source.group(file) : null;
      let cwd = group ? groupCwd.get(group) : undefined;
      if (cwd === undefined) {
        try {
          cwd = source.cwd(file, dirCache) ?? undefined;
        } catch {
          // unreadable or unparseable session: skip it
        }
        if (cwd === undefined) continue;
        if (group) groupCwd.set(group, cwd);
      }
      note(cwd, mtimeMs, source.provider, sessionId);
    }
  }
  // LIMIT -1 is SQLite for no limit.
  const sqlLimit = Number.isFinite(perSource) ? perSource : -1;

  const db = openOpenCodeDb(path.join(resolveOpenCodeHome(homes.opencode), "opencode.db"));
  if (db) {
    try {
      const rows = db
        .prepare("SELECT id, directory, time_updated AS t FROM session ORDER BY t DESC LIMIT ?")
        .all(sqlLimit);
      for (const row of rows) {
        note(row.directory, Number(row.t) || 0, "opencode", String(row.id));
      }
    } catch {
      // pre-1.14 layout or a schema we do not know
    } finally {
      closeOpenCodeDb(db);
    }
  }
  // Muse keeps the cwd deep in nested event records; its index db has it flat.
  const museDb = openOpenCodeDb(path.join(resolveMuseHome(homes.muse), "session-index.db"));
  if (museDb) {
    try {
      const rows = museDb
        .prepare(
          "SELECT session_id, workspace_root, updated_at_us AS t FROM sessions WHERE workspace_root IS NOT NULL ORDER BY t DESC LIMIT ?",
        )
        .all(sqlLimit);
      for (const row of rows) {
        note(row.workspace_root, Math.floor(Number(row.t) / 1000) || 0, "muse", String(row.session_id));
      }
    } catch {
      // a schema we do not know
    } finally {
      closeOpenCodeDb(museDb);
    }
  }
  return dirs;
}

/**
 * @param {string[] | undefined} roots
 * @returns {(p: string) => boolean}
 */
function tmpCheck(roots) {
  const keys = (
    roots || [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  ).map(normalizePathKey);
  return (p) => keys.some((t) => normalizePathKey(p).startsWith(`${t}/`));
}

/**
 * The project folder a cwd belongs to, from the file system alone (no git
 * spawn per folder): the nearest ancestor holding `.git`. A linked
 * worktree's `.git` file points at <main>/.git/worktrees/<name>, which maps
 * to <main>; a worktree whose main is gone (or is bare) gives null. No
 * `.git` below `stopAt` (home): the cwd itself, a plain folder.
 *
 * @param {string} cwd
 * @param {string} stopAt
 * @returns {string | null}
 */
function projectRootOf(cwd, stopAt) {
  for (let dir = cwd; dir !== stopAt && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    let st;
    try {
      st = fs.statSync(dotGit);
    } catch {
      continue;
    }
    if (st.isDirectory()) return dir;
    let gitdir;
    try {
      gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
    } catch {
      return null;
    }
    if (!gitdir) return null;
    gitdir = path.resolve(dir, gitdir);
    const parent = path.dirname(gitdir);
    // Submodule (.git/modules/<name>): the submodule checkout is the project.
    if (path.basename(parent) !== "worktrees") return dir;
    const common = path.dirname(parent);
    if (path.basename(common) !== ".git") return null;
    const main = path.dirname(common);
    return fs.existsSync(main) ? main : null;
  }
  return cwd;
}

/** @param {string} p */
function realKey(p) {
  try {
    return normalizePathKey(fs.realpathSync(p));
  } catch {
    return normalizePathKey(p);
  }
}

/**
 * @typedef {{
 *   path: string,
 *   name: string,
 *   lastActiveAt: number,
 *   providers: string[],
 *   sessions: number,
 *   recentSessions: RecentSession[],
 * }} HistoryProject
 */

/**
 * "Add project → From CLI history" (#1858): every folder a provider CLI
 * ran in, deduped by real path, newest first. Worktrees count for their
 * main checkout; already-added projects, missing folders, temp dirs, home,
 * and anything left under a worktrees dir (`worktreeRoots`) are left out.
 *
 * @param {{
 *   homes?: CliHomes,
 *   existingPaths?: string[],
 *   homeDir?: string,
 *   tmpRoots?: string[],
 *   worktreeRoots?: string[],
 * }} [opts]
 * @returns {HistoryProject[]}
 */
// Sync fs: ~200ms warm / ~1.3s cold for ~2k sessions. Callers on the main
// process go through discoverHistoryProjectsAsync, which runs it in a worker.
function discoverHistoryProjects(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const isTmp = tmpCheck(opts.tmpRoots);
  const skip = new Set([...(opts.existingPaths || []), homeDir].map(realKey));
  const worktreeRoots = (opts.worktreeRoots || []).filter(Boolean).map(realKey);
  /** @type {Map<string, HistoryProject & { recent: (RecentSession & { ms: number })[] }>} */
  const projects = new Map();
  for (const [cwd, info] of collectSessionDirs(opts.homes || {}, { perSource: Infinity })) {
    if (isTmp(cwd) || !fs.existsSync(cwd)) continue;
    const root = projectRootOf(cwd, homeDir);
    if (!root || isTmp(root)) continue;
    const key = realKey(root);
    if (!key || skip.has(key)) continue;
    if (worktreeRoots.some((w) => key === w || key.startsWith(`${w}/`))) continue;
    let cur = projects.get(key);
    if (!cur) {
      cur = {
        path: root,
        name: path.basename(root),
        lastActiveAt: 0,
        providers: [],
        sessions: 0,
        recentSessions: [],
        recent: [],
      };
      projects.set(key, cur);
    }
    cur.lastActiveAt = Math.max(cur.lastActiveAt, info.lastActiveMs);
    for (const p of info.providers) if (!cur.providers.includes(p)) cur.providers.push(p);
    cur.sessions += info.sessions;
    cur.recent.push(...info.recent);
  }
  return [...projects.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_HISTORY)
    .map(({ recent, ...row }) => ({
      ...row,
      recentSessions: recent
        .sort((a, b) => b.ms - a.ms)
        .slice(0, RECENT_SESSIONS)
        .map(({ provider, sessionId }) => ({ provider, sessionId })),
    }));
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
  const isTmp = tmpCheck(opts.tmpRoots);

  const dirs = [.../** @type {Map<string, SessionDir>} */ (await runOffThread("collect", [opts.homes || {}]))]
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

/** Sync scans a worker may run, by name. */
const JOBS = {
  collect: collectSessionDirs,
  history: discoverHistoryProjects,
};

/**
 * Run a sync scan from JOBS in a worker thread, so reading thousands of
 * session files never freezes the main process (and every window with it).
 *
 * @param {keyof typeof JOBS} job
 * @param {unknown[]} args structured-cloneable
 * @returns {Promise<unknown>}
 */
function runOffThread(job, args) {
  return new Promise((resolve, reject) => {
    const { Worker } = require("node:worker_threads");
    const worker = new Worker(__filename, { workerData: { recentReposJob: job, args } });
    // Required modules can leave handles open in the worker; end it ourselves.
    worker.once("message", (result) => {
      resolve(result);
      void worker.terminate();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      reject(new Error(`CLI history scan exited with code ${code}`));
    });
  });
}

const HISTORY_TTL_MS = 60_000;
/** @type {{ key: string, at: number, promise: Promise<HistoryProject[]> } | null} */
let historyCache = null;

/**
 * discoverHistoryProjects off the main thread. Reopening the picker within a
 * minute with the same projects reuses the scan; adding one changes the key.
 *
 * @param {Parameters<typeof discoverHistoryProjects>[0]} [opts]
 * @returns {Promise<HistoryProject[]>}
 */
function discoverHistoryProjectsAsync(opts = {}) {
  const key = JSON.stringify([
    [...(opts.existingPaths || [])].map(normalizePathKey).sort(),
    opts.worktreeRoots || [],
    opts.homes || {},
    opts.homeDir || "",
    opts.tmpRoots || null,
  ]);
  const now = Date.now();
  if (historyCache && historyCache.key === key && now - historyCache.at < HISTORY_TTL_MS) {
    return historyCache.promise;
  }
  const promise = /** @type {Promise<HistoryProject[]>} */ (runOffThread("history", [opts]));
  const entry = { key, at: now, promise };
  historyCache = entry;
  promise.catch(() => {
    if (historyCache === entry) historyCache = null;
  });
  return promise;
}

if (!isMainThread && parentPort && workerData && workerData.recentReposJob in JOBS) {
  const job = JOBS[/** @type {keyof typeof JOBS} */ (workerData.recentReposJob)];
  parentPort.postMessage(/** @type {Function} */ (job)(...workerData.args));
}

module.exports = {
  discoverRecentRepos,
  collectSessionDirs,
  discoverHistoryProjects,
  discoverHistoryProjectsAsync,
  unflattenPath,
};
