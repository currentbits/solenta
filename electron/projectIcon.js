"use strict";

/**
 * Project icon discovery (#610). Mirrors T3's ProjectFaviconResolver:
 * user override, then a checked-in solenta.json / t3.json iconPath, then
 * well-known favicon/app-icon files, then <link rel="icon"> in a short
 * list of HTML/root files.
 *
 * Results are cached per git-common-dir so worktrees of the same repo
 * reuse the main checkout's answer. iconUrl is never persisted — only
 * a relative iconPath override lives on the project.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { attachScm } = require("./scm.js");

const ICON_EXTENSIONS = [
  "svg",
  "png",
  "ico",
  "jpg",
  "jpeg",
  "gif",
  "avif",
  "webp",
];
const ALLOWED_EXT = new Set(ICON_EXTENSIONS.map((e) => `.${e}`));
const ICON_FILTERS = [{ name: "Images", extensions: ICON_EXTENSIONS }];

const MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".webp": "image/webp",
};

const MAX_ICON_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const COMMON_DIR_TTL_MS = 60_000;

const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "icon.png",
  "icon.svg",
  "icon.ico",
  "app-icon.png",
  "app-icon.svg",
  "app-icon.ico",
  ".idea/icon.svg",
];

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

// Anchored on `<link` so it only starts at real candidates (T3 #5530).
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

/** @type {((cwd: string) => string) | null} */
let gitCommonDirFn = null;

/** @type {Map<string, { common: string, at: number }>} */
const commonDirCache = new Map();
/** @type {Map<string, { url: string | null, filePath: string | null, mtimeMs: number, usedOverride: boolean }>} */
const iconCache = new Map();

function setGitCommonDirFn(fn) {
  gitCommonDirFn = typeof fn === "function" ? fn : null;
  commonDirCache.clear();
}

function clearIconCache() {
  iconCache.clear();
  commonDirCache.clear();
}

function defaultGitCommonDir(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (out) return path.resolve(out);
  } catch {
    try {
      const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out) return path.resolve(cwd, out);
    } catch {
      // not a git dir, or git missing
    }
  }
  return path.resolve(cwd);
}

function gitCommonDir(cwd) {
  const key = path.resolve(cwd);
  const hit = commonDirCache.get(key);
  if (hit && Date.now() - hit.at < COMMON_DIR_TTL_MS) return hit.common;
  const impl = gitCommonDirFn || defaultGitCommonDir;
  let common;
  try {
    common = impl(cwd);
  } catch {
    common = path.resolve(cwd);
  }
  if (typeof common !== "string" || !common) common = path.resolve(cwd);
  commonDirCache.set(key, { common, at: Date.now() });
  return common;
}

/**
 * Main work tree of the repo that owns `cwd`. Worktrees share a .git
 * common dir whose parent is the primary checkout.
 * @param {string} cwd
 */
function mainWorkTree(cwd) {
  const abs = path.resolve(cwd);
  const common = gitCommonDir(abs);
  if (path.basename(common) === ".git") {
    const main = path.dirname(common);
    try {
      if (fs.statSync(main).isDirectory()) return main;
    } catch {
      // fall through
    }
  }
  return abs;
}

function isInsideRoot(root, candidate) {
  const rootAbs = path.resolve(root);
  const candAbs = path.resolve(candidate);
  return candAbs === rootAbs || candAbs.startsWith(rootAbs + path.sep);
}

/**
 * Persistable relative path, or null for Automatic. Throws on traversal
 * / absolute / wrong type. Extensions are case-insensitive on disk but
 * stored as given after slash-normalizing.
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeIconPath(value) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error("iconPath must be a relative project file");
  }
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) return null;
  if (trimmed.includes("\0")) {
    throw new Error("iconPath must be a relative project file");
  }
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    path.isAbsolute(trimmed) ||
    trimmed.startsWith("/")
  ) {
    throw new Error("iconPath must be a relative project file");
  }
  const norm = path.posix.normalize(trimmed);
  if (
    norm === ".." ||
    norm.startsWith("../") ||
    path.posix.isAbsolute(norm)
  ) {
    throw new Error("iconPath must be a relative project file");
  }
  const ext = path.posix.extname(norm).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(
      "Project icon must be svg, png, ico, jpeg, gif, avif, or webp",
    );
  }
  return norm;
}

/**
 * @param {string} root
 * @param {string} absPath
 * @returns {string | null}
 */
function relativeIconPath(root, absPath) {
  if (!root || !absPath) return null;
  const resolved = path.resolve(absPath);
  if (!isInsideRoot(root, resolved)) return null;
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join("/");
  try {
    return normalizeIconPath(posix);
  } catch {
    return null;
  }
}

function isLocalHref(href) {
  if (!href) return false;
  const t = String(href).trim();
  if (!t || t.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  return true;
}

function extractIconHref(source) {
  const htmlMatch = String(source).match(LINK_ICON_HTML_RE);
  if (htmlMatch && htmlMatch[1] && isLocalHref(htmlMatch[1])) {
    return htmlMatch[1];
  }
  for (const run of String(source).split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch && hrefMatch[1] && isLocalHref(hrefMatch[1])) {
      return hrefMatch[1];
    }
  }
  return null;
}

