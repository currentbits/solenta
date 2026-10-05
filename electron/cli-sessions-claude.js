"use strict";

/**
 * Claude Code session reader (CLAUDE_CONFIG_DIR/projects jsonl). See cli-sessions.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  isInside,
  isInjectedUserText,
  contentText,
  absorbTurns,
  commitImportedTurns,
  isPathSafeSessionId,
} = require("./cli-sessions-shared.js");

const CLAUDE_PROJECT_DIR_MAX_CHARS = 200;

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
 * Re-import absorbs turns added on disk since the last import.
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
  return commitImportedTurns(store, {
    existing,
    projectId,
    provider: "claude",
    sessionId,
    turns: readClaudeImportTurns(home, sessionId),
    defaultTitle: "Imported Claude session",
  });
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

module.exports = {
  encodeClaudeProjectDir,
  resolveClaudeHome,
  findClaudeSessionFile,
  parseClaudeJsonl,
  readClaudeSessionTurns,
  listClaudeSessions,
  importClaudeSession,
  absorbClaudeSessionTurns,
};
