"use strict";

/**
 * Solenta Web device tokens (#1512 I2, #245).
 *
 * One named token per device. The raw token is shown once at mint; disk
 * stores only the sha256, in <userData>/web-access.json at mode 0600 (same
 * treatment as pairings.json). The same file remembers whether the user
 * turned the web server on, and whether it may listen beyond loopback.
 *
 * The single file token (<userData>/web-token) is adopted as the
 * "SSH and command line" row. Whenever the server starts, webAccess makes
 * sure the file exists: --serve-web prints it and Remote Connections reads
 * it over SSH (anyone who can do that already runs code as this user).
 * Revoking the row deletes the file; the next start writes a new one.
 *
 * Each row carries scopes (#1530, see webScopes.js), fixed at pairing time.
 * Rows from before scopes existed were issued as full access and stay so.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { sanitizeScopes, narrowScopes } = require("./webScopes.js");

const FILE_NAME = "web-access.json";
const LEGACY_TOKEN_FILE = "web-token";
const LEGACY_NAME = "SSH and command line";
const NAME_MAX = 60;
const MAX_DEVICES = 30;
const ENROLLMENT_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// lastSeenAt only needs minute precision; skip the disk write otherwise.
const SEEN_WRITE_MS = 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function emptyState() {
  return { server: { enabled: false, lan: false }, devices: [], enrollments: [], cloudNonces: [] };
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
    enrollments: Array.isArray(parsed.enrollments) ? parsed.enrollments.filter(g => g && typeof g.tokenHash === "string") : [],
    cloudNonces: Array.isArray(parsed.cloudNonces) ? parsed.cloudNonces.filter(g => g && typeof g.hash === "string") : [],
    devices: rows.filter(
      (d) => d && typeof d.id === "string" && typeof d.tokenHash === "string",
    ),
  };
}

function toPublic(row) {
  return {
    id: row.id,
    // Rows adopted before the rename still say "Legacy device" on disk.
    name: row.legacy === true ? LEGACY_NAME : String(row.name || "Device"),
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
    lastSeenAt: Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : null,
    legacy: row.legacy === true,
    scopes: rowScopes(row),
    ...(row.expiresAt !== undefined ? { expiresAt: Number.isFinite(row.expiresAt) ? row.expiresAt : 0 } : {}),
  };
}

function rowScopes(row) {
  return Array.isArray(row.scopes) ? sanitizeScopes(row.scopes) : ["full"];
}

function cloudBinding(value) {
  if (!value || !["accountId", "linkId"].every(key => typeof value[key] === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value[key])) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || !/^[A-Za-z0-9_-]{43}$/.test(value.jkt)) {
    throw new Error("Invalid cloud device binding.");
  }
  const { accountId, linkId, generation, jkt } = value;
  return { accountId, linkId, generation, jkt };
}

function sameCloud(left, right) {
  return left && right && ["accountId", "linkId", "generation", "jkt"].every(key => left[key] === right[key]);
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
  let state = load(file);
  const lockFile = path.join(userDataPath, "web-access.lock");
  const enrollmentTtl = opts.enrollmentTtlMs ?? ENROLLMENT_TTL_MS;
  const sessionTtl = opts.sessionTtlMs ?? SESSION_TTL_MS;

  // One file transaction commits consumption and the new named device together.
  // The exclusive lock also fences stale instances/processes. A crashed owner
  // can be recovered; an uncertain/live owner fails closed rather than racing.
  function update(change) {
    fs.mkdirSync(userDataPath, { recursive: true });
    const ownerFile = `${lockFile}.${crypto.randomUUID()}`;
    // Populate the owner before publishing its hard link. A crash can never
    // leave an empty lock whose ownership cannot be established on restart.
    fs.writeFileSync(ownerFile, String(process.pid), { flag: "wx", mode: 0o600 });
    let locked = false;
    try {
      try {
        fs.linkSync(ownerFile, lockFile);
        locked = true;
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
        const recoveryFile = `${lockFile}.recovery`;
        // Only one contender may inspect and remove a stale owner. In
        // particular, never unlink based on an observation made before
        // acquiring this guard: another process may have acquired the lock.
        try {
          fs.linkSync(ownerFile, recoveryFile);
        } catch (recoveryError) {
          if (!recoveryError || recoveryError.code !== "EEXIST") throw recoveryError;
          throw new Error("Device access recovery is already in progress. Try again. If it persists, stop Solenta before removing web-access.lock.recovery from its data directory.");
        }
        try {
          let stale = false;
          try {
            const pid = Number(fs.readFileSync(lockFile, "utf8"));
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); } catch (e) { stale = e.code === "ESRCH"; }
            }
          } catch { /* An uncertain owner is never stolen. */ }
          if (!stale) throw new Error("Device access is being changed. Try again.");
          fs.unlinkSync(lockFile);
          // A normal contender may acquire the now-free lock, but it can
          // never remove ours. Losing this race is a safe retry, not recovery.
          try {
            fs.linkSync(ownerFile, lockFile);
            locked = true;
          } catch (acquireError) {
            if (!acquireError || acquireError.code !== "EEXIST") throw acquireError;
            throw new Error("Device access is being changed. Try again.");
          }
        } finally {
          fs.unlinkSync(recoveryFile);
        }
      }
      const next = load(file);
      const result = change(next);
      save(next);
      state = next;
      return result;
    } finally {
      if (locked) fs.unlinkSync(lockFile);
      fs.unlinkSync(ownerFile);
    }
  }


  function save(next) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, file);
      try { const dir = fs.openSync(userDataPath, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* Not supported on every filesystem. */ }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* Renamed successfully. */ }
    }
  }

  function nameOf(input) {
    const name = String((input && input.name) || "").trim();
    if (!name) throw new Error("Name the device first.");
    if (name.length > NAME_MAX) throw new Error(`Device names are at most ${NAME_MAX} characters.`);
    return name;
  }
  function active(row) {
    return row.expiresAt === undefined || (Number.isFinite(row.expiresAt) && row.expiresAt > now());
  }

  function redeem(input, cloud) {
    const grant = input && input.grant;
    if (typeof grant !== "string" || grant.length < 32 || grant.length > 128) throw new Error("Enrollment link is invalid, expired or already used.");
    return update(next => {
      const presented = Buffer.from(hashToken(grant), "hex");
      let found;
      for (const row of next.enrollments) {
        const stored = Buffer.from(row.tokenHash, "hex");
        if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) found = row;
      }
      if (!found || !Number.isFinite(found.expiresAt) || found.expiresAt <= now()) throw new Error("Enrollment link is invalid, expired or already used.");
      if (found.cloud && !cloud) throw new Error("Cloud enrollment requires its client proof.");
      if (cloud && !sameCloud(found.cloud, cloud)) throw new Error("Cloud enrollment binding does not match.");
      const previous = found.deviceId ? next.devices.find(row => row.id === found.deviceId) : null;
      if (found.deviceId && (!previous || !sameCloud(previous.cloud, cloud))) throw new Error("Cloud device binding does not match.");
      if (previous && previous.tokenHash !== found.previousTokenHash) throw new Error("Cloud session changed during renewal. Try again.");
      const scopes = narrowScopes(previous ? narrowScopes(rowScopes(previous), rowScopes(found)) : rowScopes(found), input.scopes);
      if (!previous && next.devices.length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} devices. Revoke one first.`);
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = now() + (cloud ? 10 * 60_000 : sessionTtl);
      const row = { id: previous?.id || crypto.randomUUID(), name: previous?.name || found.name, scopes, expiresAt, tokenHash: hashToken(token), createdAt: previous?.createdAt ?? now(), lastSeenAt: previous?.lastSeenAt ?? null, ...(cloud ? { cloud } : {}) };
      next.enrollments = next.enrollments.filter(g => g !== found);
      if (previous) next.devices[next.devices.indexOf(previous)] = row;
      else next.devices.push(row);
      return { token, device: toPublic(row), expiresAt };
    });
  }

  /** Adopt a single plaintext token as the Legacy device row. Idempotent. */
  function adoptLegacy(token) {
    const raw = String(token || "").trim();
    if (!raw) return null;
    const hash = hashToken(raw);
    state = load(file);
    const existing = state.devices.find((d) => d.tokenHash === hash);
    if (existing) return toPublic(existing);
    return update(next => {
      const held = next.devices.find(d => d.tokenHash === hash);
      if (held) return toPublic(held);
      const row = { id: crypto.randomUUID(), name: LEGACY_NAME, tokenHash: hash, createdAt: now(), lastSeenAt: null, legacy: true, scopes: ["full"] };
      next.devices.push(row);
      return toPublic(row);
    });
  }

  try {
    adoptLegacy(fs.readFileSync(legacyFile, "utf8"));
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }

  return {
    list() {
      state = load(file);
      return state.devices.map(toPublic);
    },

    server() {
      return { ...state.server };
    },

    /** @param {{ enabled?: boolean, lan?: boolean }} patch */
    setServer(patch) {
      return update(next => {
        if (typeof patch.enabled === "boolean") next.server.enabled = patch.enabled;
        if (typeof patch.lan === "boolean") next.server.lan = patch.lan;
        return { ...next.server };
      });
    },

    adoptLegacy,

    /**
     * Omitted scopes mean read only: a caller must ask for more.
     * @returns {{ device: ReturnType<typeof toPublic>, token: string }}
     */
    add(input) {
      const name = nameOf(input);
      return update(next => {
        if (next.devices.length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} devices. Revoke one first.`);
        const token = crypto.randomBytes(32).toString("base64url");
        const row = { id: crypto.randomUUID(), name, tokenHash: hashToken(token), createdAt: now(), lastSeenAt: null, scopes: sanitizeScopes(input && input.scopes) };
        next.devices.push(row);
        return { device: toPublic(row), token };
      });
    },

    createEnrollment(input) {
      const name = nameOf(input);
      return update(next => {
        next.enrollments = next.enrollments.filter(g => Number.isFinite(g.expiresAt) && g.expiresAt > now());
        if (next.enrollments.length >= MAX_DEVICES) throw new Error("Too many pending enrollment links. Wait for one to expire.");
        if (next.devices.length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} devices. Revoke one first.`);
        const grant = crypto.randomBytes(32).toString("base64url");
        const expiresAt = now() + enrollmentTtl;
        const scopes = sanitizeScopes(input && input.scopes);
        next.enrollments.push({ id: crypto.randomUUID(), tokenHash: hashToken(grant), name, scopes, expiresAt });
        return { grant, name, scopes, expiresAt, sessionTtlMs: sessionTtl };
      });
    },

    createCloudEnrollment(input) {
      const name = nameOf(input);
      const cloud = cloudBinding(input.cloud);
      if (typeof input.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce)) throw new Error("Invalid cloud request nonce.");
      return update(next => {
        next.enrollments = next.enrollments.filter(row => row.expiresAt > now());
        next.cloudNonces = next.cloudNonces.filter(row => row.expiresAt > now());
        const hash = hashToken(input.nonce);
        if (next.cloudNonces.some(row => row.hash === hash)) throw new Error("Cloud request nonce was already used.");
        if (next.cloudNonces.length >= 1000 || next.enrollments.length >= MAX_DEVICES) throw new Error("Too many pending cloud requests. Try again later.");
        const previous = input.deviceId ? next.devices.find(row => row.id === input.deviceId) : null;
        if (input.deviceId && (!previous || !sameCloud(previous.cloud, cloud))) throw new Error("Cloud device binding does not match.");
        if (!previous && next.devices.length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} devices. Revoke one first.`);
        const grant = crypto.randomBytes(32).toString("base64url");
        const expiresAt = now() + Math.min(enrollmentTtl, 60_000);
        const scopes = previous ? narrowScopes(rowScopes(previous), input.scopes) : sanitizeScopes(input.scopes);
        next.enrollments.push({ id: crypto.randomUUID(), tokenHash: hashToken(grant), name, scopes, expiresAt, cloud, ...(previous ? { deviceId: previous.id, previousTokenHash: previous.tokenHash } : {}) });
        next.cloudNonces.push({ hash, expiresAt: now() + 60_000, linkId: cloud.linkId });
        return { grant, name, scopes, expiresAt, sessionTtlMs: 10 * 60_000 };
      });
    },

    redeemEnrollment(input) { return redeem(input); },

    // Only the host's verified proof exchange may call this entry point.
    redeemCloudEnrollment(input) { return redeem(input, cloudBinding(input.cloud)); },

    revokeCloud(linkId) {
      return update(next => {
        const ids = next.devices.filter(row => row.cloud?.linkId === linkId).map(row => row.id);
        next.devices = next.devices.filter(row => row.cloud?.linkId !== linkId);
        next.enrollments = next.enrollments.filter(row => row.cloud?.linkId !== linkId);
        next.cloudNonces = next.cloudNonces.filter(row => row.linkId !== linkId);
        return ids;
      });
    },

    /** Delete the row. Callers must also drop that device's live sockets. */
    revoke(id) {
      const row = update(next => {
        const i = next.devices.findIndex(d => d.id === id);
        if (i < 0) throw new Error(`Unknown device: ${id}`);
        return next.devices.splice(i, 1)[0];
      });
      if (row.legacy) {
        try { fs.unlinkSync(legacyFile); } catch { /* Already gone. */ }
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
      state = load(file);
      const presented = Buffer.from(hashToken(token), "hex");
      let found = null;
      for (const row of state.devices) {
        const stored = Buffer.from(row.tokenHash, "hex");
        if (stored.length !== presented.length) continue;
        if (crypto.timingSafeEqual(stored, presented) && !found) found = row;
      }
      if (!found || !active(found)) return null;
      const t = now();
      if (!found.lastSeenAt || t - found.lastSeenAt >= SEEN_WRITE_MS) {
        try {
          update(next => { const row = next.devices.find(d => d.id === found.id); if (row) row.lastSeenAt = t; });
        } catch {
          // a persist miss must not reject a valid device
        }
      }
      return { id: found.id, name: found.name, scopes: rowScopes(found), ...(found.legacy ? { legacy: true } : {}), ...(found.expiresAt !== undefined ? { expiresAt: found.expiresAt } : {}) };
    },
    authorizeEstablished(prior) {
      // Established sockets retain their original lease while a replacement token is in transit.
      if (!prior || typeof prior.id !== "string" || !active(prior)) return null;
      const found = load(file).devices.find(row => row.id === prior.id);
      if (!found || !active(found)) return null;
      try { narrowScopes(prior.scopes, rowScopes(found)); } catch { return null; }
      const expiresAt = Number.isFinite(prior.expiresAt) ? Math.min(prior.expiresAt, found.expiresAt ?? Infinity) : found.expiresAt;
      return { id: found.id, name: found.name, scopes: rowScopes(found), ...(found.legacy ? { legacy: true } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
    },
  };
}

module.exports = {
  ENROLLMENT_TTL_MS,
  SESSION_TTL_MS,
  FILE_NAME,
  LEGACY_NAME,
  createWebDevices,
  hashToken,
};
