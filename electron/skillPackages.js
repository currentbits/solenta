"use strict";

/**
 * Secure acquisition and discovery of Agent Skill packages from Markdown
 * files, ZIP archives, and public GitHub URLs. Preview/import never
 * executes imported files, install scripts, hooks, or manifests.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const { SKILL_NAME_RE, parseSkillMarkdown } = require("./skills.js");

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_CONTENTS_DEPTH = 8;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__MACOSX",
  ".openclaw",
  "benchmarks",
]);

const EXEC_EXTS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".exe",
  ".bin",
  ".command",
  ".msi",
  ".com",
  ".dll",
  ".so",
  ".dylib",
]);

const PARSE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
]);

const FETCH_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/**
 * @param {unknown} input
 * @returns {{
 *   owner: string,
 *   repo: string,
 *   ref: string | null,
 *   path: string,
 *   kind: "repo" | "tree" | "blob" | "raw" | "zip",
 * }}
 */
function parseGitHubSkillUrl(input, opts = {}) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("GitHub URL is required");
  }
  const raw = input.trim();
  if (/%2f/i.test(raw)) {
    throw new Error(
      "Ambiguous GitHub ref: encoded slashes cannot be resolved safely. Use a commit SHA, a slash-free branch name, or a codeload URL with refs/heads/<branch>.",
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid GitHub URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("GitHub URL must be HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("GitHub URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  if (!PARSE_HOSTS.has(host)) {
    throw new Error("Only public GitHub hosts are allowed");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "raw.githubusercontent.com") return parseRawUrl(parts, opts);
  if (host === "codeload.github.com") return parseCodeloadUrl(parts);
  return parseGithubComUrl(parts, opts);
}

/**
 * @param {string} rootDir
 * @returns {Promise<Array<{
 *   name: string,
 *   description: string,
 *   skillRoot: string,
 *   files: string[],
 *   skillMdBytes: number,
 *   totalBytes: number,
 *   warnings: string[],
 * }>>}
 */
async function discoverSkillPackages(rootDir) {
  const root = path.resolve(String(rootDir || ""));
  const search = unwrapGitHubArchive(root);
  const preferred = collectPreferred(search);
  const skillRoots = preferred.length ? preferred : collectFallback(search);
  if (!skillRoots.length) {
    throw new Error("No skill packages found");
  }
  const packages = skillRoots.map((skillRoot) =>
    describePackage(skillRoot, search),
  );
  const seen = new Set();
  for (const pkg of packages) {
    if (seen.has(pkg.name)) {
      throw new Error(`Duplicate skill name: ${pkg.name}`);
    }
    seen.add(pkg.name);
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return packages;
}

/**
 * @param {string} zipPath
 * @param {string} outputDir
 * @returns {Promise<{ outputDir: string, entryCount: number, expandedBytes: number }>}
 */
async function safeExtractZip(zipPath, outputDir) {
  const zip = path.resolve(String(zipPath));
  const out = path.resolve(String(outputDir));
  try {
    let st;
    try {
      st = fs.statSync(zip);
    } catch {
      throw new Error("ZIP archive is missing");
    }
    if (st.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`ZIP archive exceeds 25 MiB (${st.size} bytes)`);
    }
    fs.mkdirSync(out, { recursive: true });
    const stats = await extractZip(zip, out);
    return { outputDir: out, ...stats };
  } catch (err) {
    fs.rmSync(out, { recursive: true, force: true });
    throw err;
  }
}

/**
 * @param {string} markdownPath
 * @param {string} outputDir
 */
async function stageMarkdownSkill(markdownPath, outputDir) {
  const out = path.resolve(String(outputDir));
  try {
    const src = path.resolve(String(markdownPath));
    const bytes = fs.readFileSync(src);
    const parsed = parseSkillMarkdown(bytes.toString("utf8"));
    const description = (parsed.description || "").trim();
    if (!description) {
      throw new Error("Skill description is required");
    }
    const base = path.basename(src, path.extname(src));
    const name = validName(parsed.name) || validName(slugName(base));
    if (!name) {
      throw new Error(`Invalid skill name derived from ${path.basename(src)}`);
    }
    const skillRoot = path.join(out, name);
    if (path.relative(out, skillRoot) !== name) {
      throw new Error("Skill path escapes the staging directory");
    }
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, "SKILL.md"), bytes);
    const packages = await discoverSkillPackages(out);
    return packages[0];
  } catch (err) {
    fs.rmSync(out, { recursive: true, force: true });
    throw err;
  }
}

