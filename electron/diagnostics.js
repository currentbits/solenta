"use strict";

/**
 * One-click redacted diagnostics bundle (#1723): Help › Export Diagnostics…
 * and Settings › Advanced. A .zip of app/provider/settings/error metadata a
 * user can attach to a bug report without leaking anything.
 *
 * Never in the bundle: transcripts, prompts, memory, env values, repo file
 * contents, account emails. Secrets are stripped by the same map
 * secrets.js encrypts (secretGroups), then every string goes through the
 * bug-report redactor (secret shapes + home dir → ~) as a second net.
 *
 * Logs: the main process only writes userData/crash.log (crash-guard.js);
 * everything else goes to stdout and there is no in-memory ring buffer.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");
const { secretGroups } = require("./secrets.js");
const { redactor } = require("./threadReport.js");

const REDACTED = "[redacted]";
const VERSION_TIMEOUT_MS = 2000;
const MAX_ERRORS = 50;
const LOG_LINES = 500;

const BASE_FILES = [
  "app.json",
  "providers.json",
  "settings.redacted.json",
  "errors.json",
  "secrets-status.json",
];

/** @param {unknown} v */
const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** @param {string | undefined} userDataPath */
function crashLogPath(userDataPath) {
  return userDataPath ? path.join(userDataPath, "crash.log") : null;
}

/**
 * File names the bundle will hold, for the preview. Cheap: no probes.
 * @param {{ userDataPath?: string }} opts
 * @returns {string[]}
 */
function diagnosticsFileList(opts = {}) {
  const log = crashLogPath(opts.userDataPath);
  return log && fs.existsSync(log) ? [...BASE_FILES, "logs/crash.log"] : BASE_FILES.slice();
}

/**
 * `<bin> --version`, first line. Never rejects; a slow CLI is killed.
 * @param {string} bin
 * @param {string[]} [args]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ version: string | null, error?: string }>}
 */
function probeVersion(bin, args = ["--version"], timeoutMs = VERSION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ version: null, error: err.killed ? "timed out" : "failed" });
          return;
        }
        resolve({ version: String(stdout).trim().split(/\r?\n/)[0] || null });
      },
    );
  });
}

/**
 * Secrets out by the secretGroups map, prompt text out, then every string
 * through the redactor. Pure.
 * @param {object} settings
 * @param {(s: unknown) => string} text
 */
function redactSettings(settings, text) {
  const s = structuredClone(settings || {});
  for (const g of secretGroups(s)) {
    const holder = g.holder();
    if (!isPlainObject(holder)) continue;
    for (const k of g.fields || Object.keys(holder)) {
      if (holder[k] != null && holder[k] !== "") holder[k] = REDACTED;
    }
  }
  // secretGroups only covers non-empty strings; env maps go wholesale.
  const envMaps = [
    ...(Array.isArray(s.providerInstances) ? s.providerInstances : []),
    ...(Array.isArray(s.mcpServers) ? s.mcpServers : []),
  ];
  for (const row of envMaps) {
    if (isPlainObject(row) && isPlainObject(row.env)) {
      for (const k of Object.keys(row.env)) row.env[k] = REDACTED;
    }
  }
  if (isPlainObject(s.otel) && isPlainObject(s.otel.headers)) {
    for (const k of Object.keys(s.otel.headers)) s.otel.headers[k] = REDACTED;
  }
  // MCP stdio args can carry keys or passwords in any position. Keep the
  // first (usually the package) and bare flags; redact values and the rest.
  for (const row of Array.isArray(s.mcpServers) ? s.mcpServers : []) {
    if (!isPlainObject(row) || !Array.isArray(row.args)) continue;
    row.args = row.args.map((/** @type {unknown} */ a, /** @type {number} */ i) => {
      const arg = String(a);
      if (i === 0) return arg;
      const flag = /^(-{1,2}[A-Za-z0-9][\w.-]*)(=.*)?$/.exec(arg);
      if (flag) return flag[2] ? `${flag[1]}=${REDACTED}` : arg;
      return REDACTED;
    });
  }
  for (const kind of ["telegram", "slack", "discord"]) {
    if (isPlainObject(s[kind])) {
      delete s[kind].botToken;
      delete s[kind].appToken;
    }
  }
  // Snippets are prompt text.
  if (Array.isArray(s.promptSnippets)) s.promptSnippets = { count: s.promptSnippets.length };
  return deepText(s, text);
}

