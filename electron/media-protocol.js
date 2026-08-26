"use strict";

/**
 * Custom protocol so the renderer can <img src="solenta-media://..."> without
 * pulling whole-file base64 across IPC (issue #145). Privileged scheme must
 * be registered before app.ready; the handler is installed once userData is
 * known. Pure parse/build helpers are Electron-free so tests can load this
 * module in plain node.
 */

const path = require("node:path");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const {
  resolveToolImagePath,
  toolImageExists,
  SAFE_ID_RE,
} = require("./tool-images.js");
const attachments = require("./attachments.js");
const { resolveByteRange } = require("./artifact-range.js");

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
 * @param {unknown} id
 * @returns {string | null}
 */
function artifactUrl(id) {
  const value = String(id || "");
  return SAFE_ID_RE.test(value)
    ? `${SCHEME}://artifact/${encodeURIComponent(value)}`
    : null;
}

/**
 * @param {unknown} url
 * @returns {{ kind: "tool", name: string } | { kind: "local", path: string } | { kind: "artifact", id: string } | null}
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
  if (host === "artifact") {
    const raw = u.pathname.replace(/^\/+/, "");
    if (!raw) return null;
    let id;
    try {
      id = decodeURIComponent(raw.split("/")[0]);
    } catch {
      return null;
    }
    if (!SAFE_ID_RE.test(id)) return null;
    return { kind: "artifact", id };
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
 * @param {Record<string, string>} [extra]
 */
function artifactSecurityHeaders(extra = {}) {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

/**
 * @param {{ info: { mimeType: string }, path: string, size: number }} opened
 * @param {Request} request
 * @returns {Response}
 */
function artifactRangeResponse(opened, request) {
  const rangeHeader =
    request && request.headers && typeof request.headers.get === "function"
      ? request.headers.get("range")
      : null;
  const range = resolveByteRange(rangeHeader, opened.size);
  const baseHeaders = artifactSecurityHeaders({
    "Content-Type": opened.info.mimeType,
    "Accept-Ranges": "bytes",
  });

  if (range.status === 416) {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        "Content-Length": "0",
        "Content-Range": `bytes */${opened.size}`,
      },
    });
  }

  const headers = {
    ...baseHeaders,
    "Content-Length": String(range.length),
  };
  if (range.status === 206) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${opened.size}`;
  }

  const method = request && request.method ? request.method.toUpperCase() : "GET";
  if (method === "HEAD" || range.length === 0) {
    return new Response(null, { status: range.status, headers });
  }

  const stream = fs.createReadStream(opened.path, {
    start: range.start,
    end: range.end,
  });
  return new Response(Readable.toWeb(stream), { status: range.status, headers });
}

/**
 * @param {{ protocol: { handle: Function }, net: { fetch: Function }, userDataPath: string, getArtifactStore?: () => { open: Function } | null }} opts
 */
function installHandler(opts) {
  const protocol = opts && opts.protocol;
  const net = opts && opts.net;
  const userDataPath = opts && opts.userDataPath;
  const getArtifactStore = opts && opts.getArtifactStore;
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
    const parsed = parseMediaUrl(request && request.url);
    if (parsed && parsed.kind === "artifact") {
      const method =
        request && request.method ? request.method.toUpperCase() : "GET";
      if (method !== "GET" && method !== "HEAD") {
        return new Response(null, {
          status: 405,
          headers: artifactSecurityHeaders(),
        });
      }

      const store =
        typeof getArtifactStore === "function" ? getArtifactStore() : null;
      if (!store || typeof store.open !== "function") {
        return new Response(null, {
          status: 404,
          headers: artifactSecurityHeaders(),
        });
      }

      let opened;
      try {
        opened = await store.open({ id: parsed.id });
      } catch {
        return new Response(null, {
          status: 500,
          headers: artifactSecurityHeaders(),
        });
      }

      if (!opened) {
        return new Response(null, {
          status: 404,
          headers: artifactSecurityHeaders(),
        });
      }
      return artifactRangeResponse(opened, request);
    }

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
  artifactUrl,
  parseMediaUrl,
  resolveMediaUrl,
  artifactRangeResponse,
  artifactSecurityHeaders,
};
