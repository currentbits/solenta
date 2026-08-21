"use strict";

/**
 * At-rest encryption for stored secrets (issue #543).
 *
 * Disk payload is Electron `safeStorage.encryptString` (Keychain / DPAPI /
 * libsecret). Memory stays plaintext so existing getSettings / spawn paths
 * keep working. Decrypt-for-injection is audited without recording the
 * secret value (companion to #262 / #289).
 *
 * When the OS backend is missing (typical: headless Linux, no libsecret)
 * we write plaintext and shout about it — never a silent fallback that
 * looks encrypted.
 */

const fs = require("node:fs");

const PREFIX = "enc:v1:";
const UNAVAILABLE_WARNING =
  "Solenta: OS credential encryption is unavailable (Keychain/DPAPI/libsecret). " +
  "Stored provider and MCP credentials will be written in plaintext. " +
  "Install libsecret on Linux, or run under a logged-in desktop session, to encrypt at rest.";
const AUDIT_CAP = 1000;

/**
 * @typedef {object} SecretUse
 * @property {string} purpose
 * @property {string} key
 * @property {string} [threadId]
 */

/**
 * @typedef {object} Secrets
 * @property {(plain: unknown) => string} seal
 * @property {(value: unknown, opts?: { key?: string }) => string | null | undefined} open
 * @property {(value: unknown) => boolean} isSealed
 * @property {() => boolean} isEncryptionAvailable
 * @property {(settings: object) => object} concealSettings
 * @property {(settings: object) => { settings: object, migrated: number }} revealSettings
 * @property {(evt: SecretUse) => void} recordUse
 * @property {() => object[]} getAuditEvents
 * @property {(msg: string) => void} emit
 */

/**
 * Resolve Electron's safeStorage only inside a real Electron process.
 * `require("electron")` from node returns the binary path string, not the
 * API, so process.versions.electron is the load-bearing gate.
 * @returns {{ isEncryptionAvailable: () => boolean, encryptString: (s: string) => Buffer, decryptString: (b: Buffer) => string } | null}
 */
