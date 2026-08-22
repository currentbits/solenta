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
 * Image blocks carried by a tool_result (Read of a PNG, an MCP screenshot).
 * @param {unknown} content
 * @returns {{ mediaType: string, data: string }[]}
 */
function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = /** @type {{ type?: string, source?: { type?: string, media_type?: string, data?: string } }} */ (
      block
    );
    if (b.type !== "image" || !b.source) continue;
    if (b.source.type !== "base64") continue;
    if (typeof b.source.data !== "string" || !b.source.data) continue;
    out.push({
      mediaType: String(b.source.media_type || "image/png"),
      data: b.source.data,
    });
  }
  return out;
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
  saveToolImages,
  readToolImage,
  resolveToolImagePath,
  toolImageExists,
  DIR_NAME,
  SAFE_ID_RE,
  MEDIA_BY_EXT,
};
