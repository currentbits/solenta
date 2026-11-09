"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createCredentials({ file, safeStorage, allowPlaintext = false }) {
  let loaded = false, value = null;
  function encrypted() {
    try { return safeStorage?.isEncryptionAvailable() === true && safeStorage.getSelectedStorageBackend?.() !== "basic_text"; }
    catch { return false; }
  }
  function storage() { return encrypted() ? "encrypted" : allowPlaintext ? "plaintext" : "session"; }
  function read() {
    if (loaded) return structuredClone(value);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536 || (process.platform !== "win32" && (stat.mode & 0o077)) || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      const saved = JSON.parse(fs.readFileSync(fd, "utf8"));
      let text;
      if (saved.format === "encrypted-v1" && encrypted()) text = safeStorage.decryptString(Buffer.from(saved.data, "base64"));
      else if (saved.format === "plaintext-v1" && allowPlaintext) text = saved.data;
      else throw new Error();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      value = parsed; loaded = true;
      return structuredClone(value);
    } catch (error) {
      if (error.code === "ENOENT") { loaded = true; return null; }
      throw new Error("Cloud credentials are locked or invalid. Restore access to secure storage, or sign out before signing in again.");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return {
    read, storage,
    write(next) {
      const text = JSON.stringify(next);
      if (!next || typeof next !== "object" || Array.isArray(next) || Buffer.byteLength(text) > 32768) throw new Error("Invalid cloud credentials.");
      const mode = storage();
      if (mode === "session") { value = structuredClone(next); loaded = true; return false; }
      const saved = JSON.stringify(mode === "encrypted" ? { format: "encrypted-v1", data: safeStorage.encryptString(text).toString("base64") } : { format: "plaintext-v1", data: text });
      if (Buffer.byteLength(saved) > 65536) throw new Error("Cloud credential file is too large.");
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, saved); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temp, file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      value = structuredClone(next); loaded = true;
      return true;
    },
    clear() {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      value = null; loaded = true;
    },
  };
}

module.exports = { createCredentials };