function loadElectronSafeStorage() {
  if (!process.versions.electron) return null;
  try {
    const { safeStorage } = require("electron");
    if (
      !safeStorage ||
      typeof safeStorage.encryptString !== "function" ||
      typeof safeStorage.decryptString !== "function"
    ) {
      return null;
    }
    return safeStorage;
  } catch {
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {{ isEncryptionAvailable?: () => boolean, encryptString?: Function, decryptString?: Function } | null} [opts.safeStorage]
 * @param {boolean} [opts.inElectron]
 * @param {(msg: string) => void} [opts.log]
 * @param {string | null} [opts.auditPath]
 * @param {() => number} [opts.now]
 * @returns {Secrets}
 */
function createSecrets(opts = {}) {
  const injected = Object.prototype.hasOwnProperty.call(opts, "safeStorage");
  let storage = injected ? opts.safeStorage || null : undefined;
  const inElectron =
    opts.inElectron != null
      ? Boolean(opts.inElectron)
      : Boolean(process.versions.electron);
  const log = typeof opts.log === "function" ? opts.log : (msg) => console.error(msg);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  let auditPath = opts.auditPath || null;
  /** @type {object[]} */
  const audit = [];
  let warnedUnavailable = false;

  function emit(msg) {
    try {
      log(String(msg));
    } catch {
      // A log we cannot write is not worth throwing over.
    }
  }

  function backend() {
    if (storage !== undefined) return storage;
    storage = loadElectronSafeStorage();
    return storage;
  }

  function isEncryptionAvailable() {
    const ss = backend();
    if (!ss || typeof ss.isEncryptionAvailable !== "function") return false;
    try {
      return ss.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  function warnUnavailable() {
    if (!inElectron || warnedUnavailable) return;
    warnedUnavailable = true;
    emit(UNAVAILABLE_WARNING);
  }

  function isSealed(value) {
    return typeof value === "string" && value.startsWith(PREFIX);
  }

  /**
   * @param {unknown} plain
   * @returns {string}
   */
  function seal(plain) {
    if (plain == null) return plain;
    const text = String(plain);
    if (!text) return text;
    if (isSealed(text)) return text;
    if (!isEncryptionAvailable()) {
      warnUnavailable();
      return text;
    }
    try {
      const buf = backend().encryptString(text);
      return PREFIX + Buffer.from(buf).toString("base64");
    } catch (err) {
      emit(
        `[secrets] encrypt failed; leaving plaintext (${err && err.message ? err.message : err})`,
      );
      return text;
    }
  }

  /**
   * @param {unknown} value
   * @param {{ key?: string }} [openOpts]
   * @returns {string | null | undefined}
   */
  function open(value, openOpts = {}) {
    if (value == null || value === "") return value;
    if (typeof value !== "string") return null;
    if (!isSealed(value)) return value;
    if (!isEncryptionAvailable()) {
      warnUnavailable();
      emit(
        `[secrets] failed to decrypt ${openOpts.key || "credential"}: OS encryption unavailable`,
      );
      return null;
    }
    try {
      const raw = Buffer.from(value.slice(PREFIX.length), "base64");
      const plain = backend().decryptString(raw);
      return typeof plain === "string" ? plain : null;
    } catch {
      emit(`[secrets] failed to decrypt ${openOpts.key || "credential"}`);
      return null;
    }
  }

  /**
   * Clone settings with secret fields sealed. Returns the same object when
   * nothing changed (node tests / encryption off) so stringify of the live
   * store is byte-identical to today's payload.
   * @param {object} settings
   */
  function concealSettings(settings) {
    if (!settings || typeof settings !== "object") return settings;
    let changed = false;
    const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
    const nextServers = servers.map((s) => {
      if (!s || typeof s !== "object" || !s.token) return s;
      const sealed = seal(s.token);
      if (sealed === s.token) return s;
      changed = true;
      return { ...s, token: sealed };
    });
    let nextOtel = settings.otel;
    const headers =
      settings.otel &&
      settings.otel.headers &&
      typeof settings.otel.headers === "object" &&
      !Array.isArray(settings.otel.headers)
        ? settings.otel.headers
        : null;
    if (headers) {
      /** @type {Record<string, string>} */
      const out = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string" && v) {
          const sealed = seal(v);
          out[k] = sealed;
          if (sealed !== v) changed = true;
        } else {
          out[k] = v;
        }
      }
      if (changed) nextOtel = { ...settings.otel, headers: out };
    }
    if (!changed) return settings;
    return { ...settings, mcpServers: nextServers, otel: nextOtel };
  }

  /**
   * Decrypt secret fields into plaintext. `migrated` is the number of
   * plaintext secrets that will become ciphertext on the next save, when
   * encryption is available.
   * @param {object} settings
   */
  function revealSettings(settings) {
    if (!settings || typeof settings !== "object") {
      return { settings, migrated: 0 };
    }
    const available = isEncryptionAvailable();
    let migrated = 0;
    let changed = false;
    let hasSecret = false;

    const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
    const nextServers = servers.map((s) => {
      if (!s || typeof s !== "object" || !s.token) return s;
      hasSecret = true;
      if (isSealed(s.token)) {
        const plain = open(s.token, { key: `mcp:${s.name || "?"}` });
        changed = true;
        if (plain == null || plain === "") {
          const next = { ...s };
          delete next.token;
          return next;
        }
        return { ...s, token: plain };
      }
      if (available) migrated += 1;
      return s;
    });

    let nextOtel = settings.otel;
    const headers =
      settings.otel &&
      settings.otel.headers &&
      typeof settings.otel.headers === "object" &&
      !Array.isArray(settings.otel.headers)
        ? settings.otel.headers
        : null;
    if (headers) {
      /** @type {Record<string, string>} */
      const out = {};
      let headersChanged = false;
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v !== "string" || !v) {
          out[k] = v;
          continue;
        }
        hasSecret = true;
        if (isSealed(v)) {
          const plain = open(v, { key: `otel:${k}` });
          headersChanged = true;
          if (plain == null || plain === "") continue;
          out[k] = plain;
        } else {
          if (available) migrated += 1;
          out[k] = v;
        }
      }
      if (headersChanged) {
        changed = true;
        nextOtel = { ...settings.otel, headers: out };
      }
    }

    if (!available && hasSecret) warnUnavailable();

    const next = changed
      ? { ...settings, mcpServers: nextServers, otel: nextOtel }
      : settings;
    return { settings: next, migrated };
  }

  /**
   * @param {SecretUse} evt
   */
  function recordUse(evt) {
    if (!evt || typeof evt !== "object") return;
    const row = {
      ts: new Date(now()).toISOString(),
      event: "decrypt",
      purpose: evt.purpose != null ? String(evt.purpose) : "",
      key: evt.key != null ? String(evt.key) : "",
    };
    if (evt.threadId) row.threadId = String(evt.threadId);
    audit.push(row);
    if (audit.length > AUDIT_CAP) audit.shift();
    if (auditPath) {
      try {
        fs.appendFileSync(auditPath, JSON.stringify(row) + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        try {
          fs.chmodSync(auditPath, 0o600);
        } catch {
          // Windows has no POSIX mode bits.
        }
      } catch {
        // Audit must never break injection.
      }
    }
  }

  function getAuditEvents() {
    return audit.slice();
  }

  function setAuditPath(filePath) {
    auditPath = filePath || null;
  }

  return {
    seal,
    open,
    isSealed,
    isEncryptionAvailable,
    concealSettings,
    revealSettings,
    recordUse,
    getAuditEvents,
    emit,
    setAuditPath,
  };
}

const defaultSecrets = createSecrets();

function getDefaultSecrets() {
  return defaultSecrets;
}

/**
 * Point the process-wide helper at the userData audit log. Called once
 * from main.js after userData is known.
 * @param {{ auditPath?: string | null, log?: (msg: string) => void }} opts
 */
function configureDefaultSecrets(opts = {}) {
  if (opts.auditPath != null) defaultSecrets.setAuditPath(opts.auditPath);
}

/** @param {SecretUse} evt */
function recordSecretUse(evt) {
  defaultSecrets.recordUse(evt);
}

module.exports = {
  PREFIX,
  UNAVAILABLE_WARNING,
  createSecrets,
  getDefaultSecrets,
  configureDefaultSecrets,
  recordSecretUse,
};