/**
 * @param {unknown} input
 * @param {string} outputDir
 * @param {{ fetchImpl?: Function, githubToken?: string }} [opts]
 */
async function stageGitHubTree(input, outputDir, opts = {}) {
  const out = path.resolve(String(outputDir));
  try {
    if (!opts || typeof opts.fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }
    const source = parseGitHubSkillUrl(input);
    const token = String(
      opts.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    );
    if (source.kind === "blob" || source.kind === "raw") {
      await stageBlobSkill(source, out, opts.fetchImpl, token);
    } else {
      await stageRepoZip(source, out, opts.fetchImpl, token);
    }
    const searchRoot =
      source.path && source.kind === "tree"
        ? resolveSubtree(out, source.path)
        : out;
    return { source, root: searchRoot };
  } catch (err) {
    fs.rmSync(out, { recursive: true, force: true });
    throw err;
  }
}

async function stageGitHubSkill(input, outputDir, opts = {}) {
  const staged = await stageGitHubTree(input, outputDir, opts);
  try {
    const packages = await discoverSkillPackages(staged.root);
    return { packages, source: staged.source };
  } catch (err) {
    fs.rmSync(path.resolve(String(outputDir)), { recursive: true, force: true });
    throw err;
  }
}

function parseOwnerRepo(parts) {
  if (parts.length < 2) {
    throw new Error("GitHub URL must be owner/repo");
  }
  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (
    !OWNER_RE.test(owner) ||
    !REPO_RE.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new Error("Invalid GitHub owner or repository");
  }
  return { owner, repo, rest: parts.slice(2) };
}

function blobPathOk(filePath, opts, raw) {
  const allow = opts && typeof opts.blobOk === "function" ? opts.blobOk : null;
  if (allow) {
    if (!allow(filePath)) {
      throw new Error(
        opts.blobError ||
          (raw
            ? "Raw GitHub URL must point to an MCP JSON candidate"
            : "GitHub blob URL must point to an MCP JSON candidate"),
      );
    }
    return;
  }
  if (!filePath.endsWith("SKILL.md")) {
    throw new Error(
      raw ? "Raw GitHub URL must point to SKILL.md" : "GitHub blob URL must point to SKILL.md",
    );
  }
}

function parseGithubComUrl(parts, opts) {
  const { owner, repo, rest } = parseOwnerRepo(parts);
  if (rest.length === 0) {
    return { owner, repo, ref: null, path: "", kind: "repo" };
  }
  const [kind, ...tail] = rest;
  if (kind === "tree") {
    if (!tail.length || !tail[0]) {
      throw new Error("GitHub tree URL is missing a ref");
    }
    return {
      owner,
      repo,
      ref: tail[0],
      path: tail.slice(1).join("/"),
      kind: "tree",
    };
  }
  if (kind === "blob") {
    if (tail.length < 2 || !tail[0]) {
      throw new Error("GitHub blob URL is missing a ref");
    }
    const filePath = tail.slice(1).join("/");
    blobPathOk(filePath, opts, false);
    return { owner, repo, ref: tail[0], path: filePath, kind: "blob" };
  }
  if (kind === "archive") {
    return parseArchiveRef(owner, repo, tail);
  }
  throw new Error("Unsupported GitHub URL");
}

