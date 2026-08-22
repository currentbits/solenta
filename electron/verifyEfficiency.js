"use strict";

/**
 * Verification efficiency (issue #390).
 *
 * 1. Shared local build cache: point every worktree of a repo at the same
 *    turbo/nx/cargo/sccache directory so thread B reuses thread A's results.
 * 2. Affected-scope: rewrite well-known verify commands to the tests the
 *    diff touches. Unknown runners, wide files, and git trouble stay full.
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** cwd → main-checkout path, so worktrees of one clone share a cache. */
const gitRootCache = new Map();

const CACHE_HOME =
  process.env.SOLENTA_BUILD_CACHE ||
  path.join(os.homedir(), ".solenta", "build-cache");

/**
 * Stable per-checkout key so two clones named "app" do not collide, and
 * every worktree of one clone shares a cache.
 * @param {string} repoRoot
 */
function realPath(p) {
  const abs = path.resolve(String(p || ".") || ".");
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function repoCacheKey(repoRoot) {
  const abs = realPath(repoRoot);
  const name = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
  const hash = crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

/**
 * Main checkout for `cwd`. Worktrees resolve through git-common-dir so
 * every thread of a project lands on the same cache key. Misses (not a
 * repo, git missing) fall back to cwd.
 * @param {string} cwd
 * @returns {string}
 */
function gitMainRoot(cwd) {
  if (!cwd) return cwd;
  const hit = gitRootCache.get(cwd);
  if (hit) return hit;
  let root = cwd;
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (common) root = path.dirname(path.resolve(cwd, common));
    root = realPath(root);
  } catch {
    root = realPath(cwd);
  }
  gitRootCache.set(cwd, root);
  return root;
}

function cacheHomeFor(repoRoot, cacheRoot, cwd) {
  if (cacheRoot) return cacheRoot;
  const root = repoRoot || gitMainRoot(cwd) || cwd || ".";
  return path.join(CACHE_HOME, repoCacheKey(root));
}

function makeExists(cwd, exists) {
  if (typeof exists === "function") return exists;
  return (rel) => {
    try {
      return fs.existsSync(path.join(cwd || "", rel));
    } catch {
      return false;
    }
  };
}

function markerExists(exists, names) {
  for (const n of names) {
    if (exists(n)) return true;
  }
  return false;
}

/**
 * Env vars that point turbo/nx/cargo/sccache at a shared cache. Empty
 * object when the repo has none of those tools, or every relevant var is
 * already set. Never overrides an existing value.
 *
 * @param {object} input
 * @param {string} [input.cwd]
 * @param {string} [input.repoRoot]
 * @param {string} [input.cacheRoot]
 * @param {(rel: string) => boolean} [input.exists]
 * @param {NodeJS.ProcessEnv | Record<string, string>} [input.env]
 * @returns {Record<string, string>}
 */
function cacheEnv(input) {
  const cwd = (input && input.cwd) || "";
  const exists = makeExists(cwd, input && input.exists);
  const have = (input && input.env) || {};
  const root = cacheHomeFor(
    input && input.repoRoot,
    input && input.cacheRoot,
    cwd,
  );
  const out = {};
  const take = (key, value) => {
    if (have[key] == null || have[key] === "") out[key] = value;
  };

  if (markerExists(exists, ["turbo.json"])) {
    take("TURBO_CACHE_DIR", path.join(root, "turbo"));
  }
  if (markerExists(exists, ["nx.json", "workspace.json"])) {
    take("NX_CACHE_DIRECTORY", path.join(root, "nx"));
    take("NX_DAEMON", "false");
  }
  if (markerExists(exists, ["Cargo.toml"])) {
    take("CARGO_TARGET_DIR", path.join(root, "cargo-target"));
    take("SCCACHE_DIR", path.join(root, "sccache"));
  }
  if (markerExists(exists, ["CMakeLists.txt", ".ccache"])) {
    take("CCACHE_DIR", path.join(root, "ccache"));
  }
  return out;
}

function mergeCacheEnv(cwd, env, extra) {
  const extraEnv = cacheEnv({
    cwd,
    repoRoot: extra && extra.repoRoot,
    cacheRoot: extra && extra.cacheRoot,
    env: env || process.env,
    exists: extra && extra.exists,
  });
  if (!Object.keys(extraEnv).length) return env || process.env;
  return { ...(env || process.env), ...extraEnv };
}

/** Config / lock / CI files force the full suite. */
const WIDE_BASE =
  /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|turbo\.json|nx\.json|project\.json|tsconfig(\..+)?\.json|jsconfig\.json|vitest\.config\..+|jest\.config\..+|playwright\.config\..+|go\.(mod|sum)|Cargo\.(toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Dockerfile.*|CMakeLists\.txt)$/i;

const DOCS_RE = /\.(md|mdx|rst)$/i;
const TEST_FILE_RE = /\.(tests?|spec)\.[cm]?[jt]sx?$/i;
const JS_EXT_RE = /\.[cm]?[jt]sx?$/i;

function posixRel(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function baseName(p) {
  const n = posixRel(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? n : n.slice(i + 1);
}

function isWidePath(p) {
  const n = posixRel(p);
  if (!n) return false;
  if (WIDE_BASE.test(baseName(n))) return true;
  const lower = n.toLowerCase();
  if (
    lower.startsWith(".github/workflows/") ||
    lower.includes("/.github/workflows/")
  ) {
    return true;
  }
  if (lower.startsWith(".circleci/") || lower.includes("/.circleci/")) {
    return true;
  }
  return false;
}

function isDocsPath(p) {
  const n = posixRel(p);
  if (!n) return false;
  if (DOCS_RE.test(n)) return true;
  if (/^(README|LICENSE|CHANGELOG|AUTHORS|CONTRIBUTING)(\.|$)/i.test(baseName(n))) {
    return true;
  }
  return n.startsWith("docs/");
}

function isTestFile(p) {
  const n = posixRel(p);
  if (TEST_FILE_RE.test(n)) return true;
  return /\/test\//.test(n) && JS_EXT_RE.test(n);
}

/** Candidate test paths for a changed source file. */
function candidateTests(src) {
  const n = posixRel(src);
  if (!n || isDocsPath(n)) return [];
  if (isTestFile(n)) return [n];
  if (!JS_EXT_RE.test(n)) return [];
  const extMatch = n.match(/\.[^.]+$/);
  const ext = extMatch ? extMatch[0] : "";
  const noExt = ext ? n.slice(0, -ext.length) : n;
  const slash = noExt.lastIndexOf("/");
  const dir = slash < 0 ? "" : noExt.slice(0, slash + 1);
  const base = slash < 0 ? noExt : noExt.slice(slash + 1);
  const out = [];
  const tests = [
    ".test.js",
    ".test.ts",
    ".test.tsx",
    ".test.mjs",
    ".test.cjs",
    ".spec.js",
    ".spec.ts",
    ".spec.tsx",
  ];
  for (const t of tests) {
    out.push(noExt + t);
    out.push(`${dir}test/${base}${t}`);
  }
  if (n.startsWith("src/")) {
    const rest = noExt.slice("src/".length);
    for (const t of [".test.ts", ".test.tsx", ".test.js"]) {
      out.push(`test/${rest}${t}`);
    }
  }
  if (n.startsWith("electron/") && !n.startsWith("electron/test/")) {
    out.push(`electron/test/${base}.test.js`);
    const kebab = base.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    if (kebab !== base) out.push(`electron/test/${kebab}.test.js`);
  }
  return out;
}

function relatedTestFiles(changedPaths, exists) {
  const out = [];
  const seen = new Set();
  for (const raw of changedPaths || []) {
    const n = posixRel(raw);
    if (!n) continue;
    for (const cand of candidateTests(n)) {
      if (seen.has(cand)) continue;
      if (!exists(cand)) continue;
      seen.add(cand);
      out.push(cand);
    }
  }
  return out;
}

function alreadyScoped(command) {
  const c = String(command || "");
  if (/\s--filter(=|\s)/.test(c)) return true;
  if (/\s--affected\b/.test(c) || /(^|\s)affected(\s|$)/.test(c)) return true;
  if (/\s--findRelatedTests\b/.test(c)) return true;
  if (/\s--testPathPattern\b/.test(c)) return true;
  if (/\s--all\b/.test(c)) return true;
  if (/\bvitest\b/.test(c) && /\srelated\b/.test(c)) return true;
  return false;
}

function unwrapNpmScript(command, readFile) {
  const m = String(command || "")
    .trim()
    .match(/^(npm|pnpm|yarn|bun)(?:\s+run)?\s+(\S+)$/);
  if (!m) return command;
  if (typeof readFile !== "function") return command;
  let raw;
  try {
    raw = readFile("package.json");
  } catch {
    return command;
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return command;
  }
  const script = pkg && pkg.scripts && pkg.scripts[m[2]];
  if (typeof script !== "string" || !script.trim()) return command;
  // Compound scripts are not a single runner; leave the npm alias alone.
  if (/[;&|]/.test(script)) return command;
  return script.trim();
}

function makeReadFile(cwd, readFile) {
  if (typeof readFile === "function") return readFile;
  return (rel) => fs.readFileSync(path.join(cwd || "", rel), "utf8");
}

function joinFiles(files) {
  return files.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" ");
}

function scopeNodeTest(command, files) {
  if (!/\bnode\b/.test(command) || !/(^|\s)--test(\s|$)/.test(command)) {
    return null;
  }
  if (!files.length) return null;
  const parts = command.trim().split(/\s+/);
  const testIdx = parts.indexOf("--test");
  if (testIdx < 0) return null;
  const kept = parts.slice(0, testIdx + 1);
  for (let i = testIdx + 1; i < parts.length; i++) {
    if (parts[i].startsWith("-")) kept.push(parts[i]);
  }
  return `${kept.join(" ")} ${joinFiles(files)}`;
}

/** Rewrite a verify command to the tests the diff touches. */
function scopeVerifyCommand(input) {
  const original = String((input && input.command) || "");
  const unchanged = { command: original, scoped: false, reason: null };
  const changed = input && input.changedPaths;
  if (!original || !Array.isArray(changed)) return unchanged;
  if (changed.length === 0) return unchanged;
  if (changed.some(isWidePath)) return unchanged;
  if (changed.every(isDocsPath)) {
    return {
      command: "exit 0",
      scoped: true,
      reason: "no testable changes",
    };
  }
  if (alreadyScoped(original)) return unchanged;
  if (changed.length > 40) return unchanged;

  const exists = makeExists(input.cwd, input.exists);
  const readFile = makeReadFile(input.cwd, input.readFile);
  const command = unwrapNpmScript(original, readFile);
  if (alreadyScoped(command)) {
    return command === original
      ? unchanged
      : { command, scoped: true, reason: "unwrapped script" };
  }

  const related = relatedTestFiles(changed, exists);
  const next = scopeNodeTest(command, related);

  if (!next || next === original) return unchanged;
  return { command: next, scoped: true, reason: "affected scope" };
}

/** Paths vs the project default branch. null means unknown (do not scope). */
function changedPathsForVerify(cwd, project) {
  if (!cwd || (project && project.remoteHost)) {
    return { paths: null, base: null };
  }
  try {
    const wt = require("./worktrees.js");
    const root = (project && project.path) || cwd;
    const base = wt.defaultBranch(root);
    const listed = wt.listChangedPaths(cwd, {
      base,
      includeWorkingTree: true,
    });
    if (!listed || !listed.ok) return { paths: null, base };
    return { paths: listed.paths, base };
  } catch {
    return { paths: null, base: null };
  }
}

/** Cache env + optional affected-scope rewrite. */
function prepareVerifyRun(input) {
  const command = (input && input.command) || "";
  const cwd = (input && input.cwd) || "";
  const env = mergeCacheEnv(cwd, input && input.env, {
    repoRoot: input && (input.repoRoot || (input.project && input.project.path)),
    cacheRoot: input && input.cacheRoot,
    exists: input && input.exists,
  });
  let changedPaths = input && input.changedPaths;
  let base = input && input.base;
  if (changedPaths === undefined) {
    const listed = changedPathsForVerify(cwd, input && input.project);
    changedPaths = listed.paths;
    base = listed.base;
  }
  const scoped = scopeVerifyCommand({
    command,
    cwd,
    changedPaths,
    base,
    exists: input && input.exists,
    readFile: input && input.readFile,
  });
  return {
    command: scoped.command,
    env,
    scoped: scoped.scoped,
    reason: scoped.reason,
  };
}

module.exports = {
  CACHE_HOME,
  repoCacheKey,
  cacheEnv,
  mergeCacheEnv,
  isWidePath,
  isDocsPath,
  candidateTests,
  relatedTestFiles,
  scopeVerifyCommand,
  changedPathsForVerify,
  prepareVerifyRun,
};
