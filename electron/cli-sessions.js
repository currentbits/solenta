"use strict";

/**
 * Provider CLI session transcript reader.
 *
 * #433 / #972 / #970 / #975 / #976 import scans a sessions directory with this parser
 * (Codex: listCodexSessions / importCodexSession under CODEX_HOME/sessions;
 * Grok: listGrokSessions / importGrokSession under GROK_HOME/sessions;
 * Claude: listClaudeSessions / importClaudeSession under
 * CLAUDE_CONFIG_DIR/projects;
 * Cursor: listCursorSessions / importCursorSession under
 * ~/.cursor/projects/<group>/agent-transcripts/<id>/<id>.jsonl;
 * OpenCode: listOpenCodeSessions / importOpenCodeSession under
 * OPENCODE_HOME/opencode.db, default XDG_DATA_HOME/opencode. When the db
 * is missing or has no session table, walk the pre-1.14 JSON tree at
 * storage/session/<projectID>/<sessionID>.json plus message/ and part/).
 * #554 reclaim points it at one known sessionId (Codex: date-tree suffix
 * match; Claude and Grok: direct cwd-encoded path, no directory scan;
 * Cursor and OpenCode: the same sessionId scan as import, not cwd;
 * Kimi and Muse: sessionId scan of wire.jsonl / session.jsonl, not cwd).
 * Claude import walks projects/<group>/<sessionId>.jsonl; reclaim still
 * uses cwd+sessionId only. Claude long cwds
 * use Claude Code 2.1.x's 200-char dash prefix plus abs(djb2).toString(36).
 * When that hashed dir misses, overflow lookup readdirs projects/ top-level
 * names that start with encoded.slice(0,200)+'-' and stats the known
 * sessionId jsonl (Claude Code 2.1.219 LM()) — not a walk of every project.
 * Claude Code 2.1.219 Nqe() realpaths cwd (GR: realpath then NFC) before
 * RA()/LM(); if RA(cwd) misses and GR(cwd) differs, retry that hashed name
 * and its overflow prefix siblings. After LM still misses, e4l lists git
 * worktrees of that cwd (porcelain, excluding cwd itself) and runs LM() +
 * jsonl stat in each. Grok long cwds use grok-build's slug+blake3 dirname.
 * Do not copy the provider store.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { blake3Hex } = require("./blake3.js");

const GROK_ENCODED_CWD_DIR_MAX_BYTES = 255;
const CLAUDE_PROJECT_DIR_MAX_CHARS = 200;

/** Filename: rollout-YYYY-MM-DDTHH-MM-SS-<sessionId>.jsonl */
const ROLLOUT_NAME =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-zA-Z-]+)\.jsonl$/;

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveCodexHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return path.join(os.homedir(), ".codex");
}

/**
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Walk date-sharded `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`.
 * The walk cannot leave `sessions/`.
 * @param {string} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkCodexRollouts(home, onFile) {
  const sessionsDir = path.resolve(String(home || ""), "sessions");
  let years;
  try {
    years = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const year of years) {
    if (!year.isDirectory() && !year.isSymbolicLink()) continue;
    const yearDir = path.join(sessionsDir, year.name);
    if (!isInside(sessionsDir, yearDir)) continue;
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory() && !month.isSymbolicLink()) continue;
      const monthDir = path.join(yearDir, month.name);
      if (!isInside(sessionsDir, monthDir)) continue;
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory() && !day.isSymbolicLink()) continue;
        const dayDir = path.join(monthDir, day.name);
        if (!isInside(sessionsDir, dayDir)) continue;
        let names;
        try {
          names = fs.readdirSync(dayDir);
        } catch {
          continue;
        }
        for (const name of names) {
          const match = ROLLOUT_NAME.exec(name);
          if (!match) continue;
          const sessionId = match[1];
          const full = path.join(dayDir, name);
          if (!isInside(sessionsDir, full)) continue;
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(full).mtimeMs;
          } catch {
            continue;
          }
          onFile({ sessionId, file: full, mtimeMs });
        }
      }
    }
  }
}

/**
 * Codex rollout files are `sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl`.
 * @param {string} home CODEX_HOME
 * @param {string} sessionId
 * @returns {string | null}
 */
function findCodexSessionFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!/^[0-9a-zA-Z-]+$/.test(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkCodexRollouts(home, (info) => {
    if (info.sessionId !== id) return;
    if (info.mtimeMs >= foundMtime) {
      found = info.file;
      foundMtime = info.mtimeMs;
    }
  });
  return found;
}

/**
 * Codex injects XML-wrapped user blobs (plugins, skills, env) into the
 * rollout. Those are not conversation turns.
 * @param {string} text
 */
function isInjectedUserText(text) {
  return /^<[a-zA-Z][\w-]*>/.test(text);
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part === "string") out += part;
    else if (part && typeof part === "object" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}