/**
 * The bug-report redactor knows token shapes, not URLs: drop the password in
 * `scheme://user:pass@host` and secret-looking query values (`?api_key=…`).
 * @param {string} s
 */
function scrubUrlSecrets(s) {
  return s
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*):[^\s/@]+@/gi, `$1:${REDACTED}@`)
    .replace(
      /([?&][^=&\s#]*(?:key|token|secret|password|passwd|pass|auth|signature|sig)[^=&\s#]*=)[^&\s#]+/gi,
      `$1${REDACTED}`,
    );
}

/** @param {unknown} v @param {(s: unknown) => string} text @returns {any} */
function deepText(v, text) {
  if (typeof v === "string") return text(v);
  if (Array.isArray(v)) return v.map((x) => deepText(x, text));
  if (isPlainObject(v)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, x] of Object.entries(/** @type {object} */ (v))) out[k] = deepText(x, text);
    return out;
  }
  return v;
}

/**
 * @param {{
 *   store: any,
 *   userDataPath?: string,
 *   home?: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number,
 *   locale?: string,
 *   which?: (bin: string, env: NodeJS.ProcessEnv) => string | null,
 *   probe?: (bin: string) => Promise<{ version: string | null, error?: string }>,
 *   authState?: (id: string) => string | undefined,
 *   providers?: Array<{ id: string, name: string, binEnv?: string, defaultBin?: string }>,
 * }} opts
 * @returns {Promise<Array<{ name: string, data: string }>>}
 */
async function buildDiagnostics(opts) {
  const providersMod = require("./providers.js");
  const { buildStamp } = require("./updater.js");
  const { appVersion } = require("./feedback.js");
  const home = opts.home ?? os.homedir();
  const env = opts.env || process.env;
  const now = opts.now ?? Date.now();
  const which = opts.which || providersMod.defaultWhich;
  const probe = opts.probe || probeVersion;
  const authState = opts.authState || require("./providerAuth.js").get;
  const r = redactor("diagnostics", home);
  const text = (/** @type {unknown} */ v) => scrubUrlSecrets(r.text(v));
  const json = (/** @type {unknown} */ v) => JSON.stringify(deepText(v, text), null, 2) + "\n";
  const stamp = buildStamp();

  const app = {
    version: appVersion(),
    build: stamp.tag,
    channel: stamp.channel || "dev",
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
    node: process.versions.node,
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    locale: opts.locale || Intl.DateTimeFormat().resolvedOptions().locale,
    uptimeSeconds: Math.round(process.uptime()),
    exportedAt: new Date(now).toISOString(),
  };

  const entries = opts.providers || providersMod.PROVIDERS;
  const providers = await Promise.all(
    entries.map(async (entry) => {
      const bin = providersMod.resolveBin(entry, env);
      const resolved = bin ? which(bin, env) : null;
      const probed = resolved ? await probe(resolved) : { version: null };
      const state = authState(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        bin: resolved,
        installed: Boolean(resolved),
        version: probed.version,
        ...(probed.error ? { versionError: probed.error } : {}),
        // No account: the email is the user's identity.
        signedIn: state === "signedIn" ? "yes" : state === "signedOut" ? "no" : "unknown",
      };
    }),
  );

  const settings = redactSettings(opts.store.getSettings(), text);

  // No run history exists: each thread keeps its last error.
  const errors = (opts.store.getThreads() || [])
    .filter((/** @type {any} */ t) => t && t.lastError)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_ERRORS)
    .map((/** @type {any} */ t) => ({
      threadId: t.id,
      provider: t.provider || null,
      model: t.model || null,
      error: t.lastError,
      kind: t.lastErrorKind || null,
      time: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
    }));

  const status =
    typeof opts.store.secretStorage === "function"
      ? opts.store.secretStorage()
      : { encryption: "unavailable", locked: [] };

  const files = [
    { name: "app.json", data: json(app) },
    { name: "providers.json", data: json(providers) },
    { name: "settings.redacted.json", data: json(settings) },
    { name: "errors.json", data: json(errors) },
    {
      name: "secrets-status.json",
      data: json({ encryption: status.encryption, lockedCount: (status.locked || []).length }),
    },
  ];
  const log = crashLogPath(opts.userDataPath);
  if (log && fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").split(/\r?\n/).slice(-LOG_LINES);
    files.push({ name: "logs/crash.log", data: text(lines.join("\n")) });
  }
  return files;
}

