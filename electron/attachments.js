"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const childProcess = require("node:child_process");

/**
 * Outbound counterpart to tool-images.js: files/images/folders the USER
 * attaches to a chat message. Only absolute paths travel to the agent;
 * pasted images are persisted under userData so the path stays valid after
 * the clipboard is gone.
 */
const DIR_NAME = "attachments";

/**
 * Extensions treated as image attachments (thumbnails); other files stay
 * kind "file". HEIC/HEIF only stays an image once transcodeHeic swapped it
 * for a JPEG: no provider and no <img> reads it (#463).
 */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif"];
const IMAGE_EXT_SET = new Set(IMAGE_EXTS);
const HEIC_EXT_SET = new Set(["heic", "heif"]);

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
  "image/heic": "heic",
  "image/heif": "heif",
};

/** Refuse to base64 a huge file into an IPC reply / store-bound thumbnail. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_IMAGE_BYTES;
const MAX_FOLDER_BYTES = 100 * 1024 * 1024;
const MAX_FOLDER_FILES = 1000;
const THREAD_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Downscale target for an oversize image (issue #1773): longest side and
 * byte budget safe for every provider Solenta supports. Claude's API is the
 * tightest (~5MB, ~8000px/side); 4096px and 4MB leave headroom under that
 * without visibly degrading a screenshot or photo. Extensions that can carry
 * transparency keep PNG; everything else re-encodes as JPEG, which shrinks
 * far more per step.
 */
const DOWNSCALE_MAX_DIMENSION = 4096;
const DOWNSCALE_TARGET_BYTES = 4 * 1024 * 1024;
const JPEG_QUALITY_STEPS = [85, 75, 65, 55, 45, 35];
const DIMENSION_STEP_FACTORS = [1, 0.75, 0.5, 0.35];
const ALPHA_EXT_SET = new Set(["png", "gif", "webp"]);

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
 * Pure step-down plan for shrinking an oversize image: shrink the longest
 * side to maxDimension (a no-op if it already fits), then try progressively
 * lower JPEG quality at that size, then shrink further and repeat. PNG only
 * gets a dimension step (no quality knob) and is tried first when the
 * source might carry transparency; the JPEG steps that follow are the real
 * fallback, since they shrink far more per step and have no alpha to lose.
 * No image codec here (nativeImage may not exist under plain node tests) -
 * downscaleImage is the impure driver that actually encodes each step.
 * @param {number} width
 * @param {number} height
 * @param {{ hasAlpha?: boolean, maxDimension?: number }} [opts]
 * @returns {{ width: number, height: number, format: "png" | "jpeg", quality?: number }[]}
 */
function planDownscaleSteps(width, height, opts = {}) {
  const maxDimension = opts.maxDimension || DOWNSCALE_MAX_DIMENSION;
  const longest = Math.max(width, height) || 1;
  const baseScale = Math.min(1, maxDimension / longest);
  const steps = [];
  for (const factor of DIMENSION_STEP_FACTORS) {
    const scale = baseScale * factor;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (opts.hasAlpha) steps.push({ width: w, height: h, format: "png" });
    for (const quality of JPEG_QUALITY_STEPS) {
      steps.push({ width: w, height: h, format: "jpeg", quality });
    }
  }
  return steps;
}

/**
 * Whether an image is worth running through downscaleImage at all: over the
 * reject cap or over the per-side dimension limit. Pure (no decode) so the
 * save* functions can gate the nativeImage call.
 * @param {number} width
 * @param {number} height
 * @param {number} byteLength
 * @param {{ rejectBytes?: number, maxDimension?: number }} [opts]
 */
function imageNeedsDownscale(width, height, byteLength, opts = {}) {
  const rejectBytes = opts.rejectBytes || MAX_IMAGE_BYTES;
  const maxDimension = opts.maxDimension || DOWNSCALE_MAX_DIMENSION;
  return byteLength > rejectBytes || Math.max(width, height) > maxDimension;
}

/** Test hook: a fake `{ createFromBuffer }`. Pass null to restore electron's. */
let nativeImageImpl = null;
function setNativeImage(impl) {
  nativeImageImpl = impl;
}

function getNativeImage() {
  try {
    const mod = require("electron");
    return mod && typeof mod === "object" ? mod.nativeImage || null : null;
  } catch {
    return null;
  }
}

