"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Follow intentional file symlinks, including a not-yet-created target. Renaming
// over the link itself would disconnect a user's shared CLI configuration.
function configTarget(file) {
  let target = path.resolve(file);
  for (let depth = 0; depth < 40; depth++) {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (err) {
      if (err.code === "ENOENT") return target;
      throw err;
    }
    if (!stat.isSymbolicLink()) return target;
    target = path.resolve(path.dirname(target), fs.readlinkSync(target));
  }
  const err = new Error("Too many configuration symlinks");
  err.code = "ELOOP";
  throw err;
}

/**
 * Publish one complete generated config in its target directory. Existing file
 * permissions are retained unless mode is explicit (bearer-token files: 0600).
 * This guarantees old-or-new contents, not read/modify/write serialization or
 * crash durability. Callers retain ownership of directory creation and policy.
 * @param {string} file
 * @param {string | Buffer} data
 * @param {string | { encoding?: BufferEncoding, mode?: number }} [options]
 */
function writeConfigAtomicSync(file, data, options = {}) {
  const opts = typeof options === "string" ? { encoding: options } : options;
  const target = configTarget(file);
  let mode = opts.mode;
  if (mode == null) {
    try {
      mode = fs.statSync(target).mode & 0o777;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temp, "wx", mode ?? 0o666);
    created = true;
    fs.writeFileSync(fd, data, { encoding: opts.encoding || "utf8" });
    if (mode != null) fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the write error */ }
    }
    if (created) {
      try { fs.unlinkSync(temp); } catch { /* renamed, or best-effort cleanup */ }
    }
  }
}

module.exports = { writeConfigAtomicSync };