function parseArchiveRef(owner, repo, tail) {
  if (!tail.length) throw new Error("Unsupported GitHub URL");
  const last = tail[tail.length - 1];
  if (!last.endsWith(".zip")) {
    throw new Error("Only GitHub zip downloads are supported");
  }
  const segs = tail.slice(0, -1).concat([last.slice(0, -4)]);
  const ref = explicitGitRef(segs);
  if (!ref) throw new Error("GitHub archive URL is missing a ref");
  return { owner, repo, ref, path: "", kind: "zip" };
}

function parseCodeloadUrl(parts) {
  const { owner, repo, rest } = parseOwnerRepo(parts);
  if (!rest.length || (rest[0] !== "zip" && rest[0] !== "legacy.zip")) {
    throw new Error("Only GitHub zip downloads are supported");
  }
  const ref = explicitGitRef(rest.slice(1));
  if (!ref) throw new Error("GitHub zip URL is missing a ref");
  return { owner, repo, ref, path: "", kind: "zip" };
}

function parseRawUrl(parts, opts) {
  const { owner, repo, rest } = parseOwnerRepo(parts);
  if (rest.length < 2 || !rest[0]) {
    throw new Error("Raw GitHub URL must point to SKILL.md");
  }
  const filePath = rest.slice(1).join("/");
  blobPathOk(filePath, opts, true);
  return { owner, repo, ref: rest[0], path: filePath, kind: "raw" };
}

function explicitGitRef(segs) {
  if (!segs.length || segs.some((s) => !s)) return "";
  if (
    segs[0] === "refs" &&
    (segs[1] === "heads" || segs[1] === "tags") &&
    segs.length >= 3
  ) {
    return segs.slice(2).join("/");
  }
  return segs.join("/");
}

function isFile(p) {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function unwrapGitHubArchive(root) {
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return root;
  }
  const visible = ents.filter((e) => e.name !== ".DS_Store");
  const files = visible.filter((e) => e.isFile());
  const dirs = visible.filter(
    (e) =>
      e.isDirectory() &&
      !e.isSymbolicLink() &&
      !IGNORED_DIRS.has(e.name),
  );
  if (
    !isFile(path.join(root, "SKILL.md")) &&
    files.length === 0 &&
    dirs.length === 1
  ) {
    return path.join(root, dirs[0].name);
  }
  return root;
}

function collectPreferred(search) {
  /** @type {string[]} */
  const out = [];
  if (isFile(path.join(search, "SKILL.md"))) out.push(search);
  const skillsDir = path.join(search, "skills");
  if (!isDir(skillsDir)) return out;
  for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (ent.isSymbolicLink() || !ent.isDirectory()) continue;
    if (IGNORED_DIRS.has(ent.name)) continue;
    const skillRoot = path.join(skillsDir, ent.name);
    if (isFile(path.join(skillRoot, "SKILL.md"))) out.push(skillRoot);
  }
  return out;
}

