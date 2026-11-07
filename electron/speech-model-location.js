"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/** Follow intentional symlinks once, then pin the regular target file. No scan. */
async function verifyModelFile(file, spec) {
  let handle;
  try {
    const resolved = await fs.promises.realpath(file);
    // Nonblocking prevents a selected FIFO from hanging before fstat rejects it.
    handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("The selected model must be a regular file.");
    if (before.size !== spec.bytes) throw new Error("The selected speech model has the wrong size.");
    const hash = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (fingerprint(before) !== fingerprint(after)) throw new Error("The selected speech model changed during verification. Try again.");
    if (hash.digest("hex") !== spec.sha256) throw new Error("The selected speech model failed SHA-256 verification.");
    if (fingerprint(await fs.promises.stat(resolved)) !== fingerprint(after)) throw new Error("The selected speech model changed during verification. Try again.");
    return { path: resolved, fingerprint: fingerprint(after) };
  } catch (err) {
    if (err?.code === "ENOENT") throw new Error(`No compatible speech model found. Choose the folder containing ${spec.filename}.`);
    if (err?.code === "EACCES" || err?.code === "EPERM") throw new Error("The selected speech model is not readable. Choose another folder.");
    if (err?.code) throw new Error("Could not read the selected speech model. Choose another folder.");
    throw err;
  } finally {
    if (handle) await handle.close();
  }
}

function verifiedFileUnchanged(verified) {
  try {
    const stat = fs.statSync(verified.path);
    return stat.isFile() && fingerprint(stat) === verified.fingerprint;
  } catch { return false; }
}

function loadModelLocations(file, models) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.fromEntries(Object.keys(models).filter((id) => typeof raw?.[id] === "string" && path.isAbsolute(raw[id])).map((id) => [id, raw[id]]));
  } catch { return {}; }
}

module.exports = { verifyModelFile, verifiedFileUnchanged, loadModelLocations };
