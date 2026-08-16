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

/**
 * Parse `gh issue list --json ...` stdout into PlanIssue rows.
 * Rows missing a positive number, title, or url are dropped.
 *
 * @param {string} stdout
 * @returns {{ number: number, title: string, url: string, state: "OPEN" | "CLOSED", labels: string[], updatedAt?: string }[]}
 */
function parseIssueListJson(stdout) {
  let data;
  try {
    const trimmed = String(stdout || "").trim();
    data = JSON.parse(trimmed === "" ? "[]" : trimmed);
  } catch {
    throw new Error("gh returned unparseable issue list JSON");
  }
  if (!Array.isArray(data)) {
    throw new Error("gh returned incomplete issue list JSON");
  }
  const issues = [];
  for (const row of data) {
    const number = Number(row && row.number);
    const title = row && row.title != null ? String(row.title) : "";
    const url = row && row.url != null ? String(row.url) : "";
    if (!Number.isInteger(number) || number <= 0 || !title || !url) continue;
    const labels = Array.isArray(row.labels)
      ? row.labels
          .map((l) => (l && l.name != null ? String(l.name) : ""))
          .filter(Boolean)
      : [];
    const issue = {
      number,
      title,
      url,
      state:
        String(row.state || "").toUpperCase() === "CLOSED"
          ? "CLOSED"
          : "OPEN",
      labels,
    };
    if (row.updatedAt != null && String(row.updatedAt).trim() !== "") {
      issue.updatedAt = String(row.updatedAt);
    }
    issues.push(issue);
  }
  return issues;
}

/**
 * Issues for a project checkout (Planboard). Never throws: missing gh, a
 * non-GitHub remote, or auth failure come back as `{ ok: false, reason }`.
 *
 * @param {string} projectPath
 * @returns {{ ok: true, issues: ReturnType<typeof parseIssueListJson> } | { ok: false, reason: string }}
 */
function listIssues(projectPath) {
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

  const listed = ghTry(cwd, [
    "issue",
    "list",
    "--state",
    "all",
    "--json",
    "number,title,labels,state,url,updatedAt",
    "--limit",
    "100",
  ]);
  if (!listed.ok) {
    if (listed.enoent) {
      return { ok: false, reason: "gh missing" };
    }
    if (isGhAuthFailure(listed.stderr || listed.combined || listed.stdout)) {
      return { ok: false, reason: "auth" };
    }
    return {
      ok: false,
      reason: tailErr(
        listed.stderr || listed.combined,
        "gh issue list failed",
      ),
    };
  }
  try {
    return { ok: true, issues: parseIssueListJson(listed.stdout) };
  } catch (err) {
    return {
      ok: false,
      reason:
        err && err.message
          ? String(err.message)
          : "gh returned unparseable issue list JSON",
    };
  }
}

const PLAN_LABELS = ["plan:todo", "plan:doing", "plan:done"];

/**
 * Move an issue's plan:* label (Planboard "Start task" → plan:doing).
 * Never throws; failures come back as `{ ok: false, reason }`.
 *
 * gh refuses the whole edit when a --remove-label name is not a label in the
 * repo, so a repo that only has some of the plan:* labels falls back to
 * adding the new one and leaving the stale one — the column still moves
 * (plan:doing outranks plan:todo).
 *
 * @param {string} projectPath
 * @param {unknown} number
 * @param {unknown} status one of "todo" | "doing" | "done"
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function setPlanStatus(projectPath, number, status) {
  const cwd = String(projectPath || "");
  const issueNumber = Number(number);
  const label = `plan:${String(status || "")}`;
  if (!cwd) return { ok: false, reason: "not a GitHub repo" };
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, reason: "invalid issue reference" };
  }
  if (!PLAN_LABELS.includes(label)) {
    return { ok: false, reason: `unknown plan status: ${status}` };
  }

  const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok || !isGitHubRemote(String(remote.stdout || "").trim())) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  const base = ["issue", "edit", String(issueNumber), "--add-label", label];
  let edited = ghTry(cwd, [
    ...base,
    "--remove-label",
    PLAN_LABELS.filter((l) => l !== label).join(","),
  ]);
  let errText = edited.stderr || edited.combined || edited.stdout || "";
  if (!edited.ok && !edited.enoent && /not found/i.test(errText)) {
    edited = ghTry(cwd, base);
    errText = edited.stderr || edited.combined || edited.stdout || "";
  }
  if (edited.ok) return { ok: true };
  if (edited.enoent) return { ok: false, reason: "gh missing" };
  if (isGhAuthFailure(errText)) return { ok: false, reason: "auth" };
  if (isIssueNotFound(errText)) return { ok: false, reason: "issue not found" };
  return { ok: false, reason: tailErr(errText, "gh issue edit failed") };
}

module.exports = {
  parseIssueRef,
  fetchIssue,
  listIssues,
  setPlanStatus,
  parseIssueListJson,
  ownerRepoFromRemote,
};