function collectFallback(search) {
  /** @type {string[]} */
  const out = [];
  let ents;
  try {
    ents = fs.readdirSync(search, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of ents) {
    if (ent.isSymbolicLink() || !ent.isDirectory()) continue;
    if (IGNORED_DIRS.has(ent.name)) continue;
    const skillRoot = path.join(search, ent.name);
    if (isFile(path.join(skillRoot, "SKILL.md"))) out.push(skillRoot);
  }
  return out;
}

function validName(value) {
  const n = typeof value === "string" ? value.trim() : "";
  return SKILL_NAME_RE.test(n) ? n : null;
}

function slugName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function describePackage(skillRoot, searchRoot) {
  const resolved = path.resolve(skillRoot);
  const isSearchRoot = resolved === path.resolve(searchRoot);
  const dirName = path.basename(resolved);
  const mdPath = path.join(resolved, "SKILL.md");
  const bytes = fs.readFileSync(mdPath);
  const parsed = parseSkillMarkdown(bytes.toString("utf8"));
  const name = isSearchRoot
    ? validName(parsed.name) || validName(slugName(dirName))
    : validName(dirName);
  if (!name) {
    throw new Error(`Invalid skill name: ${dirName}`);
  }
  const files = listSkillFiles(resolved);
  /** @type {string[]} */
  const warnings = [];
  let totalBytes = 0;
  let skillMdBytes = 0;
  for (const rel of files) {
    const full = path.join(resolved, ...rel.split("/"));
    const st = fs.lstatSync(full);
    totalBytes += st.size;
    if (rel === "SKILL.md") skillMdBytes = st.size;
    if (looksExecutable(rel, st)) {
      warnings.push(`executable-looking file: ${rel}`);
    }
  }
  return {
    name,
    description: parsed.description,
    skillRoot: resolved,
    files,
    skillMdBytes,
    totalBytes,
    warnings,
  };
}

function listSkillFiles(skillRoot) {
  /** @type {string[]} */
  const files = [];
  function walk(dir, rel) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.isSymbolicLink() || ent.name.includes("\0")) continue;
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name), nextRel);
      } else if (ent.isFile()) {
        files.push(nextRel);
      }
    }
  }
  walk(skillRoot, "");
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return files;
}

function looksExecutable(rel, st) {
  const ext = path.posix.extname(rel).toLowerCase();
  if (EXEC_EXTS.has(ext)) return true;
  if (st && st.isFile() && (st.mode & 0o111) !== 0) return true;
  return false;
}

function assertSafeZipName(name) {
  if (typeof name !== "string" || name.includes("\0")) {
    throw new Error("ZIP entry name contains a NUL byte");
  }
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(
      /^[a-zA-Z]:/.test(normalized)
        ? `ZIP entry is a drive path: ${name}`
        : `ZIP entry is an absolute path: ${name}`,
    );
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(
      `ZIP entry escapes the destination via parent traversal: ${name}`,
    );
  }
}

function safeJoin(root, relPath) {
  assertSafeZipName(relPath);
  const normalized = relPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  const dest = path.join(root, ...parts);
  const rel = path.relative(root, dest);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `ZIP entry escapes the destination via parent traversal: ${relPath}`,
    );
  }
  return dest;
}

function zipEntryKind(entry) {
  if (typeof entry.isEncrypted === "function" && entry.isEncrypted()) {
    return "encrypted";
  }
  const madeBy = (entry.versionMadeBy >> 8) & 0xff;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (madeBy === 3 && unixMode) {
    const type = unixMode & S_IFMT;
    if (type === S_IFLNK) return "symlink";
    if (type && type !== S_IFREG && type !== S_IFDIR) return "special";
  }
  return null;
}

function decodeEntryName(entry) {
  const raw = Buffer.isBuffer(entry.fileName)
    ? entry.fileName
    : Buffer.from(String(entry.fileName));
  if (raw.includes(0)) {
    throw new Error("ZIP entry name contains a NUL byte");
  }
  return raw.toString("utf8");
}

