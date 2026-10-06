"use strict";

/**
 * OpenCode session reader (opencode.db, or the pre-1.14 JSON tree). See cli-sessions.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isInside,
  absorbTurns,
  commitImportedTurns,
} = require("./cli-sessions-shared.js");

/**
 * OpenCode session ids are `ses_*` with letters, digits, `_`. Path-safe:
 * no slashes or `..`. Broader than isPathSafeSessionId (no underscore).
 * @param {string} sessionId
 */
function isOpenCodeSessionId(sessionId) {
  const id = String(sessionId || "");
  return id.length > 0 && /^[0-9A-Za-z_-]+$/.test(id);
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveOpenCodeHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.OPENCODE_HOME) return process.env.OPENCODE_HOME;
  const xdg =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "opencode");
}

/**
 * @param {string} dbPath
 * @returns {import("node:sqlite").DatabaseSync | null}
 */
function openOpenCodeDb(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 */
function openCodeTableExists(db, name) {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  return Boolean(row);
}

/**
 * @param {import("node:sqlite").DatabaseSync | null} db
 */
function closeOpenCodeDb(db) {
  if (!db) return;
  try {
    db.close();
  } catch {
    // ignore
  }
}

/**
 * True when import should walk the pre-1.14 JSON tree instead of SQLite:
 * opencode.db is missing, is not a file, or has no session table.
 * A db file that exists but cannot be opened is not a fallback (avoids
 * double-counting leftover JSON next to a live locked db).
 *
 * @param {string} home
 */
function shouldUseOpenCodeJson(home) {
  const dbPath = path.join(home, "opencode.db");
  let st;
  try {
    st = fs.statSync(dbPath);
  } catch {
    return true;
  }
  if (!st.isFile()) return true;
  const db = openOpenCodeDb(dbPath);
  if (!db) return false;
  try {
    return !openCodeTableExists(db, "session");
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * Walk `storage/session/<projectID>/<sessionID>.json`. The walk cannot
 * leave `storage/session`.
 *
 * @param {string} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkOpenCodeJsonSessions(home, onFile) {
  const sessionRoot = path.resolve(String(home || ""), "storage", "session");
  let projects;
  try {
    projects = fs.readdirSync(sessionRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue;
    if (!isOpenCodeSessionId(project.name)) continue;
    const projectDir = path.join(sessionRoot, project.name);
    if (!isInside(sessionRoot, projectDir)) continue;
    let names;
    try {
      names = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -".json".length);
      if (!isOpenCodeSessionId(sessionId)) continue;
      const full = path.join(projectDir, name);
      if (!isInside(sessionRoot, full)) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let mtimeMs = st.mtimeMs;
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        const updated = raw && raw.time && Number(raw.time.updated);
        if (Number.isFinite(updated) && updated > 0) mtimeMs = updated;
      } catch {
        // keep file mtime
      }
      onFile({ sessionId, file: full, mtimeMs });
    }
  }
}

/**
 * @param {string} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listOpenCodeJsonSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkOpenCodeJsonSessions(home, (info) => {
    const prev = byId.get(info.sessionId);
    if (!prev || info.mtimeMs >= prev.mtimeMs) {
      byId.set(info.sessionId, {
        sessionId: info.sessionId,
        mtimeMs: info.mtimeMs,
      });
    }
  });
  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Locate one sessionId JSON under storage/session/. Newest mtime wins.
 * Shared by import and reclaim.
 *
 * @param {string} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findOpenCodeJsonSessionFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkOpenCodeJsonSessions(home, (info) => {
    if (info.sessionId !== id) return;
    if (info.mtimeMs >= foundMtime) {
      found = info.file;
      foundMtime = info.mtimeMs;
    }
  });
  return found;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function openCodeJsonTime(value) {
  if (!value || typeof value !== "object") return 0;
  const created = Number(value.created);
  return Number.isFinite(created) ? created : 0;
}

/**
 * @param {string} dir
 * @param {string} bound
 * @returns {{ id: string, data: object, createdAt: number }[]}
 */
function readOpenCodeJsonDir(dir, bound) {
  if (!isInside(bound, dir)) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {{ id: string, data: object, createdAt: number }[]} */
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isOpenCodeSessionId(id)) continue;
    const full = path.join(dir, name);
    if (!isInside(dir, full)) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    rows.push({
      id: typeof parsed.id === "string" && parsed.id ? parsed.id : id,
      data: parsed,
      createdAt: openCodeJsonTime(parsed.time) || st.mtimeMs,
    });
  }
  rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return rows;
}

/**
 * @param {string} home
 * @param {string} sessionId
 * @param {string} messageId
 */
function readOpenCodeJsonPartTexts(home, sessionId, messageId) {
  const storage = path.resolve(String(home || ""), "storage");
  const dirs = [
    path.join(storage, "part", messageId),
    path.join(storage, "part", sessionId, messageId),
  ];
  /** @type {{ id: string, data: object, createdAt: number }[]} */
  const parts = [];
  for (const dir of dirs) {
    parts.push(...readOpenCodeJsonDir(dir, storage));
  }
  parts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const texts = [];
  for (const part of parts) {
    const text = openCodePartText(part.data);
    if (text) texts.push(text);
  }
  return texts;
}

