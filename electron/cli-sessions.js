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
 * storage/session/<projectID>/<sessionID>.json plus message/ and part/;
 * Kimi: listKimiSessions / importKimiSession under
 * KIMI_CODE_HOME/sessions/<wd>/<id>/agents/main/wire.jsonl;
 * Muse: listMuseSessions / importMuseSession under
 * XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl).
 * Re-import of the same provider+sessionId absorbs new turns (dedup sync)
 * instead of minting a second thread or returning a stale snapshot.
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

const {
  resolveCodexHome,
  findCodexSessionFile,
  parseCodexRollout,
  readCodexSessionTurns,
  listCodexSessions,
  importCodexSession,
  absorbCodexSessionTurns,
} = require("./cli-sessions-codex.js");
const {
  encodeClaudeProjectDir,
  resolveClaudeHome,
  findClaudeSessionFile,
  parseClaudeJsonl,
  readClaudeSessionTurns,
  listClaudeSessions,
  importClaudeSession,
  absorbClaudeSessionTurns,
} = require("./cli-sessions-claude.js");
const {
  encodeGrokSessionDir,
  resolveGrokHome,
  findGrokSessionFile,
  parseGrokChatHistory,
  readGrokSessionTurns,
  listGrokSessions,
  importGrokSession,
  absorbGrokSessionTurns,
} = require("./cli-sessions-grok.js");
const {
  resolveCursorHome,
  parseCursorJsonl,
  listCursorSessions,
  importCursorSession,
  absorbCursorSessionTurns,
} = require("./cli-sessions-cursor.js");
const {
  resolveOpenCodeHome,
  listOpenCodeSessions,
  readOpenCodeImportTurns,
  importOpenCodeSession,
  absorbOpenCodeSessionTurns,
} = require("./cli-sessions-opencode.js");
const {
  resolveKimiHome,
  parseKimiWire,
  absorbKimiSessionTurns,
  listKimiSessions,
  importKimiSession,
} = require("./cli-sessions-kimi.js");
const {
  resolveMuseHome,
  parseMuseJsonl,
  absorbMuseSessionTurns,
  listMuseSessions,
  importMuseSession,
} = require("./cli-sessions-muse.js");

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
  parseKimiWire,
  listKimiSessions,
  importKimiSession,
  absorbKimiSessionTurns,
  parseMuseJsonl,
  listMuseSessions,
  importMuseSession,
  absorbMuseSessionTurns,
  absorbSessionTurns,
};