async function extractZip(zipPath, outputDir) {
  const zipfile = await yauzl.openPromise(zipPath, {
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false,
    autoClose: false,
  });
  /** @type {Array<{ entry: object, name: string }>} */
  const pending = [];
  let expandedBytes = 0;
  try {
    if (zipfile.entryCount > MAX_ZIP_ENTRIES) {
      throw new Error(
        `ZIP has ${zipfile.entryCount} entries; limit is ${MAX_ZIP_ENTRIES}`,
      );
    }
    for await (const entry of zipfile.eachEntry()) {
      const name = decodeEntryName(entry);
      assertSafeZipName(name);
      const kind = zipEntryKind(entry);
      if (kind === "symlink") {
        throw new Error(`ZIP entry is a symlink: ${name}`);
      }
      if (kind === "special" || kind === "encrypted") {
        throw new Error(`ZIP entry is a special file: ${name}`);
      }
      const uncompressed = Number(entry.uncompressedSize) || 0;
      if (uncompressed > MAX_FILE_BYTES) {
        throw new Error(`ZIP file exceeds 10 MiB: ${name}`);
      }
      expandedBytes += uncompressed;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("ZIP expanded size exceeds 100 MiB");
      }
      pending.push({ entry, name });
    }
    for (const { entry, name } of pending) {
      if (name.endsWith("/")) {
        fs.mkdirSync(safeJoin(outputDir, name), { recursive: true });
        continue;
      }
      const dest = safeJoin(outputDir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const readStream = await zipfile.openReadStreamPromise(entry);
      const writeStream = fs.createWriteStream(dest, {
        mode: 0o644,
        flags: "wx",
      });
      let written = 0;
      readStream.on("data", (chunk) => {
        written += chunk.length;
        if (written > MAX_FILE_BYTES) {
          readStream.destroy(new Error(`ZIP file exceeds 10 MiB: ${name}`));
        }
      });
      await pipeline(readStream, writeStream);
    }
  } finally {
    try {
      zipfile.close();
    } catch {
      // already closed
    }
  }
  return { entryCount: pending.length, expandedBytes };
}

function resolveSubtree(root, relPath) {
  const search = unwrapGitHubArchive(root);
  const dest = safeJoin(search, relPath);
  if (!fs.existsSync(dest)) {
    throw new Error(`Requested path not found in repository: ${relPath}`);
  }
  return dest;
}

function assertAllowedDownloadUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error("Invalid download URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Download URL must be HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Download URL must not include credentials");
  }
  if (!FETCH_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(
      `Refusing redirect or download from non-GitHub host: ${url.hostname}`,
    );
  }
  return url;
}

function downloadLimitMessage(maxBytes, actual) {
  if (maxBytes === MAX_ARCHIVE_BYTES) {
    return `Download exceeds 25 MiB archive limit (${actual} bytes)`;
  }
  if (maxBytes === MAX_FILE_BYTES) {
    return `Download exceeds 10 MiB file limit (${actual} bytes)`;
  }
  if (maxBytes === MAX_EXPANDED_BYTES) {
    return `Download exceeds 100 MiB content limit (${actual} bytes)`;
  }
  return `Download exceeds ${maxBytes} byte limit (${actual} bytes)`;
}

function cancelResponseBody(res) {
  const body = res && res.body;
  if (!body) return;
  if (typeof body.cancel === "function") {
    Promise.resolve(body.cancel()).catch(() => {});
  }
  if (typeof body.destroy === "function") {
    try {
      body.destroy();
    } catch {
      // already closed
    }
  }
}

async function* readableStreamAsync(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // lock already released
    }
  }
}

function responseBody(res) {
  const body = res && res.body;
  if (!body) return null;
  if (typeof body.getReader === "function") return readableStreamAsync(body);
  if (typeof body[Symbol.asyncIterator] === "function") return body;
  return null;
}

async function readBoundedBody(res, maxBytes) {
  const lenRaw =
    res.headers && typeof res.headers.get === "function"
      ? res.headers.get("content-length")
      : null;
  const len = Number(lenRaw);
  if (Number.isFinite(len) && len > maxBytes) {
    cancelResponseBody(res);
    throw new Error(downloadLimitMessage(maxBytes, len));
  }
  const source = responseBody(res);
  if (!source) {
    throw new Error("Download response has no body");
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk == null ? "" : chunk);
      if (total + buf.length > maxBytes) {
        cancelResponseBody(res);
        throw new Error(downloadLimitMessage(maxBytes, total + buf.length));
      }
      total += buf.length;
      chunks.push(buf);
    }
  } catch (err) {
    cancelResponseBody(res);
    throw err;
  }
  return Buffer.concat(chunks, total);
}