/**
 * @param {string} text JSONL rollout
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseCodexRollout(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || obj.type !== "response_item") continue;
    const payload = obj.payload;
    if (!payload || typeof payload !== "object") continue;
    if (payload.type && payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const textValue = contentText(payload.content).trim();
    if (!textValue) continue;
    if (role === "user" && isInjectedUserText(textValue)) continue;
    const createdAt = Date.parse(String(obj.timestamp || "")) || 0;
    turns.push({ role, text: textValue, createdAt });
  }
  return turns;
}

/**
 * @param {string} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readCodexSessionTurns(home, sessionId) {
  const file = findCodexSessionFile(home, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseCodexRollout(text);
}

/**
 * List candidate Codex rollouts under CODEX_HOME/sessions.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listCodexSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkCodexRollouts(resolveCodexHome(home), (info) => {
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
 * Create a Solenta thread from one Codex rollout. Reuses parseCodexRollout.
 * Idempotent on provider=codex + sessionId so re-import does not duplicate.
 * Does not copy ~/.codex and does not touch reclaim.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importCodexSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!/^[0-9a-zA-Z-]+$/.test(sessionId)) {
    throw new Error("Invalid Codex session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveCodexHome(input && input.home);
  if (!findCodexSessionFile(home, sessionId)) {
    throw new Error(`Codex session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "codex" && t.sessionId === sessionId,
  );
  if (existing) return existing;

  const turns = readCodexSessionTurns(home, sessionId);
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId,
    title: titleLine || "Imported Codex session",
    provider: "codex",
  });
  store.updateThread(thread.id, { sessionId });
  for (const turn of turns) {
    store.appendMessage(thread.id, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
  }
  store.save();
  return store.getThread(thread.id);
}

/**
 * Append provider turns that are not already in the Solenta transcript.
 * Match by role+text occurrence count so reclaim is idempotent.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {{ role: "user" | "assistant", text: string, createdAt: number }[]} turns
 * @returns {number} appended count
 */
function absorbTurns(store, threadId, turns) {
  if (!turns.length) return 0;
  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const msg of store.getMessages(threadId) || []) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const key = `${msg.role}\0${msg.text}`;
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  let appended = 0;
  for (const turn of turns) {
    const key = `${turn.role}\0${turn.text}`;
    const left = remaining.get(key) || 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      continue;
    }
    store.appendMessage(threadId, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
    appended += 1;
  }
  return appended;
}

/**
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number} appended count
 */
function absorbCodexSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "codex") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId || sessionId === "cwd") return 0;
  return absorbTurns(store, thread.id, readCodexSessionTurns(home, sessionId));
}

function isPathSafeSessionId(sessionId) {
  return /^[0-9a-zA-Z-]+$/.test(String(sessionId || ""));
}

/**
 * Claude Code's project-dir djb2 (signed 32-bit), used when the dash-encoded
 * cwd is longer than 200 chars.
 * @param {string} text
 * @returns {number}
 */
function claudeDjb2(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Claude Code stores sessions at `projects/<cwd-with-non-alnum-as-dash>/<id>.jsonl`.
 * When that name exceeds 200 chars, Claude Code 2.1.x writes
 * `{encoded.slice(0,200)}-{abs(djb2(cwd)).toString(36)}` instead of ENAMETOOLONG.
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function encodeClaudeProjectDir(cwd) {
  const raw = String(cwd || "");
  if (!raw) return "";
  const encoded = raw.replace(/[^A-Za-z0-9]/g, "-");
  if (encoded.length <= CLAUDE_PROJECT_DIR_MAX_CHARS) return encoded;
  return `${encoded.slice(0, CLAUDE_PROJECT_DIR_MAX_CHARS)}-${Math.abs(claudeDjb2(raw)).toString(36)}`;
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function existingClaudeSessionJsonl(file) {
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size > 0) return file;
  } catch {
    // missing or unreadable
  }
  return null;
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveClaudeHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), ".claude");
}

/**
 * Claude Code 2.1.219 GR(): `Fd(realpath(cwd))` with Fd = NFC.
 * Missing or unreadable cwd falls back to NFC of the input. One realpath
 * of the known lookup cwd — not a walk of projects/.
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function realpathClaudeCwd(cwd) {
  const raw = String(cwd || "");
  if (!raw) return "";
  try {
    return fs.realpathSync(raw).normalize("NFC");
  } catch {
    return raw.normalize("NFC");
  }
}

/**
 * Claude Code 2.1.219 Gue(): `git worktree list --porcelain` in cwd.
 * Empty on missing git, non-repo, or timeout. Not a projects/ scan.
 * @param {string} cwd
 * @returns {string[]}
 */
