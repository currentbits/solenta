"use strict";

/**
 * Provider CLI session transcript reader.
 *
 * #433 / #972 import scans a sessions directory with this parser
 * (Grok: listGrokSessions / importGrokSession under GROK_HOME/sessions).
 * #554 reclaim points it at one known sessionId (Codex: date-tree suffix
 * match; Claude and Grok: direct cwd-encoded path, no directory scan).
 * Claude long cwds
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
 * Codex rollout files are `sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl`.
 * @param {string} home CODEX_HOME
 * @param {string} sessionId
 * @returns {string | null}
 */
function findCodexSessionFile(home, sessionId) {
  const id = String(sessionId || "");
  if (!/^[0-9a-zA-Z-]+$/.test(id)) return null;
  const sessionsDir = path.join(String(home || ""), "sessions");
  const suffix = `-${id}.jsonl`;
  let found = null;
  let foundMtime = -1;
  let years;
  try {
    years = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const year of years) {
    if (!year.isDirectory() && !year.isSymbolicLink()) continue;
    const yearDir = path.join(sessionsDir, year.name);
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory() && !month.isSymbolicLink()) continue;
      const monthDir = path.join(yearDir, month.name);
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory() && !day.isSymbolicLink()) continue;
        const dayDir = path.join(monthDir, day.name);
        let names;
        try {
          names = fs.readdirSync(dayDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.startsWith("rollout-") || !name.endsWith(suffix)) continue;
          const full = path.join(dayDir, name);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            continue;
          }
          if (mtime >= foundMtime) {
            found = full;
            foundMtime = mtime;
          }
        }
      }
    }
  }
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

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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
  return 0;
}

module.exports = {
  resolveCodexHome,
  findCodexSessionFile,
  parseCodexRollout,
  readCodexSessionTurns,
  absorbCodexSessionTurns,
  resolveClaudeHome,
  encodeClaudeProjectDir,
  findClaudeSessionFile,
  parseClaudeJsonl,
  readClaudeSessionTurns,
  absorbClaudeSessionTurns,
  resolveGrokHome,
  encodeGrokSessionDir,
  findGrokSessionFile,
  parseGrokChatHistory,
  readGrokSessionTurns,
  listGrokSessions,
  importGrokSession,
  absorbGrokSessionTurns,
  absorbSessionTurns,
};
