"use strict";

/**
 * At-rest encryption for stored secrets (issues #543, #1715).
 *
 * Disk payload is Electron `safeStorage.encryptString` (Keychain / DPAPI /
 * libsecret). Memory stays plaintext so existing getSettings / spawn paths
 * keep working. Decrypt-for-injection is audited without recording the
 * secret value (companion to #262 / #289).
 *
 * When the OS backend is missing (typical: headless Linux, no libsecret)
 * we write plaintext and shout about it — never a silent fallback that
 * looks encrypted.
 *
 * ON for packaged builds, OFF for unpackaged dev runs: on macOS the
 * safeStorage keychain item's ACL pins the creating binary's code
 * signature, so unsigned or freshly rebuilt binaries made startup nag for
 * the login-keychain password (371f1045). SOLENTA_ENABLE_SAFE_STORAGE=1/0
 * forces it either way.
 *
 * A sealed `enc:v1:` value that will not open (backend off, keychain
 * denied, corrupt) is never dropped: it stays out of memory, is reported
 * as locked, and goes back to disk byte-for-byte until the user replaces it.
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
 * @property {() => string[]} lockedKeys
 * @property {() => { encryption: "on" | "off" | "unavailable", locked: string[] }} status
 * @property {(evt: SecretUse) => void} recordUse
 * @property {() => object[]} getAuditEvents
 * @property {(msg: string) => void} emit
 */

/**
 * Whether the default (non-injected) backend runs. SOLENTA_ENABLE_SAFE_STORAGE
 * =1 forces it on and =0 off; otherwise only packaged builds use it, since
 * unsigned dev binaries (`electron .`) trip the keychain ACL prompt.
 * @param {boolean | undefined} packaged
 */
function safeStorageEnabled(packaged) {
  const flag = process.env.SOLENTA_ENABLE_SAFE_STORAGE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  if (packaged != null) return Boolean(packaged);
  if (!process.versions.electron) return false;
  try {
    return require("electron").app.isPackaged === true;
  } catch {
    return false;
  }
}

/** @param {unknown} v */
function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * @typedef {object} SecretGroup
 * @property {string} name stable label for one holder, e.g. `mcp:team:env`
 * @property {object} parent
 * @property {string} [prop] set for maps: the holder is parent[prop]
 * @property {string[] | null} fields named fields, or null for every map key
 * @property {boolean} [nullable] a dropped value becomes null, not deleted
 * @property {() => object} holder
 */

/**
 * Every secret-bearing spot in settings. Groups are named by row identity
 * (MCP name, host, instance id) so a locked value finds its row again after
 * the UI rewrote the list.
 * @param {object} settings
 * @returns {SecretGroup[]}
 */
function secretGroups(settings) {
  /** @type {SecretGroup[]} */
  const groups = [];
  const field = (name, parent, fields, nullable = false) =>
    groups.push({ name, parent, fields, nullable, holder: () => parent });
  const map = (name, parent, prop) =>
    groups.push({ name, parent, prop, fields: null, holder: () => parent[prop] });
  const rows = (v) => (Array.isArray(v) ? v.filter(isPlainObject) : []);
  for (const s of rows(settings.mcpServers)) {
    const n = `mcp:${s.name || "?"}`;
    field(n, s, ["token"]);
    map(`${n}:header`, s, "headers");
    map(`${n}:env`, s, "env");
    // MCP OAuth sign-in (#1720): tokens and a confidential client's secret.
    groups.push({
      name: `${n}:oauth`,
      parent: s,
      prop: "oauth",
      fields: ["accessToken", "refreshToken", "clientSecret"],
      nullable: false,
      holder: () => s.oauth,
    });
  }
  if (isPlainObject(settings.otel)) map("otel", settings.otel, "headers");
  field("settings", settings, ["linearApiKey", "sentryAuthToken"], true);
  for (const r of rows(settings.githubHosts)) {
    field(`github:${r.host || "?"}`, r, ["token"], true);
  }
  if (isPlainObject(settings.webhook)) field("webhook", settings.webhook, ["url"], true);
  if (isPlainObject(settings.speech)) {
    field("speech", settings.speech, ["openaiApiKey", "elevenlabsApiKey"], true);
  }
  // Chat channel tokens (#1718).
  if (isPlainObject(settings.telegram)) {
    field("telegram", settings.telegram, ["botToken"], true);
  }
  if (isPlainObject(settings.slack)) {
    field("slack", settings.slack, ["appToken", "botToken"], true);
  }
  if (isPlainObject(settings.discord)) {
    field("discord", settings.discord, ["botToken"], true);
  }
  // Provider instance env (#453): every value may be a key or token.
  for (const inst of rows(settings.providerInstances)) {
    map(`instance:${inst.id || "?"}:env`, inst, "env");
    // OpenAI-compatible endpoint headers (#1714) often carry a bearer token.
    if (isPlainObject(inst.openaiCompatible)) {
      map(`instance:${inst.id || "?"}:header`, inst.openaiCompatible, "headers");
    }
  }
  return groups;
}

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
 * @param {boolean} [opts.packaged] stands in for app.isPackaged (tests)
 * @param {(msg: string) => void} [opts.log]
 * @param {string | null} [opts.auditPath]
 * @param {() => number} [opts.now]
 * @returns {Secrets}
 */
