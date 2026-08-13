"use strict";

/**
 * GitHub issue ingestion: parse a pasted ref, then `gh issue view`.
 * Never throws; failures come back as `{ ok: false, reason }`.
 */

const {
  gitTry,
  ghTry,
  isGitHubRemote,
  isGhAuthFailure,
  tailErr,
} = require("./worktrees.js");

/**
 * Parse a pasted GitHub issue reference.
 * Accepts a full issues URL, `owner/repo#123`, or a bare number.
 *
 * @param {unknown} text
 * @returns {{ number: number, owner?: string, repo?: string } | null}
 */
function parseIssueRef(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const url = s.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/#?\s]+)\/([^/#?\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i,
  );
  if (url) {
    const number = Number(url[3]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return {
      number,
      owner: url[1],
      repo: String(url[2]).replace(/\.git$/i, ""),
    };
  }

  const hashed = s.match(/^([^/#?\s]+)\/([^/#?\s]+)#(\d+)$/);
  if (hashed) {
    const number = Number(hashed[3]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { number, owner: hashed[1], repo: hashed[2] };
  }

  if (/^\d+$/.test(s)) {
    const number = Number(s);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { number };
  }

  return null;
}

/**
 * owner/repo from a github.com remote URL, or null.
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
function ownerRepoFromRemote(url) {
  const cleaned = String(url || "")
    .trim()
    .replace(/\.git$/i, "");
  if (!cleaned) return null;

  const ssh = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const sshUrl = cleaned.match(
    /^ssh:\/\/(?:[^@/\s]+@)?github\.com\/([^/]+)\/([^/]+)$/i,
  );
  if (sshUrl) return { owner: sshUrl[1], repo: sshUrl[2] };

  const https = cleaned.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/i,
  );
  if (https) return { owner: https[1], repo: https[2] };

  return null;
}

/**
 * True when gh's error means the issue number does not exist.
 * @param {string} text
 * @returns {boolean}
 */
function isIssueNotFound(text) {
  return /could not resolve to an issue|issue not found|Could not find issue|HTTP 404/i.test(
    String(text || ""),
  );
}

/**
 * Fetch a GitHub issue for a project checkout. Never throws.
 *
 * @param {string} projectPath
 * @param {unknown} ref
 * @returns {{ ok: true, issue: { number: number, title: string, body: string, url: string } } | { ok: false, reason: string }}
 */
function fetchIssue(projectPath, ref) {
  try {
    const parsed = parseIssueRef(ref);
    if (!parsed) {
      return { ok: false, reason: "invalid issue reference" };
    }

    const cwd = String(projectPath || "");
    if (!cwd) {
      return { ok: false, reason: "not a GitHub repo" };
    }

    const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
    if (!remote.ok) {
      return { ok: false, reason: "not a GitHub repo" };
    }
    const originUrl = String(remote.stdout || "").trim();
    if (!isGitHubRemote(originUrl)) {
      return { ok: false, reason: "not a GitHub repo" };
    }

    const fromRemote = ownerRepoFromRemote(originUrl);
    const owner = parsed.owner || (fromRemote && fromRemote.owner) || "";
    const repo = parsed.repo || (fromRemote && fromRemote.repo) || "";

    const args = [
      "issue",
      "view",
      String(parsed.number),
      "--json",
      "number,title,body,url",
    ];
    if (owner && repo) {
      args.push("-R", `${owner}/${repo}`);
    }

    const viewed = ghTry(cwd, args);
    if (!viewed.ok) {
      if (viewed.enoent) {
        return { ok: false, reason: "gh missing" };
      }
      const errText = viewed.stderr || viewed.combined || viewed.stdout || "";
      if (isGhAuthFailure(errText)) {
        return { ok: false, reason: "auth" };
      }
      if (isIssueNotFound(errText)) {
        return { ok: false, reason: "issue not found" };
      }
      return {
        ok: false,
        reason: tailErr(errText, "gh issue view failed"),
      };
    }

    let data;
    try {
      const trimmed = String(viewed.stdout || "").trim();
      data = JSON.parse(trimmed === "" ? "{}" : trimmed);
    } catch {
      return { ok: false, reason: "gh returned unparseable issue JSON" };
    }

    const number = Number(data && data.number);
    const title = data && data.title != null ? String(data.title) : "";
    const url = data && data.url != null ? String(data.url) : "";
    if (!Number.isInteger(number) || number <= 0 || !title || !url) {
      return { ok: false, reason: "gh returned incomplete issue JSON" };
    }

    const body = data.body == null ? "" : String(data.body);
    return { ok: true, issue: { number, title, body, url } };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, reason: msg || "issue fetch failed" };
  }
}

module.exports = {
  parseIssueRef,
  fetchIssue,
  ownerRepoFromRemote,
};
