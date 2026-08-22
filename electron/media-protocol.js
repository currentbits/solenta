"use strict";

/**
 * Custom protocol so the renderer can <img src="solenta-media://..."> without
 * pulling whole-file base64 across IPC (issue #145). Privileged scheme must
 * be registered before app.ready; the handler is installed once userData is
 * known. Pure parse/build helpers are Electron-free so tests can load this
 * module in plain node.
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  resolveToolImagePath,
  toolImageExists,
  SAFE_ID_RE,
} = require("./tool-images.js");
const attachments = require("./attachments.js");

const SCHEME = "solenta-media";

/**
 * @param {{ registerSchemesAsPrivileged?: Function } | null | undefined} protocol
 */
function registerPrivileged(protocol) {
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== "function") {
    return;
  }
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * @param {unknown} name  `uuid.png` or `threadId/uuid.png`
 * @returns {string | null}
 */
function toolImageUrl(name) {
  const raw = String(name || "").replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return null;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const file = parts[parts.length - 1];
  if (file !== path.basename(file)) return null;
  if (parts.length === 2 && !SAFE_ID_RE.test(parts[0])) return null;
  return `${SCHEME}://tool/${parts.map(encodeURIComponent).join("/")}`;
}

/**
 * @param {unknown} filePath  absolute path (pasted or user-picked)
 * @returns {string | null}
 */
function localImageUrl(filePath) {
  const p = String(filePath || "");
  if (!p) return null;
  return `${SCHEME}://local/?p=${encodeURIComponent(p)}`;
}

/**
 * @param {unknown} url
 * @returns {{ kind: "tool", name: string } | { kind: "local", path: string } | null}
 */
function parseMediaUrl(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:`) return null;
  if (u.username || u.password) return null;
  const host = String(u.hostname || "").toLowerCase();
  if (host === "tool") {
    const raw = u.pathname.replace(/^\/+/, "");
    if (!raw) return null;
    let name;
    try {
      name = raw
        .split("/")
        .map((seg) => decodeURIComponent(seg))
        .join("/");
    } catch {
      return null;
    }
    return { kind: "tool", name };
  }
  if (host === "local") {
    const p = u.searchParams.get("p");
    if (!p) return null;
    return { kind: "local", path: p };
  }
  return null;
}

/**
 * Map a solenta-media URL onto a real file, or null (404).
 * @param {unknown} url
 * @param {string} userDataPath
 * @returns {Promise<{ path: string } | null>}
 */
async function resolveMediaUrl(url, userDataPath) {
  const parsed = parseMediaUrl(url);
  if (!parsed) return null;
  if (parsed.kind === "tool") {
    const full = resolveToolImagePath(userDataPath, parsed.name);
    if (!full) return null;
    if (!(await toolImageExists(userDataPath, parsed.name))) return null;
    return { path: full };
  }
  const resolved = await attachments.resolveImageFile(parsed.path);
  return resolved ? { path: resolved.path } : null;
}

/**
 * @param {{ protocol: { handle: Function }, net: { fetch: Function }, userDataPath: string }} opts
 */
function installHandler(opts) {
  const protocol = opts && opts.protocol;
  const net = opts && opts.net;
  const userDataPath = opts && opts.userDataPath;
  if (
    !protocol ||
    typeof protocol.handle !== "function" ||
    !net ||
    typeof net.fetch !== "function" ||
    !userDataPath
  ) {
    return;
  }
  protocol.handle(SCHEME, async (request) => {
    const resolved = await resolveMediaUrl(request && request.url, userDataPath);
    if (!resolved) {
      return new Response("Not found", { status: 404 });
    }
    try {
      return await net.fetch(pathToFileURL(resolved.path).href);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

module.exports = {
  SCHEME,
  registerPrivileged,
  installHandler,
  toolImageUrl,
  localImageUrl,
  parseMediaUrl,
  resolveMediaUrl,
};