function createSecrets(opts = {}) {
  const injected = Object.prototype.hasOwnProperty.call(opts, "safeStorage");
  let storage;
  // Deliberate disable only governs the default backend; an injected
  // safeStorage (tests) always wins, even an injected null.
  let deliberatelyDisabled = false;
  if (injected) {
    storage = opts.safeStorage || null;
  } else if (!safeStorageEnabled(opts.packaged)) {
    storage = null;
    deliberatelyDisabled = true;
  }
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

  /** The backend can decrypt, possibly with Linux's hardcoded basic_text key. */
  function canOpen() {
    const ss = backend();
    if (!ss || typeof ss.isEncryptionAvailable !== "function") return false;
    try {
      return ss.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  /**
   * Real at-rest encryption. Linux without libsecret falls back to
   * basic_text, which "encrypts" with a key baked into Chromium; we treat
   * that as unavailable rather than write blobs that only look encrypted.
   */
  function isEncryptionAvailable() {
    if (!canOpen()) return false;
    try {
      return backend().getSelectedStorageBackend?.() !== "basic_text";
    } catch {
      return true;
    }
  }

  /**
   * For the settings UI: "on", "off" (deliberately, e.g. dev runs) or
   * "unavailable" (no OS keychain), plus `group:field` of locked values.
   */
  function status() {
    return {
      encryption: isEncryptionAvailable()
        ? "on"
        : deliberatelyDisabled
          ? "off"
          : "unavailable",
      locked: lockedKeys(),
    };
  }

  function warnUnavailable() {
    if (!inElectron || warnedUnavailable || deliberatelyDisabled) return;
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
    if (!canOpen()) {
      warnUnavailable();
      emit(
        deliberatelyDisabled
          ? `[secrets] keeping sealed credential ${openOpts.key || "credential"} locked: safeStorage encryption is disabled`
          : `[secrets] failed to decrypt ${openOpts.key || "credential"}: OS encryption unavailable`,
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
   * Sealed values this load could not open (backend off, keychain refused,
   * corrupt blob), by group name then field. They are kept out of memory so
   * nothing injects ciphertext, and written back verbatim on every save
   * until the user enters a new value. Never dropped.
   * @type {Map<string, Map<string, string>>}
   */
  const locked = new Map();

  /**
   * Clone settings with secret fields sealed and locked values restored.
   * Returns the same object when nothing changed (node tests / encryption
   * off) so stringify of the live store is byte-identical to today's payload.
   * @param {object} settings
   */
  function concealSettings(settings) {
    if (!settings || typeof settings !== "object") return settings;
    const next = structuredClone(settings);
    let changed = false;
    for (const g of secretGroups(next)) {
      const keep = locked.get(g.name);
      if (!isPlainObject(g.holder())) {
        if (!keep || !keep.size) continue;
        g.parent[g.prop] = {};
      }
      const holder = g.holder();
      for (const k of g.fields || Object.keys(holder)) {
        const v = holder[k];
        if (typeof v !== "string" || !v) continue;
        // The user typed a replacement, so the locked one is gone for good.
        if (keep) keep.delete(k);
        const sealed = seal(v);
        if (sealed !== v) {
          holder[k] = sealed;
          changed = true;
        }
      }
      if (keep) {
        for (const [k, cipher] of keep) {
          holder[k] = cipher;
          changed = true;
        }
      }
    }
    return changed ? next : settings;
  }

  /**
   * Decrypt secret fields into plaintext. `migrated` is the number of
   * plaintext secrets that will become ciphertext on the next save, when
   * encryption is available. Sealed values that will not open are removed
   * from the returned settings and parked in `locked` (see concealSettings).
   * @param {object} settings
   */
  function revealSettings(settings) {
    if (!settings || typeof settings !== "object") {
      return { settings, migrated: 0 };
    }
    locked.clear();
    const available = isEncryptionAvailable();
    const next = structuredClone(settings);
    let migrated = 0;
    let changed = false;
    let hasSecret = false;
    for (const g of secretGroups(next)) {
      const holder = g.holder();
      if (!isPlainObject(holder)) continue;
      for (const k of g.fields || Object.keys(holder)) {
        const v = holder[k];
        if (typeof v !== "string" || !v) continue;
        hasSecret = true;
        if (!isSealed(v)) {
          if (available) migrated += 1;
          continue;
        }
        changed = true;
        const plain = open(v, { key: `${g.name}:${k}` });
        if (plain) {
          holder[k] = plain;
          continue;
        }
        if (!locked.has(g.name)) locked.set(g.name, new Map());
        locked.get(g.name).set(k, v);
        if (g.nullable) holder[k] = null;
        else delete holder[k];
      }
    }
    if (!available && hasSecret) warnUnavailable();
    return { settings: changed ? next : settings, migrated };
  }

  /** `group:field` of every locked value, for the settings UI. */
  function lockedKeys() {
    const out = [];
    for (const [name, fields] of locked) {
      for (const k of fields.keys()) out.push(`${name}:${k}`);
    }
    return out;
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
    lockedKeys,
    status,
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
  secretGroups,
  createSecrets,
  getDefaultSecrets,
  configureDefaultSecrets,
  recordSecretUse,
};