function resolveRelativeWithinRoot(root, relativePath) {
  if (!relativePath || typeof relativePath !== "string") return null;
  const trimmed = relativePath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const noQuery = trimmed.split("?")[0].split("#")[0];
  const clean = noQuery.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!clean) return null;
  let norm;
  try {
    norm = path.posix.normalize(clean);
  } catch {
    return null;
  }
  if (norm === ".." || norm.startsWith("../") || path.posix.isAbsolute(norm)) {
    return null;
  }
  const abs = path.resolve(root, ...norm.split("/"));
  if (!isInsideRoot(root, abs)) return null;
  return abs;
}

function existingFile(root, relativePath) {
  const abs = resolveRelativeWithinRoot(root, relativePath);
  if (!abs) return null;
  try {
    if (fs.statSync(abs).isFile()) return abs;
  } catch {
    // missing
  }
  return null;
}

function readJsonIconPath(root, filename) {
  const abs = existingFile(root, filename);
  if (!abs) return null;
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data.iconPath === "string") return data.iconPath;
  } catch {
    // invalid JSON — fall through
  }
  return null;
}

function fileToDataUrl(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (!buf || buf.length === 0 || buf.length > MAX_ICON_BYTES) return null;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function scanRoots(root) {
  const given = path.resolve(root);
  const main = mainWorkTree(given);
  if (main === given) return [given];
  return [main, given];
}

function resolveInRoot(root, override) {
  if (override) {
    const found = existingFile(root, override);
    if (found) return found;
  }

  const solenta = readJsonIconPath(root, "solenta.json");
  if (solenta) {
    const found = existingFile(root, solenta);
    if (found) return found;
  }
  const t3 = readJsonIconPath(root, "t3.json");
  if (t3) {
    const found = existingFile(root, t3);
    if (found) return found;
  }

  for (const candidate of FAVICON_CANDIDATES) {
    const found = existingFile(root, candidate);
    if (found) return found;
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const abs = existingFile(root, sourceFile);
    if (!abs) continue;
    let source;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_SOURCE_BYTES) continue;
      source = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href) continue;
    const clean = href.replace(/^\/+/, "");
    const found =
      existingFile(root, path.posix.join("public", clean)) ||
      existingFile(root, clean);
    if (found) return found;
  }
  return null;
}

function resolveIconPath(root, iconPath) {
  if (!root || typeof root !== "string") return null;
  let exists = false;
  try {
    exists = fs.statSync(root).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return null;

  const override =
    typeof iconPath === "string" && iconPath.trim() ? iconPath.trim() : "";
  for (const scan of scanRoots(root)) {
    const found = resolveInRoot(scan, override);
    if (found) return found;
  }
  return null;
}

function cacheKey(root, iconPath) {
  const override =
    typeof iconPath === "string" && iconPath.trim() ? iconPath.trim() : "";
  return `${gitCommonDir(root)}\0${override}`;
}

function overrideFile(root, iconPath) {
  if (!iconPath) return null;
  for (const scan of scanRoots(root)) {
    const found = existingFile(scan, iconPath);
    if (found) return found;
  }
  return null;
}

function iconDataUrlFor(root, iconPath) {
  if (!root || typeof root !== "string") return null;
  let exists = false;
  try {
    exists = fs.statSync(root).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return null;

  const override =
    typeof iconPath === "string" && iconPath.trim() ? iconPath.trim() : "";
  const key = cacheKey(root, iconPath);
  const hit = iconCache.get(key);
  if (hit) {
    const overrideNow = override ? overrideFile(root, override) : null;
    const overrideAppeared = Boolean(override && !hit.usedOverride && overrideNow);
    if (!overrideAppeared) {
      if (hit.filePath) {
        try {
          const st = fs.statSync(hit.filePath);
          if (st.isFile() && st.mtimeMs === hit.mtimeMs) return hit.url;
        } catch {
          // file gone — fall through and re-resolve
        }
      } else {
        return hit.url;
      }
    }
  }

  const abs = resolveIconPath(root, iconPath);
  const usedOverride = Boolean(override && abs && overrideFile(root, override) === abs);
  if (!abs) {
    iconCache.set(key, {
      url: null,
      filePath: null,
      mtimeMs: 0,
      usedOverride: false,
    });
    return null;
  }
  const url = fileToDataUrl(abs);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(abs).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  iconCache.set(key, { url, filePath: abs, mtimeMs, usedOverride });
  return url;
}

/**
 * Clone a stored project with derived iconUrl + scm. Never mutates the
 * store row and never writes those fields onto it.
 * @param {object} project
 */
function presentProject(project) {
  if (!project || typeof project !== "object") return project;
  const iconUrl = iconDataUrlFor(project.path, project.iconPath);
  /** @type {object} */
  let next = project;
  if (iconUrl) {
    next = { ...next, iconUrl };
  } else if (next.iconUrl) {
    next = { ...next };
    delete next.iconUrl;
  }
  return attachScm(next);
}

module.exports = {
  ICON_EXTENSIONS,
  ICON_FILTERS,
  MAX_ICON_BYTES,
  normalizeIconPath,
  relativeIconPath,
  resolveIconPath,
  iconDataUrlFor,
  fileToDataUrl,
  presentProject,
  clearIconCache,
  setGitCommonDirFn,
  gitCommonDir,
  mainWorkTree,
};
