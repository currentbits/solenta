"use strict";

// Git status, sync, fetch and pull helpers.

const path = require("node:path");
const { execCommandAsync } = require("./ssh.js");
const { gitEnv } = require("./worktrees-git.js");

/** Network git (fetch/pull) is legitimately slower than execCommand's local default. */
const GIT_NETWORK_TIMEOUT_MS = 60_000;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ remoteHost?: string, remotePath?: string, path?: string } | null} [project]
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
async function gitOutAsync(cwd, args, project, opts) {
  return String(
    await execCommandAsync(project && project.remoteHost ? project : null, "git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(args),
      ...(opts || {}),
    }),
  ).trim();
}

/**
 * @param {string | { path?: string, remoteHost?: string, remotePath?: string }} projectOrPath
 * @returns {{ isRepo: boolean, branch: string, dirty: boolean }}
 */
async function gitStatus(projectOrPath) {
  const project =
    projectOrPath && typeof projectOrPath === "object"
      ? projectOrPath
      : { path: projectOrPath };
  const resolved = project.remoteHost
    ? project.remotePath || project.path || ""
    : path.resolve(project.path || "");
  try {
    const inside = await gitOutAsync(
      resolved,
      ["rev-parse", "--is-inside-work-tree"],
      project,
    );
    if (inside !== "true") {
      return { isRepo: false, branch: "", dirty: false };
    }
  } catch {
    return { isRepo: false, branch: "", dirty: false };
  }

  let branch = "";
  try {
    branch = await gitOutAsync(resolved, ["branch", "--show-current"], project);
  } catch {
    branch = "";
  }

  let dirty = false;
  try {
    const porcelain = await gitOutAsync(resolved, ["status", "--porcelain"], project);
    dirty = porcelain.length > 0;
  } catch {
    dirty = false;
  }

  return { isRepo: true, branch, dirty };
}

/**
 * Parse `git rev-list --left-right --count @{upstream}...HEAD` stdout.
 * Format: "<behind>\\t<ahead>" (left = upstream-only, right = HEAD-only).
 *
 * @param {string} text
 * @returns {{ hasUpstream: false } | { hasUpstream: true, ahead: number, behind: number }}
 */
function parseRevListCount(text) {
  const line = String(text || "").trim().split(/\r?\n/)[0] || "";
  const m = line.match(/^(\d+)\s+(\d+)$/);
  if (!m) return { hasUpstream: false };
  return {
    hasUpstream: true,
    behind: Number(m[1]),
    ahead: Number(m[2]),
  };
}

/**
 * Ahead/behind vs upstream for a checkout. Never throws.
 *
 * @param {string} cwd
 * @returns {{ hasUpstream: false } | { hasUpstream: true, ahead: number, behind: number }}
 */
