"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * Outbound counterpart to tool-images.js: files/images/folders the USER
 * attaches to a chat message. Only absolute paths travel to the agent;
 * pasted images are persisted under userData so the path stays valid after
 * the clipboard is gone.
 */
const DIR_NAME = "attachments";

/** Extensions treated as image attachments (thumbnails); other files stay kind "file". */
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
 * Classify absolute paths as image, file, or folder. Images keep their
 * kind so the composer can thumbnail them; every other regular file is
 * `kind: "file"` (issue #653). Missing / relative / non-file paths skip.
 * @param {unknown} paths
 * @returns {{ kind: "image" | "folder" | "file", path: string, name: string }[]}
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
    out.push({
      kind: IMAGE_EXT_SET.has(ext) ? "image" : "file",
      path: p,
      name,
    });
  }
  return out;
}

/**
 * Native picker (files + images + folders, multi-select). Returns classified picks.
 * @param {{ showOpenDialog: (opts: object) => Promise<{ canceled: boolean, filePaths?: string[] }> }} dialog
 */
async function pickAttachments(dialog) {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      { name: "All Files", extensions: ["*"] },
      { name: "Images", extensions: IMAGE_EXTS.slice() },
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
 * are timestamped + random. image-store.js prunes archived/deleted thread
 * dirs and enforces a global size cap (issue #145).
 * @param {string} userDataPath
 * @param {unknown} threadId
 * @param {unknown} dataUrl
 * @returns {{ kind: "image", path: string, name: string } | null}
 */
function savePng(userDataPath, threadId, buf) {
  const tid = String(threadId || "");
  if (!userDataPath || !/^[A-Za-z0-9_-]+$/.test(tid)) return null;
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_IMAGE_BYTES) {
    return null;
  }
  const dir = path.join(userDataPath, DIR_NAME, tid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, buf);
    return { kind: "image", path: full, name };
  } catch {
    return null;
  }
}

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
 * Stat + type/size gate for an attached image. `filePath` is an arbitrary
 * absolute path by design: the user picks images anywhere on disk.
 * @param {unknown} filePath
 * @returns {Promise<{ path: string, mediaType: string, size: number } | null>}
 */
async function resolveImageFile(filePath) {
  const p = String(filePath || "");
  const mediaType = MEDIA_BY_EXT[path.extname(p).slice(1).toLowerCase()];
  if (!p || !path.isAbsolute(p) || !mediaType) return null;
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    return { path: p, mediaType, size: st.size };
  } catch {
    return null;
  }
}

/**
 * Read an attached image back as a data URL. Used by the web bridge (no
 * custom protocol). Desktop IPC returns a solenta-media:// URL instead.
 * @param {unknown} filePath
 * @returns {Promise<string | null>}
 */
async function readImage(filePath) {
  const resolved = await resolveImageFile(filePath);
  if (!resolved) return null;
  try {
    const buf = await fs.promises.readFile(resolved.path);
    return `data:${resolved.mediaType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

module.exports = {
  classifyPaths,
  pickAttachments,
  saveImage,
  savePng,
  readImage,
  resolveImageFile,
  IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  DIR_NAME,
};