/**
 * @param {string} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readOpenCodeJsonTurns(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return [];
  if (!findOpenCodeJsonSessionFile(home, id)) return [];
  const storage = path.resolve(String(home || ""), "storage");
  const msgDir = path.join(storage, "message", id);
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  for (const msg of readOpenCodeJsonDir(msgDir, storage)) {
    const role = msg.data.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = readOpenCodeJsonPartTexts(home, id, msg.id).join("\n").trim();
    if (!text) continue;
    turns.push({
      role,
      text,
      createdAt: msg.createdAt || 0,
    });
  }
  return turns;
}

/**
 * List candidate OpenCode sessions from OPENCODE_HOME/opencode.db.
 * Newest time_updated wins when the same sessionId appears twice.
 * Missing db or no session table → pre-1.14 JSON tree under storage/.
 * Does not copy ~/.opencode or ~/.local/share/opencode.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listOpenCodeSessions(home) {
  const resolved = resolveOpenCodeHome(home);
  if (shouldUseOpenCodeJson(resolved)) {
    return listOpenCodeJsonSessions(resolved);
  }
  const dbPath = path.join(resolved, "opencode.db");
  const db = openOpenCodeDb(dbPath);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT id, time_updated FROM session").all();
    /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
    const byId = new Map();
    for (const row of rows || []) {
      const sessionId = String(row.id || "");
      if (!isOpenCodeSessionId(sessionId)) continue;
      const mtimeMs = Number(row.time_updated) || 0;
      const prev = byId.get(sessionId);
      if (!prev || mtimeMs >= prev.mtimeMs) {
        byId.set(sessionId, { sessionId, mtimeMs });
      }
    }
    return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 */
function openCodeSessionExists(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return false;
  const resolved = resolveOpenCodeHome(home);
  if (shouldUseOpenCodeJson(resolved)) {
    return Boolean(findOpenCodeJsonSessionFile(resolved, id));
  }
  const dbPath = path.join(resolved, "opencode.db");
  const db = openOpenCodeDb(dbPath);
  if (!db) return false;
  try {
    const row = db.prepare("SELECT 1 AS ok FROM session WHERE id = ?").get(id);
    return Boolean(row);
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * @param {unknown} data
 * @returns {string}
 */
function openCodePartText(data) {
  if (!data || typeof data !== "object") return "";
  if (data.type !== "text") return "";
  return typeof data.text === "string" ? data.text.trim() : "";
}

/**
 * Read user/assistant text parts for one OpenCode sessionId.
 * Skips reasoning, tool, and step parts. Shared by import and reclaim.
 *
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readOpenCodeImportTurns(home, sessionId) {
  const id = String(sessionId || "");
  if (!isOpenCodeSessionId(id)) return [];
  const resolved = resolveOpenCodeHome(home);
  if (shouldUseOpenCodeJson(resolved)) {
    return readOpenCodeJsonTurns(resolved, id);
  }
  const dbPath = path.join(resolved, "opencode.db");
  const db = openOpenCodeDb(dbPath);
  if (!db) return [];
  try {
    if (
      !openCodeTableExists(db, "message") ||
      !openCodeTableExists(db, "part")
    ) {
      return [];
    }
    const messages = db
      .prepare(
        "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id",
      )
      .all(id);
    /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
    const turns = [];
    for (const msg of messages || []) {
      let parsed;
      try {
        parsed = JSON.parse(String(msg.data || ""));
      } catch {
        continue;
      }
      const role = parsed && parsed.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = db
        .prepare(
          "SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id",
        )
        .all(msg.id);
      const texts = [];
      for (const part of parts || []) {
        let pdata;
        try {
          pdata = JSON.parse(String(part.data || ""));
        } catch {
          continue;
        }
        const text = openCodePartText(pdata);
        if (text) texts.push(text);
      }
      const text = texts.join("\n").trim();
      if (!text) continue;
      turns.push({
        role,
        text,
        createdAt: Number(msg.time_created) || 0,
      });
    }
    return turns;
  } finally {
    closeOpenCodeDb(db);
  }
}

/**
 * Create a Solenta thread from one OpenCode session row.
 * Idempotent on provider=opencode + sessionId so re-import does not duplicate.
 * Re-import absorbs turns added on disk since the last import.
 * Does not copy ~/.opencode or ~/.local/share/opencode.
 * Reclaim uses absorbOpenCodeSessionTurns.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importOpenCodeSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isOpenCodeSessionId(sessionId)) {
    throw new Error("Invalid OpenCode session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveOpenCodeHome(input && input.home);
  if (!openCodeSessionExists(home, sessionId)) {
    throw new Error(`OpenCode session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "opencode" && t.sessionId === sessionId,
  );
  return commitImportedTurns(store, {
    existing,
    projectId,
    provider: "opencode",
    sessionId,
    turns: readOpenCodeImportTurns(home, sessionId),
    defaultTitle: "Imported OpenCode session",
  });
}

/**
 * Reclaim: re-read the OpenCode session by sessionId (import-path reader,
 * sqlite or JSON fallback, not cwd) and append turns that are not already
 * in the Solenta transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbOpenCodeSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "opencode") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(
    store,
    thread.id,
    readOpenCodeImportTurns(home, sessionId),
  );
}

module.exports = {
  resolveOpenCodeHome,
  listOpenCodeSessions,
  readOpenCodeImportTurns,
  importOpenCodeSession,
  absorbOpenCodeSessionTurns,
  openOpenCodeDb,
  closeOpenCodeDb,
};
