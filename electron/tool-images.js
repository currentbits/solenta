"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** Under userData; one flat directory, filenames are random. */
// ponytail: files are never pruned — a screenshot is ~200KB and nothing else
// in userData is pruned either. Add an age sweep on boot if it ever grows.
const DIR_NAME = "tool-images";

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
 * Write images beside the store instead of into it: the store is one JSON file
 * rewritten in full on every event, and a screenshot is megabytes.
 * @param {string} userDataPath
 * @param {{ mediaType: string, data: string }[]} images
 * @returns {string[]} bare filenames for ToolCallInfo.images
 */
function saveToolImages(userDataPath, images) {
  if (!userDataPath || !images || !images.length) return [];
  const dir = path.join(userDataPath, DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
  const names = [];
  for (const img of images) {
    const name = `${randomUUID()}.${EXT_BY_MEDIA[img.mediaType] || "png"}`;
    try {
      fs.writeFileSync(path.join(dir, name), Buffer.from(img.data, "base64"));
      names.push(name);
    } catch {
      // a screenshot is never worth failing the turn over
    }
  }
  return names;
}

/**
 * Read one back as a data URL (the CSP allows data:, not file:).
 * `name` comes from the renderer → basename only, never a traversal.
 * @param {string} userDataPath
 * @param {string} name
 * @returns {string | null}
 */
function readToolImage(userDataPath, name) {
  const base = path.basename(String(name || ""));
  const ext = path.extname(base).slice(1).toLowerCase();
  const mediaType = MEDIA_BY_EXT[ext];
  if (!userDataPath || !mediaType) return null;
  try {
    const buf = fs.readFileSync(path.join(userDataPath, DIR_NAME, base));
    return `data:${mediaType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

module.exports = { extractImages, saveToolImages, readToolImage, DIR_NAME };
