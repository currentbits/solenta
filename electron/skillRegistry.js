"use strict";

/**
 * App-owned skill install registry. Provider-local markers only carry an
 * install id; provenance is decided here.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const INSTALL_ID_RE = /^[a-f0-9]{32}$/;

function registryDir(userDataPath) {
  return path.join(String(userDataPath || ""), "skills");
}

function registryPath(userDataPath) {
  return path.join(registryDir(userDataPath), "registry.json");
}

function emptyRegistry() {
  return { version: 1, installs: {} };
}

/**
 * @param {string | null | undefined} userDataPath
 */
function readRegistry(userDataPath) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    return emptyRegistry();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(userDataPath), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return emptyRegistry();
    }
    const installs =
      raw.installs && typeof raw.installs === "object" && !Array.isArray(raw.installs)
        ? raw.installs
        : {};
    /** @type {Record<string, object>} */
    const clean = {};
    for (const [id, rec] of Object.entries(installs)) {
      if (!INSTALL_ID_RE.test(id)) continue;
      const sanitized = sanitizeRecord(rec);
      if (sanitized) clean[id] = sanitized;
    }
    return { version: 1, installs: clean };
  } catch {
    return emptyRegistry();
  }
}

function sanitizeRecord(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const provenance = rec.provenance;
  if (provenance !== "curated" && provenance !== "added") return null;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) return null;
  /** @type {Record<string, string>} */
  const out = { name, provenance };
  if (typeof rec.catalogId === "string" && rec.catalogId.trim()) {
    out.catalogId = rec.catalogId.trim();
  }
  if (typeof rec.sourceLabel === "string" && rec.sourceLabel.trim()) {
    out.sourceLabel = rec.sourceLabel.trim();
  }
  if (typeof rec.sourceUrl === "string" && rec.sourceUrl.trim()) {
    out.sourceUrl = rec.sourceUrl.trim();
  }
  if (typeof rec.packageId === "string" && rec.packageId.trim()) {
    out.packageId = rec.packageId.trim();
  }
  if (typeof rec.importedAt === "string" && rec.importedAt.trim()) {
    out.importedAt = rec.importedAt.trim();
  }
  return out;
}

/**
 * @param {string} userDataPath
 * @param {{ version: number, installs: Record<string, object> }} data
 */
function writeRegistryAtomic(userDataPath, data) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) {
    throw new Error("Skill registry storage is not configured");
  }
  const dir = registryDir(userDataPath);
  fs.mkdirSync(dir, { recursive: true });
  const dest = registryPath(userDataPath);
  const tmpFile = path.join(
    dir,
    `.registry.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const installs = {};
  for (const [id, rec] of Object.entries((data && data.installs) || {})) {
    if (!INSTALL_ID_RE.test(id)) continue;
    const sanitized = sanitizeRecord(rec);
    if (sanitized) installs[id] = sanitized;
  }
  const body = `${JSON.stringify({ version: 1, installs }, null, 2)}\n`;
  try {
    fs.writeFileSync(tmpFile, body, { mode: 0o644 });
    fs.renameSync(tmpFile, dest);
  } catch (err) {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

function newInstallId() {
  return crypto.randomBytes(16).toString("hex");
}

function lookupInstall(userDataPath, installId) {
  if (typeof installId !== "string" || !INSTALL_ID_RE.test(installId)) {
    return null;
  }
  const rec = readRegistry(userDataPath).installs[installId];
  return rec || null;
}

function installIdsForName(userDataPath, name) {
  const ids = [];
  const registry = readRegistry(userDataPath);
  for (const [id, rec] of Object.entries(registry.installs)) {
    if (rec && rec.name === name) ids.push(id);
  }
  return ids;
}

/**
 * @param {string} userDataPath
 * @param {{ add?: Record<string, object>, removeIds?: string[] }} patch
 */
function commitInstalls(userDataPath, patch) {
  const registry = readRegistry(userDataPath);
  for (const id of patch.removeIds || []) {
    delete registry.installs[id];
  }
  for (const [id, rec] of Object.entries(patch.add || {})) {
    const sanitized = sanitizeRecord(rec);
    if (INSTALL_ID_RE.test(id) && sanitized) {
      registry.installs[id] = sanitized;
    }
  }
  writeRegistryAtomic(userDataPath, registry);
}

function removeInstallsByName(userDataPath, name) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) return;
  const ids = installIdsForName(userDataPath, name);
  if (!ids.length) return;
  commitInstalls(userDataPath, { removeIds: ids });
}

module.exports = {
  INSTALL_ID_RE,
  readRegistry,
  writeRegistryAtomic,
  newInstallId,
  lookupInstall,
  installIdsForName,
  commitInstalls,
  removeInstallsByName,
  registryPath,
};