/**
 * Resize + re-encode an oversize image buffer until it fits maxBytes.
 * `ok: false` means give up (today's rejection applies); `ok: true,
 * changed: false` means it was already within limits and the caller should
 * keep the original bytes.
 * @param {Buffer} buf
 * @param {{ hasAlpha?: boolean, maxBytes?: number, maxDimension?: number, rejectBytes?: number }} [opts]
 * @returns {{ ok: boolean, changed?: boolean, buffer?: Buffer, format?: "png"|"jpeg",
 *   width?: number, height?: number, originalWidth?: number, originalHeight?: number }}
 */
function downscaleImage(buf, opts = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false };
  const nativeImage = nativeImageImpl || getNativeImage();
  if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
    return { ok: false };
  }
  const maxDimension = opts.maxDimension || DOWNSCALE_MAX_DIMENSION;
  const maxBytes = opts.maxBytes || DOWNSCALE_TARGET_BYTES;
  let image;
  try {
    image = nativeImage.createFromBuffer(buf);
  } catch {
    return { ok: false };
  }
  const size = image && typeof image.getSize === "function" ? image.getSize() : null;
  if (!size || !size.width || !size.height) return { ok: false };
  if (!imageNeedsDownscale(size.width, size.height, buf.length, { ...opts, maxDimension })) {
    return { ok: true, changed: false };
  }
  for (const step of planDownscaleSteps(size.width, size.height, {
    maxDimension,
    hasAlpha: opts.hasAlpha,
  })) {
    try {
      const resized =
        step.width === size.width && step.height === size.height
          ? image
          : image.resize({ width: step.width, height: step.height });
      const out = step.format === "png" ? resized.toPNG() : resized.toJPEG(step.quality);
      if (out && out.length && out.length <= maxBytes) {
        return {
          ok: true,
          changed: true,
          buffer: out,
          format: step.format,
          width: step.width,
          height: step.height,
          originalWidth: size.width,
          originalHeight: size.height,
        };
      }
    } catch {
      // this step's resize/encode failed; try the next one
    }
  }
  return { ok: false };
}

/**
 * saveImage/savePng/transcodeHeic share this: downscale when worth it, else
 * hand back the original buffer untouched. `ext` is the extension to use
 * going forward (unchanged unless the format actually changed).
 * @param {Buffer} buf
 * @param {string} ext
 * @returns {{ buffer: Buffer, ext: string, resizedFrom: { width: number, height: number } | null }}
 */
function maybeDownscaleBuffer(buf, ext) {
  const result = downscaleImage(buf, { hasAlpha: ALPHA_EXT_SET.has(ext) });
  if (result.ok && result.changed && result.buffer) {
    return {
      buffer: result.buffer,
      ext: result.format === "png" ? "png" : "jpg",
      resizedFrom: { width: result.originalWidth, height: result.originalHeight },
    };
  }
  return { buffer: buf, ext, resizedFrom: null };
}

/**
 * Persist a pasted image beside the store (same reasoning as tool-images:
 * the store is one JSON file rewritten in full on every event). Filenames
 * are timestamped + random. image-store.js prunes archived/deleted thread
 * dirs and enforces a global size cap (issue #145). Oversize captures are
 * downscaled (#1773) rather than refused outright; MAX_IMAGE_BYTES is the
 * last-resort reject if even the smallest step doesn't fit.
 * @param {string} userDataPath
 * @param {unknown} threadId
 * @param {unknown} dataUrl
 * @returns {{ kind: "image", path: string, name: string } | null}
 */
