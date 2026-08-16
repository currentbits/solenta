"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * Outbound counterpart to tool-images.js: images/folders the USER attaches
 * to a chat message. Only absolute paths travel to the agent; pasted images
 * are persisted under userData so the path stays valid after the clipboard
 * is gone.
 */
const DIR_NAME = "attachments";

/** Extensions treated as image attachments; anything else file-like is skipped. */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const IMAGE_EXT_SET = new Set(IMAGE_EXTS);

const MEDIA_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};
const EXT_BY_MEDIA = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/** Refuse to base64 a huge file into an IPC reply / store-bound thumbnail. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Classify absolute paths as image or folder. Non-image files are skipped:
 * they belong to the composer's @-mention flow, not attachments.
 * @param {unknown} paths
 * @returns {{ kind: "image" | "folder", path: string, name: string }[]}
 */
function classifyPaths(paths) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const raw of paths) {
    const p = String(raw || "").trim();
    if (!p || !path.isAbsolute(p)) continue;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    const name = path.basename(p);
    if (st.isDirectory()) {
      out.push({ kind: "folder", path: p, name });
      continue;
    }
    if (!st.isFile()) continue;
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!IMAGE_EXT_SET.has(ext)) continue;
    out.push({ kind: "image", path: p, name });
  }
  return out;
}

/**
 * Native picker (images + folders, multi-select). Returns classified picks.
 * @param {{ showOpenDialog: (opts: object) => Promise<{ canceled: boolean, filePaths?: string[] }> }} dialog
 */
async function pickAttachments(dialog) {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      { name: "Images", extensions: IMAGE_EXTS.slice() },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return [];
  }
  return classifyPaths(result.filePaths);
}

/**
 * Persist a pasted image beside the store (same reasoning as tool-images:
 * the store is one JSON file rewritten in full on every event). Filenames
 * are timestamped + random; nothing here is pruned.
 * @param {string} userDataPath
 * @param {unknown} threadId
 * @param {unknown} dataUrl
 * @returns {{ kind: "image", path: string, name: string } | null}
 */
function saveImage(userDataPath, threadId, dataUrl) {
  const tid = String(threadId || "");
  // Thread ids are UUIDs; anything else is a caller trying to escape the
  // attachments dir with `..`, a separator, or a Windows drive/stream colon.
  if (!userDataPath || !/^[A-Za-z0-9_-]+$/.test(tid)) return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/is.exec(
    String(dataUrl || ""),
  );
  if (!m) return null;
  const ext = EXT_BY_MEDIA[m[1].toLowerCase()];
  if (!ext) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const dir = path.join(userDataPath, DIR_NAME, tid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, buf);
    return { kind: "image", path: full, name };
  } catch {
    return null;
  }
}

/**
 * Read an attached image back as a data URL (the CSP allows data:, not
 * file:). `filePath` is an arbitrary absolute path by design: the user picks
 * images anywhere on disk. Refuses non-image extensions and huge files.
 * @param {unknown} filePath
 * @returns {string | null}
 */
function readImage(filePath) {
  const p = String(filePath || "");
  const mediaType = MEDIA_BY_EXT[path.extname(p).slice(1).toLowerCase()];
  if (!p || !path.isAbsolute(p) || !mediaType) return null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(p);
    return `data:${mediaType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

module.exports = {
  classifyPaths,
  pickAttachments,
  saveImage,
  readImage,
  IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  DIR_NAME,
};
