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
const VIDEO_MEDIA_BY_EXT = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
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
  return resolveLocalFile(filePath, MEDIA_BY_EXT, MAX_IMAGE_BYTES);
}

/**
 * Same gate for an attached screen recording (#266). The renderer samples
 * frames from it; the protocol streams it with ranges, so no size cap.
 * @param {unknown} filePath
 */
async function resolveVideoFile(filePath) {
  return resolveLocalFile(filePath, VIDEO_MEDIA_BY_EXT, Infinity);
}

async function resolveLocalFile(filePath, byExt, maxBytes) {
  const p = String(filePath || "");
  const ext = path.extname(p).slice(1).toLowerCase();
  const mediaType = Object.hasOwn(byExt, ext) ? byExt[ext] : undefined;
  if (!p || !path.isAbsolute(p) || !mediaType) return null;
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size > maxBytes) return null;
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

/**
 * Providers whose agent reads a PDF path itself: Claude's Read tool renders
 * pages, OpenCode `run -f` attaches it natively. Everyone else gets the
 * locally extracted text (#466).
 */
const PDF_NATIVE_PROVIDERS = new Set(["claude", "opencode"]);
const PDF_TEXT_MAX_PAGES = 100;
const PDF_TEXT_TIMEOUT_MS = 30_000;

// PDFKit through JXA: macOS ships it, so no bundled parser. Pages end in \f.
const PDFKIT_JXA = `function run(argv) {
  ObjC.import("PDFKit");
  const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (d.isNil()) return "";
  const n = Math.min(d.pageCount, Number(argv[1]));
  let s = "";
  for (let i = 0; i < n; i++) {
    const p = d.pageAtIndex(i);
    s += (p.isNil() ? "" : ObjC.unwrap(p.string) || "") + "\\n\\f";
  }
  return s;
}`;

function runPdfToText(pdfPath) {
  const { execFile } = require("node:child_process");
  const max = String(PDF_TEXT_MAX_PAGES);
  // ponytail: Windows/Linux need poppler's pdftotext on PATH; bundle
  // pdfjs-dist (35 MB) if users there need it without poppler.
  const [cmd, args] =
    process.platform === "darwin"
      ? ["osascript", ["-l", "JavaScript", "-e", PDFKIT_JXA, pdfPath, max]]
      : ["pdftotext", ["-l", max, "-enc", "UTF-8", pdfPath, "-"]];
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: PDF_TEXT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : String(stdout)),
    );
  });
}

/**
 * Extract an attached PDF's text to userData/attachments/<threadId>/ so a
 * provider that cannot read PDFs gets something it can (#466). Capped at
 * PDF_TEXT_MAX_PAGES. Null when nothing came out (scanned, encrypted, no
 * extractor on this OS).
 * @param {string} userDataPath
 * @param {unknown} threadId
 * @param {string} pdfPath
 * @param {(pdfPath: string) => Promise<string>} [extract]
 * @returns {Promise<{ path: string, truncated: boolean } | null>}
 */
async function extractPdfText(
  userDataPath,
  threadId,
  pdfPath,
  extract = runPdfToText,
) {
  const tid = validThreadId(threadId);
  const base = safeBaseName(path.basename(String(pdfPath || "")));
  if (!userDataPath || !tid || !base || !path.isAbsolute(pdfPath)) return null;
  const text = await extract(pdfPath);
  if (!text.replace(/\s+/g, "")) return null;
  const pages = text.split("\f").length - 1;
  const dir = threadDir(userDataPath, tid);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const full = path.join(
      dir,
      `${Date.now()}-${randomUUID().slice(0, 8)}-${base}.txt`,
    );
    await fs.promises.writeFile(full, text);
    return { path: full, truncated: pages >= PDF_TEXT_MAX_PAGES };
  } catch {
    return null;
  }
}

/**
 * CLI-only prompt section pointing a PDF-blind provider at extracted text
 * for each attached PDF. Empty for PDF-native providers or no PDFs.
 * @param {{ userDataPath: string | null, threadId: string, provider: string,
 *   attachments: { kind: string, path: string }[],
 *   extract?: (pdfPath: string) => Promise<string> }} opts
 * @returns {Promise<string>}
 */
async function pdfTextSection(opts) {
  if (!opts.userDataPath || PDF_NATIVE_PROVIDERS.has(opts.provider)) return "";
  const pdfs = opts.attachments.filter(
    (a) => a.kind === "file" && /\.pdf$/i.test(a.path),
  );
  if (!pdfs.length) return "";
  const lines = [];
  for (const a of pdfs) {
    const out = await extractPdfText(
      opts.userDataPath,
      opts.threadId,
      a.path,
      opts.extract,
    );
    lines.push(
      out
        ? `- ${a.path} -> ${out.path}` +
            (out.truncated ? ` (first ${PDF_TEXT_MAX_PAGES} pages only)` : "")
        : `- ${a.path}: no text could be extracted (scanned or protected PDF?)`,
    );
  }
  return (
    "\n\n[This model cannot read PDF files, so Solenta extracted their text " +
    "locally. Read the .txt instead of the PDF:\n" +
    lines.join("\n") +
    "]"
  );
}

module.exports = {
  classifyPaths,
  extractPdfText,
  pdfTextSection,
  PDF_NATIVE_PROVIDERS,
  pickAttachments,
  saveImage,
  saveFile,
  saveFolder,
  savePng,
  readImage,
  resolveImageFile,
  resolveVideoFile,
  IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  DIR_NAME,
};