function withFetchTimeout(timeoutMs) {
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    return { signal: AbortSignal.timeout(timeoutMs), cleanup() {} };
  }
  if (typeof AbortController === "undefined") {
    return { signal: undefined, cleanup() {} };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return {
    signal: ac.signal,
    cleanup() {
      clearTimeout(timer);
    },
  };
}

function chargeContentsEntries(budget, n = 1) {
  budget.entries += n;
  if (budget.entries > MAX_ZIP_ENTRIES) {
    throw new Error(
      `GitHub Contents listing exceeds ${MAX_ZIP_ENTRIES} entries`,
    );
  }
}

function chargeContentsBytes(budget, n) {
  budget.bytes += n;
  if (budget.bytes > MAX_EXPANDED_BYTES) {
    throw new Error("GitHub Contents download exceeds 100 MiB");
  }
}

async function downloadGitHub(urlString, fetchImpl, opts) {
  const maxBytes = opts.maxBytes;
  const token = opts.token || "";
  let current = urlString;
  let hops = 0;
  while (true) {
    const url = assertAllowedDownloadUrl(current);
    /** @type {Record<string, string>} */
    const headers = {
      "User-Agent": "solenta-skill-import",
      Accept: opts.accept || "application/octet-stream",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const timed = withFetchTimeout(opts.timeoutMs || FETCH_TIMEOUT_MS);
    /** @type {Record<string, unknown>} */
    const init = { redirect: "manual", headers };
    if (timed.signal) init.signal = timed.signal;
    let res;
    try {
      res = await fetchImpl(url.href, init);
    } finally {
      timed.cleanup();
    }
    const status = res && typeof res.status === "number" ? res.status : 0;
    if (status >= 300 && status < 400) {
      hops += 1;
      if (hops > MAX_REDIRECTS) {
        throw new Error("Too many redirects");
      }
      const loc =
        res.headers && typeof res.headers.get === "function"
          ? res.headers.get("location")
          : null;
      if (!loc) throw new Error("Redirect missing Location header");
      let next;
      try {
        next = new URL(String(loc), url).href;
      } catch {
        throw new Error("Invalid redirect Location");
      }
      try {
        assertAllowedDownloadUrl(next);
      } catch {
        throw new Error(`Refusing redirect to non-GitHub host: ${next}`);
      }
      current = next;
      continue;
    }
    const ok =
      res && typeof res.ok === "boolean"
        ? res.ok
        : status >= 200 && status < 300;
    if (!ok) {
      if (status === 403 || status === 429) {
        throw new Error(
          `GitHub returned HTTP ${status} (rate limited or forbidden). Provide a token or retry later.`,
        );
      }
      throw new Error(`GitHub download failed: HTTP ${status || "error"}`);
    }
    return readBoundedBody(res, maxBytes);
  }
}

async function stageRepoZip(source, out, fetchImpl, token) {
  const ref = source.ref || "HEAD";
  const zipUrl = `https://codeload.github.com/${source.owner}/${source.repo}/zip/${ref}`;
  const buf = await downloadGitHub(zipUrl, fetchImpl, {
    token,
    maxBytes: MAX_ARCHIVE_BYTES,
    accept: "application/octet-stream",
  });
  const tmpZip = path.join(
    os.tmpdir(),
    `solenta-skill-${crypto.randomBytes(8).toString("hex")}.zip`,
  );
  try {
    fs.writeFileSync(tmpZip, buf);
    await safeExtractZip(tmpZip, out);
  } finally {
    fs.rmSync(tmpZip, { force: true });
  }
}

async function listContentsRecursive(apiUrl, fetchImpl, token, depth, budget) {
  if (depth > MAX_CONTENTS_DEPTH) {
    throw new Error("Companion directory tree is too deep");
  }
  const buf = await downloadGitHub(apiUrl, fetchImpl, {
    token,
    maxBytes: MAX_ARCHIVE_BYTES,
    accept: "application/vnd.github+json",
  });
  chargeContentsBytes(budget, buf.length);
  let listing;
  try {
    listing = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("GitHub Contents API returned invalid JSON");
  }
  if (!Array.isArray(listing)) {
    throw new Error(
      "GitHub Contents API did not return a directory listing; cannot import a single SKILL.md without companions",
    );
  }
  /** @type {Array<{ path: string, download_url: string, size: number }>} */
  const files = [];
  for (const item of listing) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "");
    const type = String(item.type || "");
    if (type === "dir" && IGNORED_DIRS.has(name)) continue;
    chargeContentsEntries(budget);
    if (type === "symlink" || type === "submodule") {
      throw new Error(
        `GitHub Contents item is a ${type}: ${item.path || name}`,
      );
    }
    if (type && type !== "file" && type !== "dir") {
      throw new Error(
        `GitHub Contents item is a special type (${type}): ${item.path || name}`,
      );
    }
    if (type === "file") {
      const size = Number(item.size) || 0;
      if (size > MAX_FILE_BYTES) {
        throw new Error(`GitHub Contents file exceeds 10 MiB: ${item.path || name}`);
      }
      chargeContentsBytes(budget, size);
      if (!item.download_url) {
        throw new Error("Companion file is missing a download URL");
      }
      assertAllowedDownloadUrl(String(item.download_url));
      files.push({
        path: String(item.path || ""),
        download_url: String(item.download_url),
        size,
      });
    } else if (type === "dir" && item.url) {
      assertAllowedDownloadUrl(String(item.url));
      const nested = await listContentsRecursive(
        String(item.url),
        fetchImpl,
        token,
        depth + 1,
        budget,
      );
      files.push(...nested);
    }
  }
  return files;
}

