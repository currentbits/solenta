"use strict";

/**
 * useReplay (#1428): run the real runner against recorded CLI fixtures
 * (see replayCli.js), CI-shaped. Every inherited CODER_* var is dropped
 * and PATH holds only node and the system dirs, so a provider CLI or a
 * live-app setting on this machine cannot hide a failure.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIXTURES = path.join(__dirname, "../fixtures/replay");

/** @param {string[]} fixtures file names under fixtures/replay */
function useReplay(fixtures) {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-replay-"));
  for (const f of fixtures) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  for (const k of Object.keys(process.env)) if (k.startsWith("CODER_")) delete process.env[k];
  Object.assign(process.env, {
    PATH: [bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
    CODER_CLAUDE_BIN: path.join(__dirname, "replayCli.js"),
    CODER_REPLAY_DIR: dir,
    CODER_GROK_MCP_DISABLE: "1",
    CODER_CURSOR_MCP_DISABLE: "1",
    CODER_KIMI_MCP_PATH: path.join(dir, "kimi-mcp.json"),
  });

  function log() {
    const file = path.join(dir, "replay.log");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  }

  return {
    dir,
    log,
    /** True once `fixture` has played every line. */
    finished(fixture) {
      return log().some((e) => e.fixture === fixture && e.done);
    },
    /** No mismatch, and every fixture played to its last line. */
    assertClean() {
      const entries = log();
      assert.deepEqual(entries.filter((e) => e.mismatch), [], "replay mismatch");
      for (const f of fixtures) {
        assert.ok(entries.some((e) => e.fixture === f && e.done), `${f} did not play to the end`);
      }
    },
    restore() {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    },
  };
}

function waitFor(predicate, { timeoutMs = 15000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

module.exports = { useReplay, waitFor };
