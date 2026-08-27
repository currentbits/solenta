"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** Under userData; per-thread subdirs, plus leftover flat files from older builds. */
const DIR_NAME = "tool-images";

/** Thread ids are UUIDs; anything else is a path-escape attempt. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

const EXT_BY_MEDIA = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MEDIA_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Strip a data-URL prefix so Buffer.from(..., "base64") gets raw payload.
 * @param {string} data
 * @returns {string}
 */
function normalizeB64(data) {
  const s = String(data).replace(/\s+/g, "");
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(s);
  return m ? m[1] : s;
}

/**
 * Anthropic `{ type:image, source:{ type:base64, data } }` or MCP
 * `{ type:image, data, mimeType }` — the two shapes screenshot tools emit.
 * @param {unknown} node
 * @returns {{ mediaType: string, data: string } | null}
 */
function imageFromNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const b = /** @type {{ type?: unknown, data?: unknown, mimeType?: unknown, mediaType?: unknown, media_type?: unknown, source?: { type?: unknown, media_type?: unknown, data?: unknown } }} */ (
    node
  );
  if (b.type !== "image") return null;
  if (b.source && typeof b.source === "object") {
    if (b.source.type !== "base64") return null;
    if (typeof b.source.data !== "string" || !b.source.data) return null;
    return {
      mediaType: String(
        b.source.media_type || b.mediaType || b.mimeType || "image/png",
      ),
      data: normalizeB64(b.source.data),
    };
  }
  if (typeof b.data !== "string" || !b.data) return null;
  return {
    mediaType: String(b.mimeType || b.media_type || b.mediaType || "image/png"),
    data: normalizeB64(b.data),
  };
}

/**
 * JSON that actually carries an image block. Cheap reject for ordinary
 * tool output (file contents, shell stdout) so we do not parse megabytes
 * looking for screenshots.
 * @param {unknown} text
 * @returns {unknown}
 */
function tryParseImageJson(text) {
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  if (!/"type"\s*:\s*"image"/.test(t)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} node
 * @param {{ mediaType: string, data: string }[]} out
 * @param {WeakSet<object>} seen
 */
function collectImages(node, out, seen) {
  if (node == null) return;
  if (typeof node === "string") {
    const parsed = tryParseImageJson(node);
    if (parsed !== undefined) collectImages(parsed, out, seen);
    return;
  }
  if (typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  const img = imageFromNode(node);
  if (img) {
    out.push(img);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, out, seen);
    return;
  }
  for (const v of Object.values(node)) collectImages(v, out, seen);
}

/**
 * @param {unknown} node
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function rewriteImages(node, seen) {
  if (node == null || typeof node !== "object") {
    const parsed = tryParseImageJson(node);
    return parsed !== undefined ? rewriteImages(parsed, seen) : node;
  }
  if (seen.has(node)) return node;
  seen.add(node);
  if (imageFromNode(node)) {
    const b = /** @type {Record<string, unknown>} */ (node);
    if (b.source && typeof b.source === "object") {
      return { ...b, source: { .../** @type {object} */ (b.source), data: "[image]" } };
    }
    return { ...b, data: "[image]" };
  }
  if (Array.isArray(node)) return node.map((item) => rewriteImages(item, seen));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = rewriteImages(v, seen);
  return out;
}

/**
 * Image blocks carried by a tool result (Read of a PNG, an MCP screenshot).
 * Walks arrays, objects, and JSON strings so Cursor/Kimi payloads nested
 * under `result.success` still yield files — not truncated base64 text.
 * @param {unknown} content
 * @returns {{ mediaType: string, data: string }[]}
 */
function extractImages(content) {
  const out = [];
  collectImages(content, out, new WeakSet());
  return out;
}

/**
 * Deep copy with image payloads replaced by `"[image]"` so stringify +
 * OUTPUT_TRUNCATE does not fill the tool card with base64.
 * @param {unknown} value
 * @returns {unknown}
 */
function redactImages(value) {
  return rewriteImages(value, new WeakSet());
}

/**
 * Pull screenshots out of a raw tool result and return a copy safe to
 * store as `ToolCallInfo.output`.
 * @param {unknown} value
 * @returns {{ images: { mediaType: string, data: string }[], redacted: unknown }}
 */
function harvestToolResult(value) {
  const images = extractImages(value);
  if (!images.length) return { images, redacted: value };
  return { images, redacted: redactImages(value) };
}

/**
 * `name` is either a legacy basename (`uuid.png`) or `threadId/uuid.png`.
 * Never a traversal: each segment is a SAFE_ID / basename with a known ext.
 * @param {string} userDataPath
 * @param {unknown} name
 * @returns {string | null}
 */
function resolveToolImagePath(userDataPath, name) {
  if (!userDataPath) return null;
  const raw = String(name || "").replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return null;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const file = parts[parts.length - 1];
  if (file !== path.basename(file)) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!MEDIA_BY_EXT[ext]) return null;
  if (parts.length === 2) {
    const tid = parts[0];
    if (!SAFE_ID_RE.test(tid) || tid !== path.basename(tid)) return null;
  }
  const root = path.resolve(path.join(userDataPath, DIR_NAME));
  const full = path.resolve(path.join(root, ...parts));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * Write images beside the store instead of into it: the store is one JSON file
 * rewritten in full on every event, and a screenshot is megabytes.
 * When `threadId` is a safe id, files land in tool-images/<threadId>/ and the
 * returned names are `threadId/<file>` so prune can drop a whole thread.
 * @param {string} userDataPath
 * @param {{ mediaType: string, data: string }[]} images
 * @param {unknown} [threadId]
 * @returns {string[]} names for ToolCallInfo.images
 */
function saveToolImages(userDataPath, images, threadId) {
  if (!userDataPath || !images || !images.length) return [];
  const tid = String(threadId || "");
  const scoped = SAFE_ID_RE.test(tid);
  const dir = scoped
    ? path.join(userDataPath, DIR_NAME, tid)
    : path.join(userDataPath, DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
  const names = [];
  for (const img of images) {
    const file = `${randomUUID()}.${EXT_BY_MEDIA[img.mediaType] || "png"}`;
    try {
      fs.writeFileSync(path.join(dir, file), Buffer.from(img.data, "base64"));
      names.push(scoped ? `${tid}/${file}` : file);
    } catch {
      // a screenshot is never worth failing the turn over
    }
  }
  return names;
}

/**
 * Read one back as a data URL. Used by the web bridge (no custom protocol).
 * Desktop IPC returns a solenta-media:// URL instead; see media-protocol.js.
 * @param {string} userDataPath
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function readToolImage(userDataPath, name) {
  const full = resolveToolImagePath(userDataPath, name);
  const ext = path.extname(String(name || "")).slice(1).toLowerCase();
  const mediaType = MEDIA_BY_EXT[ext];
  if (!full || !mediaType) return null;
  try {
    const buf = await fs.promises.readFile(full);
    return `data:${mediaType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * True when the file exists on disk (cheap; no bytes). Desktop IPC uses this
 * before returning a protocol URL so a missing image is null, not a broken img.
 * @param {string} userDataPath
 * @param {unknown} name
 * @returns {Promise<boolean>}
 */
async function toolImageExists(userDataPath, name) {
  const full = resolveToolImagePath(userDataPath, name);
  if (!full) return false;
  try {
    await fs.promises.access(full);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  extractImages,
  redactImages,
  harvestToolResult,
  saveToolImages,
  readToolImage,
  resolveToolImagePath,
  toolImageExists,
  DIR_NAME,
  SAFE_ID_RE,
  MEDIA_BY_EXT,
};
