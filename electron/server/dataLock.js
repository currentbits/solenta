"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// mkdir serializes contenders. A lock without an owner is deliberately not
// reclaimed: it may be a process between mkdir and writing its owner record.
function acquireDataLock(dataDir, { pid = process.pid, alive = processAlive } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = path.join(fs.realpathSync(dataDir), ".server-lock");
  const nonce = crypto.randomUUID();
  const guard = `${dir}.guard`;
  try { fs.mkdirSync(guard, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another server is acquiring the data-directory lock (${guard}); retry, or inspect this guard after a crash.`);
    throw error;
  }
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid, nonce }), { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")).nonce !== nonce) return;
          fs.unlinkSync(path.join(dir, "owner.json"));
          fs.rmdirSync(dir);
        } catch { /* Exit cleanup must not hide the shutdown result. */ }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")); } catch { /* fail closed */ }
      if (!owner || !Number.isInteger(owner.pid) || alive(owner.pid)) throw new Error(`Another server owns this data directory (lock ${dir}). Stop it before starting another writer. If it crashed while creating the lock, inspect and remove the stale lock manually.`);
      // Rename claims the dead owner's lock before deleting it. Never remove a
      // contender's newly acquired lock after a stale-owner race.
      const stale = `${dir}.stale-${nonce}`;
      try { fs.renameSync(dir, stale); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
      fs.rmSync(stale, { recursive: true });
    }
  }
  throw new Error("Could not acquire the server data-directory lock; retry.");
  } finally { fs.rmdirSync(guard); }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
module.exports = { acquireDataLock, processAlive };