async function gitSyncInfo(cwd) {
  if (!cwd) return { hasUpstream: false };
  const resolved = path.resolve(cwd);
  try {
    const inside = await gitOutAsync(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { hasUpstream: false };
  } catch {
    return { hasUpstream: false };
  }
  try {
    const out = await gitOutAsync(resolved, [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    return parseRevListCount(out);
  } catch {
    return { hasUpstream: false };
  }
}

/**
 * `git fetch` in a checkout. Rejects with a short message on failure.
 *
 * @param {string} cwd
 */
async function gitFetch(cwd) {
  const resolved = path.resolve(cwd);
  try {
    await gitOutAsync(resolved, ["fetch"], null, { timeout: GIT_NETWORK_TIMEOUT_MS });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(`git fetch failed: ${msg.split("\n")[0]}`);
  }
}

/**
 * owner/repo plus an https web URL from a git remote URL, or null.
 * Handles scp-style ssh (git@host:owner/repo), ssh:// and http(s) URLs.
 * For nested groups (gitlab group/sub/repo) the last two segments win,
 * matching slugFromRemoteUrl.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, webUrl: string } | null}
 */
function repoInfoFromRemote(url) {
  const cleaned = String(url || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!cleaned) return null;

  const fromParts = (host, pathPart) => {
    const parts = String(pathPart || "")
      .split("/")
      .filter(Boolean);
    if (!host || parts.length < 2) return null;
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1];
    return { owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
  };

  // scp-style ssh: git@host:owner/repo
  const scp = cleaned.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return fromParts(scp[1], scp[2]);

  try {
    const u = new URL(cleaned);
    const proto = u.protocol.replace(/:$/, "").toLowerCase();
    if (proto !== "http" && proto !== "https" && proto !== "ssh") return null;
    return fromParts(u.hostname, u.pathname);
  } catch {
    return null;
  }
}

/**
 * Origin owner/repo + web URL for a checkout. Never throws: no repo, no
 * origin, or an unparseable remote all come back as { ok: false }.
 *
 * @param {string} cwd
 * @returns {{ ok: true, owner: string, repo: string, webUrl: string } | { ok: false }}
 */
async function gitRepoInfo(cwd) {
  if (!cwd) return { ok: false };
  const resolved = path.resolve(cwd);
  try {
    const inside = await gitOutAsync(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { ok: false };
  } catch {
    return { ok: false };
  }
  let remote = "";
  try {
    remote = await gitOutAsync(resolved, ["remote", "get-url", "origin"]);
  } catch {
    return { ok: false };
  }
  const info = repoInfoFromRemote(remote);
  if (!info) return { ok: false };
  return { ok: true, ...info };
}

/**
 * Map `git pull --ff-only` stdout to a one-line UI summary.
 *
 * @param {string} output
 * @returns {string}
 */
function summarizePullOutput(output) {
  const text = String(output || "").trim();
  if (/already up[ -]to[ -]date/i.test(text)) return "Already up to date";
  if (/fast-forward/i.test(text)) return "Fast-forwarded";
  const first = text.split(/\r?\n/, 1)[0].trim();
  return first || "Already up to date";
}

/**
 * Map a failed `git pull --ff-only` error message to a short reason.
 * execFileSync folds stderr into err.message, so fixtures here are the
 * combined output.
 *
 * @param {string} message
 * @returns {string}
 */
function pullFailureReason(message) {
  const text = String(message || "");
  if (/not a git repository/i.test(text)) return "Not a git repository";
  if (/no tracking information|no upstream configured/i.test(text)) {
    return "No upstream configured for this branch";
  }
  if (/divergent branches|not possible to fast-forward/i.test(text)) {
    return "Branch has diverged from upstream";
  }
  if (/local changes|please commit your changes|uncommitted changes/i.test(text)) {
    return "Working tree has uncommitted changes";
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^command failed:/i.test(l));
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
  return fatal || lines[0] || "Pull failed";
}

/**
 * `git pull --ff-only` in a checkout. Never throws: every failure mode
 * (dirty tree, no upstream, diverged, not a repo) comes back in-band.
 *
 * @param {string} cwd
 * @returns {{ ok: true, summary: string } | { ok: false, reason: string }}
 */
async function gitPull(cwd) {
  if (!cwd) return { ok: false, reason: "Not a git repository" };
  const resolved = path.resolve(cwd);
  try {
    const inside = await gitOutAsync(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { ok: false, reason: "Not a git repository" };
  } catch {
    return { ok: false, reason: "Not a git repository" };
  }
  let out;
  try {
    out = await gitOutAsync(resolved, ["pull", "--ff-only"], null, {
      timeout: GIT_NETWORK_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, reason: pullFailureReason(msg) };
  }
  return { ok: true, summary: summarizePullOutput(out) };
}

module.exports = {
  gitOutAsync,
  gitStatus,
  parseRevListCount,
  gitSyncInfo,
  gitFetch,
  repoInfoFromRemote,
  gitRepoInfo,
  summarizePullOutput,
  pullFailureReason,
  gitPull,
};
