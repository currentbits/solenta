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
const MAX_FILE_BYTES = MAX_IMAGE_BYTES;
const MAX_FOLDER_BYTES = 100 * 1024 * 1024;
const MAX_FOLDER_FILES = 1000;
const THREAD_ID_RE = /^[A-Za-z0-9_-]+$/;

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
 * @param {{ includeImages?: boolean }} [opts] - false omits the Images filter
 *   (text-only models). Files and folders still pick.
 */
async function pickAttachments(dialog, opts = {}) {
  const filters = [{ name: "All Files", extensions: ["*"] }];
  if (opts.includeImages !== false) {
    filters.push({ name: "Images", extensions: IMAGE_EXTS.slice() });
  }
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters,
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return [];
  }
  const classified = classifyPaths(result.filePaths);
  if (opts.includeImages === false) {
    return classified.filter((a) => a.kind !== "image");
  }
  return classified;
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

function validThreadId(threadId) {
  const tid = String(threadId || "");
  // Thread ids are UUIDs; anything else is a caller trying to escape the
  // attachments dir with `..`, a separator, or a Windows drive/stream colon.
  return THREAD_ID_RE.test(tid) ? tid : null;
}

function threadDir(userDataPath, tid) {
  return path.join(userDataPath, DIR_NAME, tid);
}

function decodeDataUrl(dataUrl, maxBytes) {
  const s = String(dataUrl || "");
  if (!/^data:/i.test(s)) return null;
  const idx = s.search(/;base64,/i);
  if (idx < 0) return null;
  let buf;
  try {
    buf = Buffer.from(s.slice(idx + 8), "base64");
  } catch {
    return null;
  }
  if (!buf.length || buf.length > maxBytes) return null;
  return buf;
}

function safeBaseName(name) {
  const raw = String(name || "");
  if (!raw || raw.includes("\0") || raw.includes("/") || raw.includes("\\")) {
    return null;
  }
  if (raw === "." || raw === ".." || raw.includes("..")) return null;
  if (path.basename(raw) !== raw) return null;
  return raw;
}

function relPathParts(rel) {
  const raw = String(rel || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || raw.includes("\0")) return null;
  const parts = raw.split("/").filter((p) => p !== "");
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return null;
  return parts;
}

function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function saveImage(userDataPath, threadId, dataUrl) {
  const tid = validThreadId(threadId);
  if (!userDataPath || !tid) return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/is.exec(
    String(dataUrl || ""),
  );
  if (!m) return null;
  const ext = EXT_BY_MEDIA[m[1].toLowerCase()];
  if (!ext) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const dir = threadDir(userDataPath, tid);
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
 * Persist a non-image File (web picker/drop) under
 * userData/attachments/<threadId>/. Display name stays the original basename.
 * @returns {{ kind: "file", path: string, name: string } | null}
 */
function saveFile(userDataPath, threadId, name, dataUrl) {
  const tid = validThreadId(threadId);
  const base = safeBaseName(name);
  if (!userDataPath || !tid || !base) return null;
  const buf = decodeDataUrl(dataUrl, MAX_FILE_BYTES);
  if (!buf) return null;
  const dir = threadDir(userDataPath, tid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stored = `${Date.now()}-${randomUUID().slice(0, 8)}-${base}`;
    const full = path.join(dir, stored);
    if (!isInside(dir, full)) return null;
    fs.writeFileSync(full, buf);
    return { kind: "file", path: full, name: base };
  } catch {
    return null;
  }
}

/**
 * Persist a directory tree from a web directory entry / File System Access
 * pick under userData/attachments/<threadId>/<name>-<id>/. Returns
 * kind=folder so Spark/Astra get the same chip native classifyPaths produces.
 * @param {string} userDataPath
 * @param {unknown} threadId
 * @param {unknown} name
 * @param {unknown} files
 * @returns {{ kind: "folder", path: string, name: string } | null}
 */
function saveFolder(userDataPath, threadId, name, files) {
  const tid = validThreadId(threadId);
  const folderName = safeBaseName(name);
  if (!userDataPath || !tid || !folderName || !Array.isArray(files)) return null;
  if (files.length > MAX_FOLDER_FILES) return null;

  const planned = [];
  let total = 0;
  for (const entry of files) {
    const parts = relPathParts(entry && entry.relativePath);
    if (!parts) return null;
    const buf = decodeDataUrl(entry && entry.dataUrl, MAX_FILE_BYTES);
    if (!buf) return null;
    total += buf.length;
    if (total > MAX_FOLDER_BYTES) return null;
    planned.push({ parts, buf });
  }

  const parent = threadDir(userDataPath, tid);
  const dest = path.join(parent, `${folderName}-${randomUUID().slice(0, 8)}`);
  if (!isInside(parent, dest) && path.resolve(dest) !== path.resolve(parent)) {
    return null;
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const { parts, buf } of planned) {
      const full = path.join(dest, ...parts);
      if (!isInside(dest, full)) {
        fs.rmSync(dest, { recursive: true, force: true });
        return null;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
    }
    return { kind: "folder", path: dest, name: folderName };
  } catch {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
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
  saveFile,
  saveFolder,
  savePng,
  readImage,
  resolveImageFile,
  IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  DIR_NAME,
};