function listClaudeGitWorktrees(cwd) {
  if (!cwd) return [];
  try {
    const stdout = execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=",
        "worktree",
        "list",
        "--porcelain",
      ],
      {
        cwd: String(cwd),
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!stdout) return [];
    const paths = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      paths.push(line.slice(9).normalize("NFC"));
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Claude Code 2.1.219 LM(cwd): RA() dir first, then overflow prefix
 * siblings. Stats the known sessionId jsonl. Does not walk every project.
 * Short RA() names have no prefix siblings.
 * @param {string} projectsDir
 * @param {string} cwd
 * @param {string} jsonl
 * @returns {string | null}
 */
function findClaudeJsonlViaLm(projectsDir, cwd, jsonl) {
  const encoded = encodeClaudeProjectDir(cwd);
  if (!encoded) return null;
  const direct = existingClaudeSessionJsonl(path.join(projectsDir, encoded, jsonl));
  if (direct) return direct;
  // LM(): short RA() names have no prefix siblings.
  if (encoded.length <= CLAUDE_PROJECT_DIR_MAX_CHARS) return null;
  const prefix = `${encoded.slice(0, CLAUDE_PROJECT_DIR_MAX_CHARS)}-`;
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    if (entry.name === encoded) continue;
    const sibling = existingClaudeSessionJsonl(
      path.join(projectsDir, entry.name, jsonl),
    );
    if (sibling) return sibling;
  }
  return null;
}

/**
 * Solenta hashes the stored worktreePath first so a present RA(cwd) still
 * wins. On a miss, GR() (realpath then NFC) retries RA(realpath) and its
 * overflow prefix siblings. If LM still misses, e4l lists git worktrees of
 * the GR() cwd (except cwd) and runs LM() on each — not a walk of every
 * project dir.
 * @param {string} home
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string | null}
 */
function findClaudeSessionFile(home, cwd, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  const rawCwd = String(cwd || "");
  if (!rawCwd) return null;
  const projectsDir = path.join(String(home || ""), "projects");
  const jsonl = `${id}.jsonl`;
  const stored = findClaudeJsonlViaLm(projectsDir, rawCwd, jsonl);
  if (stored) return stored;
  const resolved = realpathClaudeCwd(rawCwd);
  if (resolved && resolved !== rawCwd) {
    const viaRealpath = findClaudeJsonlViaLm(projectsDir, resolved, jsonl);
    if (viaRealpath) return viaRealpath;
  }
  const gitCwd = resolved || rawCwd;
  for (const worktreePath of listClaudeGitWorktrees(gitCwd)) {
    if (worktreePath === gitCwd || worktreePath === rawCwd) continue;
    const sibling = findClaudeJsonlViaLm(projectsDir, worktreePath, jsonl);
    if (sibling) return sibling;
  }
  return null;
}

/**
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseClaudeJsonl(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || (obj.type !== "user" && obj.type !== "assistant")) continue;
    if (obj.isSidechain === true) continue;
    const message = obj.message;
    if (!message || typeof message !== "object") continue;
    const role =
      message.role === "assistant" || obj.type === "assistant"
        ? "assistant"
        : "user";
    const textValue = contentText(message.content).trim();
    if (!textValue) continue;
    if (role === "user" && isInjectedUserText(textValue)) continue;
    const createdAt = Date.parse(String(obj.timestamp || "")) || 0;
    turns.push({ role, text: textValue, createdAt });
  }
  return turns;
}

/**
 * @param {string} home
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readClaudeSessionTurns(home, cwd, sessionId) {
  const file = findClaudeSessionFile(home, cwd, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseClaudeJsonl(text);
}

/** Filename: <sessionId>.jsonl directly under a project group. */
const CLAUDE_SESSION_NAME = /^([0-9a-zA-Z-]+)\.jsonl$/;

/**
 * Walk `projects/<group>/<sessionId>.jsonl`. Does not recurse into group
 * subdirs. The walk cannot leave `projects/`.
 *
 * @param {string | null | undefined} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkClaudeSessions(home, onFile) {
  const projectsDir = path.resolve(resolveClaudeHome(home), "projects");
  let groups;
  try {
    groups = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const group of groups) {
    if (!group.isDirectory() && !group.isSymbolicLink()) continue;
    const groupDir = path.join(projectsDir, group.name);
    if (!isInside(projectsDir, groupDir)) continue;
    let names;
    try {
      names = fs.readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = CLAUDE_SESSION_NAME.exec(name);
      if (!match) continue;
      const sessionId = match[1];
      const full = path.join(groupDir, name);
      if (!isInside(projectsDir, full)) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      onFile({ sessionId, file: full, mtimeMs: st.mtimeMs });
    }
  }
}

/**
 * List candidate Claude jsonl files under CLAUDE_CONFIG_DIR/projects.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listClaudeSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkClaudeSessions(home, (info) => {
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
 * Import scan: locate one sessionId jsonl under projects/. Newest mtime
 * wins. Distinct from findClaudeSessionFile (reclaim, cwd+sessionId).
 *
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findClaudeImportFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkClaudeSessions(home, (info) => {
    if (info.sessionId !== id) return;
    if (info.mtimeMs >= foundMtime) {
      found = info.file;
      foundMtime = info.mtimeMs;
    }
  });
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readClaudeImportTurns(home, sessionId) {
  const file = findClaudeImportFile(home, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseClaudeJsonl(text);
}

/**
 * Create a Solenta thread from one Claude jsonl. Reuses parseClaudeJsonl.
 * Idempotent on provider=claude + sessionId so re-import does not duplicate.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importClaudeSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isPathSafeSessionId(sessionId)) {
    throw new Error("Invalid Claude session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveClaudeHome(input && input.home);
  if (!findClaudeImportFile(home, sessionId)) {
    throw new Error(`Claude session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "claude" && t.sessionId === sessionId,
  );
  if (existing) return existing;

  const turns = readClaudeImportTurns(home, sessionId);
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId,
    title: titleLine || "Imported Claude session",
    provider: "claude",
  });
  store.updateThread(thread.id, { sessionId });
  for (const turn of turns) {
    store.appendMessage(thread.id, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
  }
  store.save();
  return store.getThread(thread.id);
}

/**
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @param {string} cwd
 * @returns {number}
 */
