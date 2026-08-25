"use strict";

/**
 * Vibe Kanban import (#399).
 *
 * Reads the local SQLite VK left behind after the April 2026 shutdown
 * (db.v2.sqlite, else db.sqlite) and turns projects + cards into Solenta
 * projects + threads. Schema is adaptive: the 2025 init tables
 * (`projects.git_repo_path`, `task_attempts.worktree_path`) and the later
 * `repos` / `container_ref` shape both work.
 *
 * Does not start runs, does not create GitHub issues, does not invent
 * worktrees. Re-import is idempotent on thread.vibeKanbanTaskId.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const services = require("./services.js");

const DB_NAMES = ["db.v2.sqlite", "db.sqlite"];

const EXECUTOR_TO_PROVIDER = {
  CLAUDE: "claude",
  CLAUDE_CODE: "claude",
  CLAUDE_CODE_REVIEW: "claude",
  CODEX: "codex",
  OPENCODE: "opencode",
  KIMI: "kimi",
  GROK: "grok",
  CURSOR: "cursor",
};

/**
 * Platform default data dirs, plus a couple of aliases people reported.
 * `directories::ProjectDirs::from("ai", "bloop", "vibe-kanban")`.
 * @returns {string[]}
 */
function defaultDataDirs() {
  const home = os.homedir();
  const out = [];
  if (process.platform === "darwin") {
    out.push(
      path.join(home, "Library", "Application Support", "ai.bloop.vibe-kanban"),
    );
  } else if (process.platform === "win32") {
    const roaming =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");
    out.push(path.join(roaming, "bloop", "vibe-kanban"));
    out.push(path.join(roaming, "bloop", "vibe-kanban", "data"));
    out.push(path.join(roaming, "ai.bloop.vibe-kanban"));
  } else {
    const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    out.push(path.join(xdg, "vibe-kanban"));
    out.push(path.join(xdg, "ai.bloop.vibe-kanban"));
  }
  // Always consider the other-platform paths so a copied dir still resolves.
  out.push(
    path.join(home, "Library", "Application Support", "ai.bloop.vibe-kanban"),
  );
  out.push(path.join(home, ".local", "share", "vibe-kanban"));
  return [...new Set(out)];
}

/**
 * @param {string} dirOrFile
 * @returns {string | null}
 */
