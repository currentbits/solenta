"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * One-time rename Coder -> Solenta. Chromium pre-creates the userData
 * directory with cache files before app code runs, so key on the app's own
 * store file, not the directory: when the new store is absent and the legacy
 * one exists, move every app-owned file over (Chromium cache dirs stay
 * behind). memory-server.json carries an absolute dbPath; rewrite it when it
 * points into the legacy dir. Renames are same-volume, so a still-running
 * memory server keeps its open fds on the same inodes.
 * @param {string} appDataPath
 * @param {string} userDataPath
 * @returns {boolean} true when a migration ran
 */
function migrateLegacyUserData(appDataPath, userDataPath) {
  const legacyDir = path.join(appDataPath, "coder");
  const legacyStore = path.join(legacyDir, "coder-store.json");
  const newStore = path.join(userDataPath, "coder-store.json");
  if (legacyDir === userDataPath) return false;
  if (fs.existsSync(newStore) || !fs.existsSync(legacyStore)) return false;

  const APP_OWNED = [
    "coder-store.json",
    "memory-server.json",
    "memory.db",
    "memory.db-shm",
    "memory.db-wal",
    "mcp-coder-memory.json",
    "orch-server.json",
    "web-token",
    "worktrees",
  ];
  for (const name of APP_OWNED) {
    const from = path.join(legacyDir, name);
    const to = path.join(userDataPath, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.renameSync(from, to);
    }
  }
  try {
    const cfgPath = path.join(userDataPath, "memory-server.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (typeof cfg.dbPath === "string" && cfg.dbPath.startsWith(legacyDir)) {
      cfg.dbPath = path.join(userDataPath, path.basename(cfg.dbPath));
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
  } catch {
    // no config or unparseable: the supervisor recreates it
  }
  return true;
}

module.exports = { migrateLegacyUserData };