function absorbClaudeSessionTurns(store, thread, home, cwd) {
  if (!thread || thread.provider !== "claude") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(
    store,
    thread.id,
    readClaudeSessionTurns(home, cwd, sessionId),
  );
}

/**
 * Grok's dirname slug: lowercase ascii alnum, other runs become one dash,
 * trim dashes, take `maxLen` chars. Empty after that becomes "workspace"
 * at the call site.
 * @param {string} input
 * @param {number} maxLen
 * @returns {string}
 */
function slugifyGrok(input, maxLen) {
  let result = "";
  let prevDash = false;
  for (const c of String(input).toLowerCase()) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
      result += c;
      prevDash = false;
    } else if (!prevDash) {
      result += "-";
      prevDash = true;
    }
  }
  const trimmed = result.replace(/^-+|-+$/g, "");
  return [...trimmed].slice(0, maxLen).join("");
}

/**
 * Grok stores sessions at `sessions/<encoded-cwd>/<id>/`.
 * Short cwds: encodeURIComponent (Grok's urlencoding crate, same for
 * typical Unix paths). When that exceeds 255 bytes, Grok uses
 * `{slugify(basename, 40)|workspace}-{blake3(cwd)[:16]}` and writes
 * the original path to a `.cwd` file. Direct path only: no sessions/ scan.
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
function encodeGrokSessionDir(cwd) {
  const raw = String(cwd || "");
  if (!raw) return "";
  const encoded = encodeURIComponent(raw);
  if (Buffer.byteLength(encoded, "utf8") <= GROK_ENCODED_CWD_DIR_MAX_BYTES) {
    return encoded;
  }
  const leaf = path.basename(raw) || "workspace";
  const slug = slugifyGrok(leaf, 40) || "workspace";
  return `${slug}-${blake3Hex(raw).slice(0, 16)}`;
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveGrokHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.GROK_HOME) return process.env.GROK_HOME;
  return path.join(os.homedir(), ".grok");
}

/**
 * Direct path to chat_history.jsonl. No sessions/ scan.
 * @param {string} home
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string | null}
 */
function findGrokSessionFile(home, cwd, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  const encoded = encodeGrokSessionDir(cwd);
  if (!encoded) return null;
  const file = path.join(
    String(home || ""),
    "sessions",
    encoded,
    id,
    "chat_history.jsonl",
  );
  try {
    fs.statSync(file);
    return file;
  } catch {
    return null;
  }
}

/**
 * Prefer <user_query> inner text; skip remaining XML-wrapped blobs.
 * @param {string} text
 * @returns {string}
 */
function grokUserText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (query) return query[1].trim();
  if (isInjectedUserText(raw)) return "";
  return raw;
}

