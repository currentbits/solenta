"use strict";

/**
 * Shared local build cache across worktrees (issue #390).
 *
 * Point every worktree of a repo at the same turbo/nx/cargo/sccache
 * directory so thread B reuses thread A's task results.
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

module.exports = {
  CACHE_HOME,
  repoCacheKey,
  cacheEnv,
  mergeCacheEnv,
};