async function stageBlobSkill(source, out, fetchImpl, token) {
  const dirPath = source.path
    .replace(/(?:^|\/)SKILL\.md$/i, "")
    .replace(/\/+$/, "");
  const contentsPath = dirPath ? `/contents/${dirPath}` : "/contents";
  const apiUrl =
    `https://api.github.com/repos/${source.owner}/${source.repo}` +
    `${contentsPath}?ref=${encodeURIComponent(source.ref || "")}`;
  const budget = { entries: 0, bytes: 0 };
  const files = await listContentsRecursive(
    apiUrl,
    fetchImpl,
    token,
    0,
    budget,
  );
  if (!files.some((f) => /(^|\/)SKILL\.md$/.test(f.path))) {
    throw new Error("Directory listing did not include SKILL.md");
  }
  const skillName =
    validName(path.posix.basename(dirPath)) ||
    validName(slugName(dirPath)) ||
    validName(source.repo) ||
    validName(slugName(source.repo));
  if (!skillName) {
    throw new Error(`Invalid skill name: ${dirPath || source.repo}`);
  }
  const skillRoot = path.join(out, skillName);
  fs.mkdirSync(skillRoot, { recursive: true });
  for (const file of files) {
    const rel = dirPath
      ? path.posix.relative(dirPath, file.path)
      : String(file.path || "").replace(/^\/+/, "");
    if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) {
      throw new Error("Companion file escapes the skill directory");
    }
    const dest = safeJoin(skillRoot, rel);
    const body = await downloadGitHub(file.download_url, fetchImpl, {
      token,
      maxBytes: MAX_FILE_BYTES,
      accept: "application/vnd.github.raw",
    });
    if (body.length > (file.size || 0)) {
      chargeContentsBytes(budget, body.length - (file.size || 0));
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, { mode: 0o644 });
  }
}

module.exports = {
  parseGitHubSkillUrl,
  downloadGitHub,
  stageRepoZip,
  unwrapGitHubArchive,
  resolveSubtree,
  discoverSkillPackages,
  safeExtractZip,
  stageMarkdownSkill,
  stageGitHubSkill,
  stageGitHubTree,
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_FILE_BYTES,
};