/**
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseGrokChatHistory(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || (obj.type !== "user" && obj.type !== "assistant")) continue;
    if (obj.synthetic_reason) continue;
    const role = obj.type === "assistant" ? "assistant" : "user";
    let textValue = contentText(obj.content).trim();
    if (role === "user") textValue = grokUserText(textValue);
    if (!textValue) continue;
    turns.push({ role, text: textValue, createdAt: 0 });
  }
  return turns;
}

/**
 * @param {string} home
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readGrokSessionTurns(home, cwd, sessionId) {
  const file = findGrokSessionFile(home, cwd, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseGrokChatHistory(text);
}

/**
 * Walk `sessions/<encoded-cwd>/<sessionId>/chat_history.jsonl`. Does not
 * recurse past that depth. The walk cannot leave `sessions/`. Distinct
 * from findGrokSessionFile (reclaim, cwd+sessionId, no scan).
 *
 * @param {string | null | undefined} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkGrokSessions(home, onFile) {
  const sessionsDir = path.resolve(resolveGrokHome(home), "sessions");
  let groups;
  try {
    groups = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const group of groups) {
    if (!group.isDirectory() && !group.isSymbolicLink()) continue;
    const groupDir = path.join(sessionsDir, group.name);
    if (!isInside(sessionsDir, groupDir)) continue;
    let ids;
    try {
      ids = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of ids) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sessionId = entry.name;
      if (!isPathSafeSessionId(sessionId)) continue;
      const file = path.join(groupDir, sessionId, "chat_history.jsonl");
      if (!isInside(sessionsDir, file)) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      onFile({ sessionId, file, mtimeMs: st.mtimeMs });
    }
  }
}

/**
 * List candidate Grok sessions under GROK_HOME/sessions.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listGrokSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkGrokSessions(home, (info) => {
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
 * Import scan: locate one sessionId chat_history.jsonl under sessions/.
 * Newest mtime wins. Distinct from findGrokSessionFile (reclaim).
 *
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findGrokImportFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkGrokSessions(home, (info) => {
    if (info.sessionId !== id) return;
    if (info.mtimeMs >= foundMtime) {
      found = info.file;
      foundMtime = info.mtimeMs;
    }
  });
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readGrokImportTurns(home, sessionId) {
  const file = findGrokImportFile(home, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseGrokChatHistory(text);
}

/**
 * Create a Solenta thread from one Grok chat_history.jsonl.
 * Idempotent on provider=grok + sessionId so re-import does not duplicate.
 * Does not copy ~/.grok and does not touch reclaim.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importGrokSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isPathSafeSessionId(sessionId)) {
    throw new Error("Invalid Grok session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveGrokHome(input && input.home);
  if (!findGrokImportFile(home, sessionId)) {
    throw new Error(`Grok session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "grok" && t.sessionId === sessionId,
  );
  if (existing) return existing;

  const turns = readGrokImportTurns(home, sessionId);
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId,
    title: titleLine || "Imported Grok session",
    provider: "grok",
  });
  store.updateThread(thread.id, { sessionId });
  for (const turn of turns) {
    store.appendMessage(thread.id, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
  }
  store.save();
  return store.getThread(thread.id);
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveCursorHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.CURSOR_HOME) return process.env.CURSOR_HOME;
  return path.join(os.homedir(), ".cursor");
}

/**
 * Prefer <user_query> inner text; skip remaining XML-wrapped blobs.
 * Cursor agent-transcripts wrap the prompt the same way Grok does.
 * @param {string} text
 * @returns {string}
 */
function cursorUserText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (query) return query[1].trim();
  if (isInjectedUserText(raw)) return "";
  return raw;
}

/**
 * Cursor CLI transcripts are JSONL at
 * `projects/<group>/agent-transcripts/<sessionId>/<sessionId>.jsonl`.
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseCursorJsonl(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || (obj.role !== "user" && obj.role !== "assistant")) continue;
    const message = obj.message;
    if (!message || typeof message !== "object") continue;
    const role = obj.role === "assistant" ? "assistant" : "user";
    let textValue = contentText(message.content).trim();
    if (role === "user") textValue = cursorUserText(textValue);
    if (!textValue) continue;
    if (role === "user" && isInjectedUserText(textValue)) continue;
    turns.push({ role, text: textValue, createdAt: 0 });
  }
  return turns;
}

/**
 * Walk `projects/<group>/agent-transcripts/<sessionId>/<sessionId>.jsonl`.
 * Does not recurse past that depth. The walk cannot leave `projects/`.
 *
 * @param {string | null | undefined} home
 * @param {(info: { sessionId: string, file: string, mtimeMs: number }) => void} onFile
 */
function walkCursorSessions(home, onFile) {
  const projectsDir = path.resolve(resolveCursorHome(home), "projects");
  let groups;
  try {
    groups = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const group of groups) {
    if (!group.isDirectory() && !group.isSymbolicLink()) continue;
    const groupDir = path.join(projectsDir, group.name);
    if (!isInside(projectsDir, groupDir)) continue;
    const transcriptsDir = path.join(groupDir, "agent-transcripts");
    if (!isInside(projectsDir, transcriptsDir)) continue;
    let ids;
    try {
      ids = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of ids) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sessionId = entry.name;
      if (!isPathSafeSessionId(sessionId)) continue;
      const file = path.join(transcriptsDir, sessionId, `${sessionId}.jsonl`);
      if (!isInside(projectsDir, file)) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      onFile({ sessionId, file, mtimeMs: st.mtimeMs });
    }
  }
}

/**
 * List candidate Cursor sessions under CURSOR_HOME/projects.
 * Newest mtime wins when the same sessionId appears twice.
 *
 * @param {string | null | undefined} home
 * @returns {{ sessionId: string, mtimeMs: number }[]}
 */