function findDatabase(dirOrFile) {
  if (!dirOrFile) return null;
  let stat;
  try {
    stat = fs.statSync(dirOrFile);
  } catch {
    return null;
  }
  if (stat.isFile()) {
    return /\.sqlite$/i.test(dirOrFile) ? path.resolve(dirOrFile) : null;
  }
  if (!stat.isDirectory()) return null;
  const root = path.resolve(dirOrFile);
  for (const name of DB_NAMES) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  for (const name of DB_NAMES) {
    const p = path.join(root, "data", name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {string} [preferred]
 * @returns {{ dataDir: string | null, dbPath: string | null }}
 */
function resolveSource(preferred) {
  if (preferred && String(preferred).trim()) {
    const raw = String(preferred).trim();
    const dbPath = findDatabase(raw);
    if (!dbPath) {
      return { dataDir: path.resolve(raw), dbPath: null };
    }
    return { dataDir: path.dirname(dbPath), dbPath };
  }
  for (const dir of defaultDataDirs()) {
    const dbPath = findDatabase(dir);
    if (dbPath) return { dataDir: dir, dbPath };
  }
  return { dataDir: defaultDataDirs()[0] || null, dbPath: null };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function uuidFromBlob(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      return s.toLowerCase();
    }
    if (/^[0-9a-f]{32}$/i.test(s)) {
      const h = s.toLowerCase();
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    return s;
  }
  const buf = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : null;
  if (!buf) return String(value);
  if (buf.length === 16) {
    const h = buf.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const asText = buf.toString("utf8").trim();
  if (asText) return uuidFromBlob(asText);
  return buf.toString("hex");
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function parseVkTime(raw) {
  if (raw == null || raw === "") return Date.now();
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e12 ? Math.round(raw * 1000) : raw;
  }
  const s = String(raw).trim();
  if (!s) return Date.now();
  const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(s)
    ? s.replace(" ", "T")
    : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * @param {string} status
 * @returns {"todo" | "inprogress" | "inreview" | "done" | "cancelled"}
 */
function normalizeStatus(status) {
  const s = String(status || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (s === "done" || s === "complete" || s === "completed") return "done";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "inreview" || s === "review") return "inreview";
  if (s === "inprogress" || s === "doing" || s === "wip") return "inprogress";
  return "todo";
}

/**
 * @param {unknown} executor
 * @returns {string | null}
 */
function providerFromExecutor(executor) {
  if (executor == null) return null;
  const key = String(executor)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (EXECUTOR_TO_PROVIDER[key]) return EXECUTOR_TO_PROVIDER[key];
  const first = key.split("_")[0];
  return EXECUTOR_TO_PROVIDER[first] || null;
}

/**
 * @param {string} dbPath
 */
function openReadonly(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (err) {
    throw new Error(
      `Cannot open a Vibe Kanban database: node:sqlite is unavailable (${err && err.message ? err.message : err})`,
    );
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(
      `Cannot open Vibe Kanban database ${dbPath}: ${err && err.message ? err.message : err}`,
    );
  }
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 */
function tableExists(db, name) {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  return Boolean(row);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} table
 * @returns {Set<string>}
 */
function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{ id: string, name: string, path: string | null }[]}
 */
function readProjects(db) {
  if (!tableExists(db, "projects")) {
    throw new Error("Not a Vibe Kanban database (no projects table)");
  }
  const cols = tableColumns(db, "projects");
  const rows = db.prepare("SELECT * FROM projects").all();
  /** @type {Map<string, { id: string, name: string, path: string | null }>} */
  const byId = new Map();
  for (const row of rows) {
    const id = uuidFromBlob(row.id);
    const name = String(row.name || "Untitled").trim() || "Untitled";
    let repoPath = null;
    if (cols.has("git_repo_path") && row.git_repo_path) {
      repoPath = String(row.git_repo_path).trim() || null;
    }
    byId.set(id, { id, name, path: repoPath });
  }

  if (tableExists(db, "repos") && tableExists(db, "project_repos")) {
    const joins = db
      .prepare(
        `SELECT pr.project_id AS project_id, r.path AS path
         FROM project_repos pr
         JOIN repos r ON r.id = pr.repo_id`,
      )
      .all();
    for (const row of joins) {
      const id = uuidFromBlob(row.project_id);
      const repoPath = row.path ? String(row.path).trim() : "";
      const existing = byId.get(id);
      if (!existing) continue;
      if (!existing.path && repoPath) existing.path = repoPath;
    }
  }
  return [...byId.values()];
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {object[]}
 */
function readTasks(db) {
  const table = tableExists(db, "tasks")
    ? "tasks"
    : tableExists(db, "issues")
      ? "issues"
      : null;
  if (!table) {
    throw new Error("Not a Vibe Kanban database (no tasks table)");
  }
  return db.prepare(`SELECT * FROM ${table}`).all();
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {Map<string, object>}
 */
function readLatestAttempts(db) {
  /** @type {Map<string, object>} */
  const latest = new Map();
  if (!tableExists(db, "task_attempts")) return latest;
  const cols = tableColumns(db, "task_attempts");
  const rows = db
    .prepare("SELECT * FROM task_attempts ORDER BY created_at ASC")
    .all();
  for (const row of rows) {
    const taskId = uuidFromBlob(row.task_id);
    if (!taskId) continue;
    const worktree =
      (cols.has("container_ref") && row.container_ref) ||
      (cols.has("worktree_path") && row.worktree_path) ||
      null;
    latest.set(taskId, {
      worktreePath: worktree ? String(worktree).trim() : null,
      branch: cols.has("branch") && row.branch ? String(row.branch) : null,
      executor: cols.has("executor") ? row.executor : null,
      prUrl:
        (cols.has("pr_url") && row.pr_url) ||
        (cols.has("prUrl") && row.prUrl) ||
        null,
      prNumber:
        cols.has("pr_number") && row.pr_number != null
          ? Number(row.pr_number)
          : null,
      createdAt: row.created_at,
    });
  }
  if (tableExists(db, "merges")) {
    const mergeCols = tableColumns(db, "merges");
    if (mergeCols.has("pr_url") || mergeCols.has("pr_number")) {
      const merges = db.prepare("SELECT * FROM merges").all();
      // Attempt → task via the latest map is enough: stamp PR onto the
      // attempt we already chose when the merge row points at that attempt.
      const attemptToTask = new Map();
      const attempts = db.prepare("SELECT id, task_id FROM task_attempts").all();
      for (const a of attempts) {
        attemptToTask.set(uuidFromBlob(a.id), uuidFromBlob(a.task_id));
      }
      for (const m of merges) {
        const taskId = attemptToTask.get(uuidFromBlob(m.task_attempt_id));
        if (!taskId) continue;
        const cur = latest.get(taskId);
        if (!cur) continue;
        if (!cur.prUrl && mergeCols.has("pr_url") && m.pr_url) {
          cur.prUrl = String(m.pr_url);
        }
        if (
          (cur.prNumber == null || !Number.isFinite(cur.prNumber)) &&
          mergeCols.has("pr_number") &&
          m.pr_number != null
        ) {
          cur.prNumber = Number(m.pr_number);
        }
      }
    }
  }
  return latest;
}

/**
 * @param {string} dbPath
 */
function readSnapshot(dbPath) {
  const db = openReadonly(dbPath);
  try {
    const projects = readProjects(db);
    const rawTasks = readTasks(db);
    const attempts = readLatestAttempts(db);
    const tasks = rawTasks.map((row) => {
      const id = uuidFromBlob(row.id);
      const projectId = uuidFromBlob(row.project_id);
      const attempt = attempts.get(id) || null;
      return {
        id,
        projectId,
        title: String(row.title || "Untitled").trim() || "Untitled",
        description:
          row.description != null ? String(row.description) : "",
        status: normalizeStatus(row.status),
        createdAt: parseVkTime(row.created_at),
        updatedAt: parseVkTime(row.updated_at || row.created_at),
        attempt,
      };
    });
    return { projects, tasks };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * @param {string | null | undefined} p
 */
function pathExistsDir(p) {
  if (!p) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {import("./store").Store} store
 * @param {string} repoPath
 */
function findExistingProject(store, repoPath) {
  const resolved = path.resolve(repoPath);
  return (
    store.getProjects().find((p) => {
      if (!p || !p.path) return false;
      try {
        return path.resolve(p.path) === resolved;
      } catch {
        return p.path === repoPath;
      }
    }) || null
  );
}

/**
 * @param {import("./store").Store} store
 * @param {string} vkProjectId
 */
function findImportedProject(store, vkProjectId) {
  return (
    store.getProjects().find((p) => p && p.vibeKanbanProjectId === vkProjectId) ||
    null
  );
}

/**
 * @param {import("./store").Store} store
 * @param {string} vkTaskId
 */
function findImportedThread(store, vkTaskId) {
  return (
    store.getThreads().find((t) => t && t.vibeKanbanTaskId === vkTaskId) ||
    null
  );
}

/**
 * @param {object} task
 */
function cardNotes(task) {
  const lines = [
    "Imported from Vibe Kanban.",
    `Status: ${task.status}`,
    `Card: ${task.id}`,
  ];
  const desc = String(task.description || "").trim();
  if (desc) {
    lines.push("", desc);
  }
  return lines.join("\n").slice(0, services.THREAD_NOTES_MAX);
}

/**
 * @param {object} task
 */
function cardMessage(task) {
  const desc = String(task.description || "").trim();
  if (desc) return desc;
  return task.title;
}

/**
 * @param {string | null} url
 * @param {number | null} number
 */
function parsePr(url, number) {
  const n =
    number != null && Number.isFinite(Number(number)) ? Number(number) : null;
  const u = url ? String(url).trim() : "";
  if (!u && n == null) return { prUrl: null, prNumber: null };
  if (u && n != null) return { prUrl: u, prNumber: n };
  if (u) {
    const m = u.match(/\/pull\/(\d+)/);
    return { prUrl: u, prNumber: m ? Number(m[1]) : null };
  }
  return { prUrl: null, prNumber: n };
}

/**
 * @param {import("./store").Store} [store]
 * @param {{ dataDir?: string }} [opts]
 */
function preview(store, opts) {
  const source = resolveSource(opts && opts.dataDir);
  if (!source.dbPath) {
    return {
      found: false,
      dataDir: source.dataDir,
      dbPath: null,
      projects: [],
      taskCount: 0,
      worktreeCount: 0,
      alreadyImported: 0,
    };
  }
  const snap = readSnapshot(source.dbPath);
  const imported = new Set(
    store
      ? store
          .getThreads()
          .filter((t) => t && t.vibeKanbanTaskId)
          .map((t) => t.vibeKanbanTaskId)
      : [],
  );
  const projects = snap.projects.map((p) => {
    const tasks = snap.tasks.filter((t) => t.projectId === p.id);
    const worktrees = tasks.filter(
      (t) => t.attempt && pathExistsDir(t.attempt.worktreePath),
    ).length;
    return {
      name: p.name,
      path: p.path,
      exists: pathExistsDir(p.path),
      taskCount: tasks.length,
      worktreeCount: worktrees,
    };
  });
  return {
    found: true,
    dataDir: source.dataDir,
    dbPath: source.dbPath,
    projects,
    taskCount: snap.tasks.length,
    worktreeCount: projects.reduce((n, p) => n + p.worktreeCount, 0),
    alreadyImported: snap.tasks.filter((t) => imported.has(t.id)).length,
  };
}

/**
 * @param {import("./store").Store} store
 * @param {{ dataDir?: string }} [opts]
 */
async function importFrom(store, opts) {
  const source = resolveSource(opts && opts.dataDir);
  if (!source.dbPath) {
    throw new Error(
      source.dataDir
        ? `No Vibe Kanban database in ${source.dataDir}. Choose the folder that contains db.v2.sqlite (or db.sqlite).`
        : "No Vibe Kanban data folder found. Choose the folder that contains db.v2.sqlite.",
    );
  }
  const snap = readSnapshot(source.dbPath);
  /** @type {Map<string, string>} vk project id → solenta project id */
  const projectMap = new Map();
  let projectsAdded = 0;
  let projectsReused = 0;
  let threadsCreated = 0;
  let threadsSkipped = 0;
  let worktreesMapped = 0;
  /** @type {Array<{ title: string, reason: string }>} */
  const skipped = [];

  for (const vkProject of snap.projects) {
    const existing =
      findImportedProject(store, vkProject.id) ||
      (vkProject.path ? findExistingProject(store, vkProject.path) : null);
    if (existing) {
      if (!existing.vibeKanbanProjectId) {
        const next = store.getProjects().map((p) =>
          p.id === existing.id
            ? { ...p, vibeKanbanProjectId: vkProject.id }
            : p,
        );
        store.setProjects(next);
      }
      projectMap.set(vkProject.id, existing.id);
      projectsReused += 1;
      continue;
    }
    if (!vkProject.path || !pathExistsDir(vkProject.path)) {
      skipped.push({
        title: vkProject.name,
        reason: vkProject.path
          ? `Project path no longer exists: ${vkProject.path}`
          : "Project has no local git path",
      });
      continue;
    }
    try {
      const added = await services.addProject(store, vkProject.path);
      const next = store.getProjects().map((p) =>
        p.id === added.id
          ? {
              ...p,
              name: vkProject.name || p.name,
              vibeKanbanProjectId: vkProject.id,
            }
          : p,
      );
      store.setProjects(next);
      projectMap.set(vkProject.id, added.id);
      projectsAdded += 1;
    } catch (err) {
      skipped.push({
        title: vkProject.name,
        reason: err && err.message ? String(err.message) : String(err),
      });
    }
  }

  for (const task of snap.tasks) {
    if (findImportedThread(store, task.id)) {
      threadsSkipped += 1;
      continue;
    }
    const projectId = projectMap.get(task.projectId);
    if (!projectId) {
      skipped.push({
        title: task.title,
        reason: "Project was not imported",
      });
      continue;
    }
    const thread = services.createThread(store, {
      projectId,
      title: task.title,
    });
    const attempt = task.attempt;
    const worktreePath =
      attempt && pathExistsDir(attempt.worktreePath)
        ? path.resolve(attempt.worktreePath)
        : null;
    const pr = parsePr(
      attempt && attempt.prUrl,
      attempt && attempt.prNumber,
    );
    const provider = attempt
      ? providerFromExecutor(attempt.executor)
      : null;
    const settled = task.status === "done" || task.status === "cancelled";
    store.updateThread(thread.id, {
      vibeKanbanTaskId: task.id,
      notes: cardNotes(task),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      lastVisitedAt: task.createdAt,
      archived: task.status === "cancelled",
      settledOverride: settled ? "settled" : null,
      settledAt: settled ? task.updatedAt : null,
      branch: attempt && attempt.branch ? String(attempt.branch) : null,
      worktreePath,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      provider: provider || thread.provider,
    });
    store.setMessages(thread.id, [
      {
        id: randomUUID(),
        role: "user",
        text: cardMessage(task),
        createdAt: task.createdAt,
      },
    ]);
    if (worktreePath) worktreesMapped += 1;
    threadsCreated += 1;
  }

  store.save();
  return {
    dataDir: source.dataDir,
    dbPath: source.dbPath,
    projectsAdded,
    projectsReused,
    threadsCreated,
    threadsSkipped,
    worktreesMapped,
    skipped,
  };
}

/**
 * Portable dump of what import created — and of everything else the user
 * already has. Settings / tokens stay out.
 * @param {import("./store").Store} store
 */
function buildExport(store) {
  const projects = store.getProjects().map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    path: p.path,
    remoteHost: p.remoteHost || null,
    remotePath: p.remotePath || null,
    spaceId: p.spaceId || null,
    vibeKanbanProjectId: p.vibeKanbanProjectId || null,
  }));
  const threads = store.getThreads().map((t) => ({
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    notes: t.notes || "",
    status: t.status,
    archived: Boolean(t.archived),
    settledOverride: t.settledOverride || null,
    branch: t.branch || null,
    worktreePath: t.worktreePath || null,
    prNumber: t.prNumber || null,
    prUrl: t.prUrl || null,
    provider: t.provider || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    vibeKanbanTaskId: t.vibeKanbanTaskId || null,
    messages: store.getMessages(t.id).map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
    })),
  }));
  return {
    format: "solenta-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    projects,
    threads,
  };
}

module.exports = {
  defaultDataDirs,
  findDatabase,
  resolveSource,
  uuidFromBlob,
  parseVkTime,
  normalizeStatus,
  providerFromExecutor,
  readSnapshot,
  preview,
  importFrom,
  buildExport,
};
