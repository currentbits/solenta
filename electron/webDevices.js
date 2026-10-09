"use strict";

/**
 * Solenta Web device tokens (#1512 I2, #245).
 *
 * One named token per device. The raw token is shown once at mint; disk
 * stores only the sha256, in <userData>/web-access.json at mode 0600 (same
 * treatment as pairings.json). The same file remembers whether the user
 * turned the web server on, and whether it may listen beyond loopback.
 *
 * The pre-device single token (<userData>/web-token) is adopted as
 * "Legacy device". That file stays while the row is active: --serve-web
 * prints it and Remote Connections reads it over SSH. Revoking the legacy
 * row deletes the file.
 *
 * Each row carries scopes (#1530, see webScopes.js), fixed at pairing time.
 * Rows from before scopes existed were issued as full access and stay so.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { sanitizeScopes } = require("./webScopes.js");

const FILE_NAME = "web-access.json";
const LEGACY_TOKEN_FILE = "web-token";
const LEGACY_NAME = "Legacy device";
const NAME_MAX = 60;
const MAX_DEVICES = 30;
// lastSeenAt only needs minute precision; skip the disk write otherwise.
const SEEN_WRITE_MS = 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function emptyState() {
  return { server: { enabled: false, lan: false }, devices: [] };
}

function load(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return emptyState();
    throw new Error(`web access file at ${file} is not valid JSON`);
  }
  const server = parsed && typeof parsed.server === "object" && parsed.server ? parsed.server : {};
  const rows = Array.isArray(parsed && parsed.devices) ? parsed.devices : [];
  return {
    server: { enabled: server.enabled === true, lan: server.lan === true },
    devices: rows.filter(
      (d) => d && typeof d.id === "string" && typeof d.tokenHash === "string",
    ),
  };
}

function toPublic(row) {
  return {
    id: row.id,
    name: String(row.name || "Device"),
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
    lastSeenAt: Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : null,
    legacy: row.legacy === true,
    scopes: rowScopes(row),
  };
}

function rowScopes(row) {
  return Array.isArray(row.scopes) ? sanitizeScopes(row.scopes) : ["full"];
}

/**
 * @param {string} userDataPath
 * @param {{ now?: () => number }} [opts]
 */
function createWebDevices(userDataPath, opts = {}) {
  if (!userDataPath) throw new Error("userDataPath is required for web devices");
  const now = opts.now || Date.now;
  const file = path.join(userDataPath, FILE_NAME);
  const legacyFile = path.join(userDataPath, LEGACY_TOKEN_FILE);
  const state = load(file);

  function save() {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // mode is best-effort on some filesystems
    }
  }

  /** Adopt a single plaintext token as the Legacy device row. Idempotent. */
  function adoptLegacy(token) {
    const raw = String(token || "").trim();
    if (!raw) return null;
    const hash = hashToken(raw);
    const existing = state.devices.find((d) => d.tokenHash === hash);
    if (existing) return toPublic(existing);
    const row = {
      id: crypto.randomUUID(),
      name: LEGACY_NAME,
      tokenHash: hash,
      createdAt: now(),
      lastSeenAt: null,
      legacy: true,
      scopes: ["full"],
    };
    state.devices.push(row);
    save();
    return toPublic(row);
  }

  try {
    adoptLegacy(fs.readFileSync(legacyFile, "utf8"));
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }

  return {
    list() {
      return state.devices.map(toPublic);
    },

    server() {
      return { ...state.server };
    },

    /** @param {{ enabled?: boolean, lan?: boolean }} patch */
    setServer(patch) {
      if (typeof patch.enabled === "boolean") state.server.enabled = patch.enabled;
      if (typeof patch.lan === "boolean") state.server.lan = patch.lan;
      save();
      return { ...state.server };
    },

    adoptLegacy,

    /**
     * Omitted scopes mean read only: a caller must ask for more.
     * @returns {{ device: ReturnType<typeof toPublic>, token: string }}
     */
    add(input) {
      const name = String((input && input.name) || "").trim();
      if (!name) throw new Error("Name the device first.");
      if (name.length > NAME_MAX) {
        throw new Error(`Device names are at most ${NAME_MAX} characters.`);
      }
      if (state.devices.length >= MAX_DEVICES) {
        throw new Error(`At most ${MAX_DEVICES} devices. Revoke one first.`);
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const row = {
        id: crypto.randomUUID(),
        name,
        tokenHash: hashToken(token),
        createdAt: now(),
        lastSeenAt: null,
        scopes: sanitizeScopes(input && input.scopes),
      };
      state.devices.push(row);
      save();
      return { device: toPublic(row), token };
    },

    /** Delete the row. Callers must also drop that device's live sockets. */
    revoke(id) {
      const i = state.devices.findIndex((d) => d.id === id);
      if (i < 0) throw new Error(`Unknown device: ${id}`);
      const [row] = state.devices.splice(i, 1);
      save();
      if (row.legacy) {
        try {
          fs.unlinkSync(legacyFile);
        } catch {
          // already gone
        }
      }
      return toPublic(row);
    },

    /**
     * Constant-time match of a presented token against every stored hash.
     * Compares fixed-length sha256 digests and never exits early, so the
     * timing says nothing about which row (if any) matched.
     *
     * @returns {{ id: string, name: string, scopes: string[] } | null}
     */
    authorize(token) {
      if (typeof token !== "string" || !token) return null;
      const presented = Buffer.from(hashToken(token), "hex");
      let found = null;
      for (const row of state.devices) {
        const stored = Buffer.from(row.tokenHash, "hex");
        if (stored.length !== presented.length) continue;
        if (crypto.timingSafeEqual(stored, presented) && !found) found = row;
      }
      if (!found) return null;
      const t = now();
      if (!found.lastSeenAt || t - found.lastSeenAt >= SEEN_WRITE_MS) {
        found.lastSeenAt = t;
        try {
          save();
        } catch {
          // a persist miss must not reject a valid device
        }
      }
      return { id: found.id, name: found.name, scopes: rowScopes(found) };
    },
  };
}

module.exports = {
  FILE_NAME,
  LEGACY_NAME,
  createWebDevices,
  hashToken,
};