function listCursorSessions(home) {
  /** @type {Map<string, { sessionId: string, mtimeMs: number }>} */
  const byId = new Map();
  walkCursorSessions(home, (info) => {
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
 * Locate one sessionId jsonl under projects/. Newest mtime wins.
 * Shared by import and reclaim; both scan by sessionId, not cwd.
 *
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findCursorImportFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  let found = null;
  let foundMtime = -1;
  walkCursorSessions(home, (info) => {
    if (info.sessionId !== id) return;
    if (info.mtimeMs >= foundMtime) {
      found = info.file;
      foundMtime = info.mtimeMs;
    }
  });
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readCursorImportTurns(home, sessionId) {
  const file = findCursorImportFile(home, sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseCursorJsonl(text);
}

/**
 * Create a Solenta thread from one Cursor agent-transcript jsonl.
 * Idempotent on provider=cursor + sessionId so re-import does not duplicate.
 * Does not copy ~/.cursor. Reclaim uses absorbCursorSessionTurns.
 *
 * @param {import("./store").Store} store
 * @param {{ sessionId: string, projectId: string, home?: string | null }} input
 */
function importCursorSession(store, input) {
  const sessionId = String((input && input.sessionId) || "");
  if (!isPathSafeSessionId(sessionId)) {
    throw new Error("Invalid Cursor session id");
  }
  const projectId = input && input.projectId;
  if (!projectId) {
    throw new Error("projectId is required");
  }
  const home = resolveCursorHome(input && input.home);
  if (!findCursorImportFile(home, sessionId)) {
    throw new Error(`Cursor session not found: ${sessionId}`);
  }
  const existing = (store.getThreads() || []).find(
    (t) => t && t.provider === "cursor" && t.sessionId === sessionId,
  );
  if (existing) return existing;

  const turns = readCursorImportTurns(home, sessionId);
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId,
    title: titleLine || "Imported Cursor session",
    provider: "cursor",
  });
  store.updateThread(thread.id, { sessionId });
  for (const turn of turns) {
    store.appendMessage(thread.id, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
  }
  store.save();
  return store.getThread(thread.id);
}

/**
 * Reclaim: re-read the Cursor jsonl by sessionId (import-path scan, not
 * cwd) and append turns that are not already in the Solenta transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbCursorSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "cursor") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(store, thread.id, readCursorImportTurns(home, sessionId));
}

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
  if (existing) return existing;

  const turns = readOpenCodeImportTurns(home, sessionId);
  const firstUser = turns.find((t) => t.role === "user");
  const titleLine = firstUser
    ? String(firstUser.text).split(/\r?\n/, 1)[0].trim()
    : "";
  const { createThread } = require("./services.js");
  const thread = createThread(store, {
    projectId,
    title: titleLine || "Imported OpenCode session",
    provider: "opencode",
  });
  store.updateThread(thread.id, { sessionId });
  for (const turn of turns) {
    store.appendMessage(thread.id, {
      id: randomUUID(),
      role: turn.role,
      text: turn.text,
      createdAt: turn.createdAt || Date.now(),
    });
  }
  store.save();
  return store.getThread(thread.id);
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

/**
 * Kimi session ids are `session_<uuid>` (underscore). Path-safe: no
 * slashes or `..`. Broader than isPathSafeSessionId.
 * @param {string} sessionId
 */
function isKimiSessionId(sessionId) {
  const id = String(sessionId || "");
  return id.length > 0 && /^[0-9A-Za-z_-]+$/.test(id);
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveKimiHome(home) {
  if (home != null && String(home) !== "") return String(home);
  if (process.env.KIMI_CODE_HOME) return process.env.KIMI_CODE_HOME;
  return path.join(os.homedir(), ".kimi-code");
}

/**
 * @param {unknown} input
 * @returns {string}
 */
function kimiPromptText(input) {
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return "";
    try {
      return kimiPromptText(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  if (!Array.isArray(input)) return "";
  const parts = [];
  for (const part of input) {
    if (typeof part === "string") {
      if (part) parts.push(part);
      continue;
    }
    if (
      part &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

/**
 * Kimi wire.jsonl: user `turn.prompt` (origin.kind user) and assistant
 * `context.append_loop_event` content.part type=text. Consecutive text
 * parts that share event.turnId (or, with no turnId, until the next
 * turn.prompt) join into one assistant turn so absorbTurns matches
 * Solenta's concatenated stream message. Skip think parts. Role-shaped
 * `{role, content}` lines are a fallback for older wires.
 *
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseKimiWire(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  /** @type {{ text: string, createdAt: number, turnId: string | null } | null} */
  let pending = null;

  const flushPending = () => {
    if (!pending) return;
    const textValue = pending.text.trim();
    if (textValue) {
      turns.push({
        role: "assistant",
        text: textValue,
        createdAt: pending.createdAt,
      });
    }
    pending = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const createdAt = Number(obj.time) || 0;
    if (obj.type === "turn.prompt") {
      flushPending();
      const origin = obj.origin;
      if (
        origin &&
        typeof origin === "object" &&
        origin.kind &&
        origin.kind !== "user"
      ) {
        continue;
      }
      const textValue = kimiPromptText(obj.input);
      if (!textValue) continue;
      if (isInjectedUserText(textValue)) continue;
      turns.push({ role: "user", text: textValue, createdAt });
      continue;
    }
    if (obj.type === "context.append_loop_event") {
      const ev = obj.event;
      if (!ev || typeof ev !== "object" || ev.type !== "content.part") {
        continue;
      }
      const part = ev.part;
      if (!part || typeof part !== "object" || part.type !== "text") continue;
      const piece = typeof part.text === "string" ? part.text : "";
      if (!piece) continue;
      const turnId = ev.turnId != null ? String(ev.turnId) : null;
      if (
        pending &&
        (pending.turnId == null || turnId == null || pending.turnId === turnId)
      ) {
        pending.text += piece;
        continue;
      }
      flushPending();
      pending = { text: piece, createdAt, turnId };
      continue;
    }
    if (obj.role === "user" || obj.role === "assistant") {
      flushPending();
      const textValue = contentText(obj.content).trim();
      if (!textValue) continue;
      if (obj.role === "user" && isInjectedUserText(textValue)) continue;
      turns.push({
        role: obj.role === "assistant" ? "assistant" : "user",
        text: textValue,
        createdAt,
      });
    }
  }
  flushPending();
  return turns;
}

/**
 * Locate one sessionId wire.jsonl under sessions/<wd>/<id>/agents/.
 * Prefer agents/main. Newest mtime wins. Shared by reclaim; scan by
 * sessionId, not cwd. Does not copy ~/.kimi-code.
 *
 * @param {string} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findKimiWireFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isKimiSessionId(id)) return null;
  const sessionsDir = path.resolve(String(home || ""), "sessions");
  let wds;
  try {
    wds = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let found = null;
  let foundMtime = -1;
  let foundMain = false;
  for (const wd of wds) {
    if (!wd.isDirectory() && !wd.isSymbolicLink()) continue;
    const wdDir = path.join(sessionsDir, wd.name);
    if (!isInside(sessionsDir, wdDir)) continue;
    const agentsDir = path.join(wdDir, id, "agents");
    if (!isInside(sessionsDir, agentsDir)) continue;
    let agents;
    try {
      agents = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory() && !agent.isSymbolicLink()) continue;
      const wire = path.join(agentsDir, agent.name, "wire.jsonl");
      if (!isInside(sessionsDir, wire)) continue;
      let st;
      try {
        st = fs.statSync(wire);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const isMain = agent.name === "main";
      if (isMain) {
        if (!foundMain || st.mtimeMs >= foundMtime) {
          found = wire;
          foundMtime = st.mtimeMs;
          foundMain = true;
        }
      } else if (!foundMain && st.mtimeMs >= foundMtime) {
        found = wire;
        foundMtime = st.mtimeMs;
      }
    }
  }
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readKimiSessionTurns(home, sessionId) {
  const file = findKimiWireFile(resolveKimiHome(home), sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseKimiWire(text);
}

/**
 * Reclaim: re-read the Kimi wire.jsonl by sessionId (not cwd) and append
 * turns that are not already in the Solenta transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbKimiSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "kimi") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId || sessionId === "cwd") return 0;
  return absorbTurns(store, thread.id, readKimiSessionTurns(home, sessionId));
}

/**
 * @param {string | null | undefined} home
 * @returns {string}
 */
function resolveMuseHome(home) {
  if (home != null && String(home) !== "") return String(home);
  const xdg =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "muse");
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function museRecordedAt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Live session.jsonl uses microseconds.
  return n > 1e14 ? Math.floor(n / 1000) : n;
}

/**
 * Muse session.jsonl: live files use runtime.session
 * event.kind started+prompt (user) and assistant_message_committed (assistant).
 * Echo/stream leftovers: turn.input.user and run.terminal.completed.
 * Skip run.output.delta (same snapshot as terminal).
 *
 * @param {string} text JSONL
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function parseMuseJsonl(text) {
  /** @type {{ role: "user" | "assistant", text: string, createdAt: number }[]} */
  const turns = [];
  const raw = String(text || "");
  if (!raw) return turns;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const createdAt = museRecordedAt(obj.recorded_at);
    const type = obj.payload_type;
    const payload = obj.payload;
    if (type === "turn.input.user") {
      const prompt =
        payload && typeof payload.prompt === "string"
          ? payload.prompt.trim()
          : "";
      if (!prompt || isInjectedUserText(prompt)) continue;
      turns.push({ role: "user", text: prompt, createdAt });
      continue;
    }
    if (type === "run.terminal.completed") {
      const textValue =
        payload && typeof payload.text === "string"
          ? payload.text.trim()
          : "";
      if (!textValue) continue;
      turns.push({ role: "assistant", text: textValue, createdAt });
      continue;
    }
    if (type !== "runtime.session" || !payload || typeof payload !== "object") {
      continue;
    }
    const ev = payload.event;
    if (!ev || typeof ev !== "object") continue;
    if (ev.kind === "started" && typeof ev.prompt === "string") {
      const prompt = ev.prompt.trim();
      if (!prompt || isInjectedUserText(prompt)) continue;
      turns.push({ role: "user", text: prompt, createdAt });
      continue;
    }
    if (
      ev.kind === "assistant_message_committed" &&
      typeof ev.text === "string"
    ) {
      const textValue = ev.text.trim();
      if (!textValue) continue;
      turns.push({ role: "assistant", text: textValue, createdAt });
    }
  }
  return turns;
}

/**
 * Locate one sessionId session.jsonl under sessions/YYYY/MM/DD/<id>/.
 * Newest mtime wins. Scan by sessionId, not cwd. Does not copy the
 * XDG muse store. Never follows overlay dest.
 *
 * @param {string} home
 * @param {string} sessionId
 * @returns {string | null}
 */
function findMuseSessionFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!isPathSafeSessionId(id)) return null;
  const sessionsDir = path.resolve(String(home || ""), "sessions");
  let years;
  try {
    years = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let found = null;
  let foundMtime = -1;
  for (const year of years) {
    if (!year.isDirectory() && !year.isSymbolicLink()) continue;
    if (!/^\d{4}$/.test(year.name)) continue;
    const yearDir = path.join(sessionsDir, year.name);
    if (!isInside(sessionsDir, yearDir)) continue;
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory() && !month.isSymbolicLink()) continue;
      if (!/^(0[1-9]|1[0-2])$/.test(month.name)) continue;
      const monthDir = path.join(yearDir, month.name);
      if (!isInside(sessionsDir, monthDir)) continue;
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory() && !day.isSymbolicLink()) continue;
        if (!/^(0[1-9]|[12]\d|3[01])$/.test(day.name)) continue;
        const file = path.join(monthDir, day.name, id, "session.jsonl");
        if (!isInside(sessionsDir, file)) continue;
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.mtimeMs >= foundMtime) {
          found = file;
          foundMtime = st.mtimeMs;
        }
      }
    }
  }
  return found;
}