function savePng(userDataPath, threadId, buf) {
  const tid = String(threadId || "");
  if (!userDataPath || !/^[A-Za-z0-9_-]+$/.test(tid)) return null;
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  const shrunk = maybeDownscaleBuffer(buf, "png");
  if (shrunk.buffer.length > MAX_IMAGE_BYTES) return null;
  const dir = path.join(userDataPath, DIR_NAME, tid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${shrunk.ext}`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, shrunk.buffer);
    return {
      kind: "image",
      path: full,
      name,
      ...(shrunk.resizedFrom ? { resizedFrom: shrunk.resizedFrom } : {}),
    };
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

/**
 * Oversize pastes/drops are downscaled (#1773) rather than refused outright;
 * MAX_IMAGE_BYTES is still the last-resort reject when even the smallest
 * step doesn't fit.
 */
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
  if (!buf.length) return null;
  const shrunk = maybeDownscaleBuffer(buf, ext);
  if (shrunk.buffer.length > MAX_IMAGE_BYTES) return null;
  const dir = threadDir(userDataPath, tid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${shrunk.ext}`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, shrunk.buffer);
    return {
      kind: "image",
      path: full,
      name,
      ...(shrunk.resizedFrom ? { resizedFrom: shrunk.resizedFrom } : {}),
    };
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
 * HEIC -> JPEG decoders, first that writes the file wins. sips ships with
 * macOS; heif-convert (libheif) and ImageMagick cover Linux/Windows when
 * installed. ponytail: no bundled decoder, add one if non-mac users hit it.
 */
const HEIC_DECODERS = [
  ["sips", (src, out) => ["-s", "format", "jpeg", src, "--out", out]],
  ["heif-convert", (src, out) => ["-q", "90", src, out]],
  ["magick", (src, out) => [src, out]],
];

/** @type {typeof childProcess.execFile | null} */
let execFileImpl = null;

/** Test hook. Pass null to restore node's execFile. */
function setExecFile(fn) {
  execFileImpl = fn;
}

function runDecoder(bin, args) {
  const exec = execFileImpl || childProcess.execFile;
  return new Promise((resolve, reject) => {
    exec(bin, args, { timeout: 30000, windowsHide: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

async function heicToJpeg(src, dir) {
  const out = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.jpg`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  for (const [bin, args] of HEIC_DECODERS) {
    try {
      await runDecoder(bin, args(src, out));
      if (fs.statSync(out).size > 0) return out;
    } catch {
      // missing binary or decode failure: try the next one
    }
  }
  fs.rmSync(out, { force: true });
  return null;
}

/**
 * Claude, Codex and most CLIs reject image/heic, the iPhone camera default
 * (#463). Swap each HEIC/HEIF attachment for a JPEG under
 * userData/attachments/<threadId>/. The original stays on disk where it
 * was. No decoder (or no thread) leaves it a plain kind "file", never an
 * image the provider will refuse.
 * @param {{ kind: string, path: string, name: string }[]} list
 * @param {string} userDataPath
 * @param {unknown} threadId
 */
async function transcodeHeic(list, userDataPath, threadId) {
  const tid = validThreadId(threadId);
  return Promise.all(
    list.map(async (a) => {
      const ext = a && a.kind !== "folder" && path.extname(a.path).slice(1).toLowerCase();
      if (!ext || !HEIC_EXT_SET.has(ext)) return a;
      const out =
        userDataPath && tid
          ? await heicToJpeg(a.path, threadDir(userDataPath, tid))
          : null;
      if (!out) return { ...a, kind: "file" };
      // Phone cameras HEIC-encode at resolutions well past every provider's
      // image cap; downscale the JPEG we just wrote (#1773), best-effort.
      const resizedFrom = shrinkFileInPlace(out);
      return {
        kind: "image",
        path: out,
        name: a.name,
        convertedFrom: ext.toUpperCase(),
        ...(resizedFrom ? { resizedFrom } : {}),
      };
    }),
  );
}

/** Downscale a JPEG already on disk in place; returns resizedFrom or null. */
function shrinkFileInPlace(jpegPath) {
  try {
    const bytes = fs.readFileSync(jpegPath);
    const shrunk = maybeDownscaleBuffer(bytes, "jpg");
    if (!shrunk.resizedFrom) return null;
    fs.writeFileSync(jpegPath, shrunk.buffer);
    return shrunk.resizedFrom;
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
/** pdf-text.js reads the whole file into memory; refuse slide-deck monsters. */
const PDF_TEXT_MAX_BYTES = 100 * 1024 * 1024;

/** pdfjs in a child (pdf-text.js): off the main thread, killable on timeout. */
async function runPdfToText(pdfPath) {
  try {
    const st = await fs.promises.stat(pdfPath);
    if (!st.isFile() || st.size > PDF_TEXT_MAX_BYTES) return "";
  } catch {
    return "";
  }
  const { execFile } = require("node:child_process");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        path.join(__dirname, "pdf-text.js"),
        pdfPath,
        String(PDF_TEXT_MAX_PAGES),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: PDF_TEXT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout) => resolve(err ? "" : String(stdout)),
    );
  });
}

/**
 * Extract an attached PDF's text to userData/attachments/<threadId>/ so a
 * provider that cannot read PDFs gets something it can (#466). Capped at
 * PDF_TEXT_MAX_PAGES. Null when nothing came out (scanned, encrypted,
 * corrupt, over PDF_TEXT_MAX_BYTES, or timed out).
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
  transcodeHeic,
  setExecFile,
  IMAGE_EXTS,
  MAX_IMAGE_BYTES,
  DIR_NAME,
  planDownscaleSteps,
  imageNeedsDownscale,
  downscaleImage,
  setNativeImage,
  DOWNSCALE_MAX_DIMENSION,
  DOWNSCALE_TARGET_BYTES,
};