/**
 * Minimal deflate zip (no zip64, no dirs): enough for a handful of text
 * files any unzip opens.
 * @param {Array<{ name: string, data: string | Buffer }>} files
 * @param {Date} [date]
 * @returns {Buffer}
 */
function zipFiles(files, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  /** @type {Buffer[]} */
  const local = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const body = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(dosTime, 10);
    head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    head.copy(cen, 8, 6, 30); // flags..name length are the same fields
    cen.writeUInt32LE(offset, 42);
    local.push(head, name, body);
    central.push(cen, name);
    offset += head.length + name.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** @param {number} [now] */
function defaultZipName(now = Date.now()) {
  const { appVersion } = require("./feedback.js");
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `solenta-diagnostics-${appVersion()}-${day}.zip`;
}

/**
 * Save dialog first (cancel costs nothing), then build and write.
 * @param {{ store: any, dialog?: any, userDataPath?: string }} ctx
 * @param {Partial<Parameters<typeof buildDiagnostics>[0]>} [buildOpts] test seams
 * @returns {Promise<string | null>} written path, null when cancelled
 */
async function exportDiagnostics(ctx, buildOpts = {}) {
  if (!ctx.dialog || typeof ctx.dialog.showSaveDialog !== "function") {
    throw new Error("Save dialog is not available in this mode");
  }
  const picked = await ctx.dialog.showSaveDialog({
    title: "Export diagnostics",
    defaultPath: path.join(os.homedir(), "Downloads", defaultZipName()),
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  });
  if (picked.canceled || !picked.filePath) return null;
  const files = await buildDiagnostics({
    ...buildOpts,
    store: ctx.store,
    userDataPath: ctx.userDataPath,
  });
  fs.writeFileSync(picked.filePath, zipFiles(files));
  return picked.filePath;
}

/**
 * Help › Export Diagnostics…: native preview of the file list, then save.
 * @param {{ store: any, dialog: any, userDataPath?: string }} ctx
 * @param {Partial<Parameters<typeof buildDiagnostics>[0]>} [buildOpts]
 * @returns {Promise<string | null>}
 */
async function confirmAndExportDiagnostics(ctx, buildOpts) {
  const files = diagnosticsFileList({ userDataPath: ctx.userDataPath });
  const { response } = await ctx.dialog.showMessageBox({
    type: "info",
    message: "Export diagnostics",
    detail:
      `The zip will contain:\n${files.map((f) => `• ${f}`).join("\n")}\n\n` +
      "Secrets, prompts, transcripts and memory are never included.",
    buttons: ["Save…", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null;
  return exportDiagnostics(ctx, buildOpts);
}

module.exports = {
  BASE_FILES,
  confirmAndExportDiagnostics,
  diagnosticsFileList,
  probeVersion,
  redactSettings,
  scrubUrlSecrets,
  buildDiagnostics,
  zipFiles,
  defaultZipName,
  exportDiagnostics,
};