/**
 * @param {string | null | undefined} home
 * @param {string} sessionId
 * @returns {{ role: "user" | "assistant", text: string, createdAt: number }[]}
 */
function readMuseSessionTurns(home, sessionId) {
  const file = findMuseSessionFile(resolveMuseHome(home), sessionId);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseMuseJsonl(text);
}

/**
 * Reclaim: re-read the Muse session.jsonl by sessionId (date-sharded
 * scan, not cwd) and append turns that are not already in the Solenta
 * transcript.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @returns {number}
 */
function absorbMuseSessionTurns(store, thread, home) {
  if (!thread || thread.provider !== "muse") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(store, thread.id, readMuseSessionTurns(home, sessionId));
}

/**
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {string} home
 * @param {string} cwd
 * @returns {number}
 */
function absorbGrokSessionTurns(store, thread, home, cwd) {
  if (!thread || thread.provider !== "grok") return 0;
  const sessionId = thread.sessionId;
  if (!sessionId) return 0;
  return absorbTurns(
    store,
    thread.id,
    readGrokSessionTurns(home, cwd, sessionId),
  );
}

/**
 * Reclaim: re-read the known provider session and append outside turns.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @param {{ home?: string, cwd?: string }} [opts]
 * @returns {number}
 */
function absorbSessionTurns(store, thread, opts) {
  if (!thread) return 0;
  const home = opts && opts.home;
  const cwd = (opts && opts.cwd) || "";
  if (thread.provider === "codex") {
    return absorbCodexSessionTurns(store, thread, resolveCodexHome(home));
  }
  if (thread.provider === "claude") {
    return absorbClaudeSessionTurns(
      store,
      thread,
      resolveClaudeHome(home),
      cwd,
    );
  }
  if (thread.provider === "grok") {
    return absorbGrokSessionTurns(store, thread, resolveGrokHome(home), cwd);
  }
  if (thread.provider === "cursor") {
    return absorbCursorSessionTurns(store, thread, resolveCursorHome(home));
  }
  if (thread.provider === "opencode") {
    return absorbOpenCodeSessionTurns(
      store,
      thread,
      resolveOpenCodeHome(home),
    );
  }
  if (thread.provider === "kimi") {
    return absorbKimiSessionTurns(store, thread, resolveKimiHome(home));
  }
  if (thread.provider === "muse") {
    return absorbMuseSessionTurns(store, thread, resolveMuseHome(home));
  }
  return 0;
}

module.exports = {
  resolveCodexHome,
  findCodexSessionFile,
  parseCodexRollout,
  readCodexSessionTurns,
  listCodexSessions,
  importCodexSession,
  absorbCodexSessionTurns,
  resolveClaudeHome,
  encodeClaudeProjectDir,
  findClaudeSessionFile,
  parseClaudeJsonl,
  readClaudeSessionTurns,
  listClaudeSessions,
  importClaudeSession,
  absorbClaudeSessionTurns,
  resolveGrokHome,
  encodeGrokSessionDir,
  findGrokSessionFile,
  parseGrokChatHistory,
  readGrokSessionTurns,
  listGrokSessions,
  importGrokSession,
  absorbGrokSessionTurns,
  resolveCursorHome,
  parseCursorJsonl,
  listCursorSessions,
  importCursorSession,
  absorbCursorSessionTurns,
  resolveOpenCodeHome,
  listOpenCodeSessions,
  importOpenCodeSession,
  readOpenCodeImportTurns,
  absorbOpenCodeSessionTurns,
  absorbKimiSessionTurns,
  absorbMuseSessionTurns,
  absorbSessionTurns,
};
