"use strict";

/**
 * Codex CLI session reader (CODEX_HOME/sessions rollout files). See cli-sessions.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isInside,
  isInjectedUserText,
  contentText,
  absorbTurns,
  commitImportedTurns,
} = require("./cli-sessions-shared.js");

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
 * Re-import absorbs turns added on disk since the last import.
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
  return commitImportedTurns(store, {
    existing,
    projectId,
    provider: "codex",
    sessionId,
    turns: readCodexSessionTurns(home, sessionId),
    defaultTitle: "Imported Codex session",
  });
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

module.exports = {
  resolveCodexHome,
  findCodexSessionFile,
  parseCodexRollout,
  readCodexSessionTurns,
  listCodexSessions,
  importCodexSession,
  absorbCodexSessionTurns,
  walkCodexRollouts,
};
