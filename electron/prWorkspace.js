"use strict";

/**
 * In-app PR workspace helpers (issue #154): repo pull-request templates and
 * project-scoped gh actions (view / edit / comment / close / ready / merge).
 *
 * Failures stay in-band (`{ ok: false, reason }`) like listPrs, so the UI
 * can retry without the global run-error banner. Never throws.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  gitTryAsync,
  ghTryAsync,
  GH_TIMEOUT_MS,
  isGitHubRemote,
  isGhAuthFailure,
  isUnknownJsonField,
  tailErr,
  assertNoOutboundSecrets,
} = require("./worktrees.js");

const TEMPLATE_MAX_BYTES = 100 * 1024;
const GH_USER = { timeout: GH_TIMEOUT_MS };

const DETAIL_FIELDS =
  "number,title,body,url,state,isDraft,headRefName,baseRefName,author,additions,deletions,changedFiles,mergeable,updatedAt,comments";
const DETAIL_FIELDS_NO_COMMENTS =
  "number,title,body,url,state,isDraft,headRefName,baseRefName,author,additions,deletions,changedFiles,mergeable,updatedAt";
const DETAIL_FIELDS_FALLBACK = "number,title,body,url,state,headRefName";

function isTemplateFileName(name) {
  return /^pull_request_template(\.md)?$/i.test(String(name || ""));
}

function isTemplateDirName(name) {
  return /^pull_request_template$/i.test(String(name || ""));
}

function listDir(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readCapped(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > TEMPLATE_MAX_BYTES) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function displayNameFor(fileName, isDefault) {
  if (isDefault) return "Default";
  const base = path.basename(String(fileName || ""), path.extname(fileName || ""));
  return base || "Template";
}

/**
 * Ranked PR templates in a checkout. Default single-file templates first
 * (PULL_REQUEST_TEMPLATE.md in repo root, docs/, .github/), then files in
 * those same folders' PULL_REQUEST_TEMPLATE/ directories, sorted by name.
 *
 * @param {string} projectPath
 * @returns {Array<{ name: string, path: string, body: string }>}
 */
function collectPrTemplates(projectPath) {
  const root = String(projectPath || "");
  if (!root) return [];
  /** @type {Array<{ name: string, path: string, body: string }>} */
  const defaults = [];
  /** @type {Array<{ name: string, path: string, body: string }>} */
  const extras = [];
  const seen = new Set();

  function addFile(abs, isDefault) {
    const resolved = path.resolve(abs);
    if (seen.has(resolved)) return;
    const body = readCapped(resolved);
    if (body == null) return;
    seen.add(resolved);
    const row = {
      name: displayNameFor(path.basename(resolved), isDefault),
      path: resolved,
      body,
    };
    if (isDefault) defaults.push(row);
    else extras.push(row);
  }

  const searchRoots = [
    root,
    path.join(root, "docs"),
    path.join(root, ".github"),
  ];
  for (const dir of searchRoots) {
    for (const ent of listDir(dir)) {
      if (ent.isFile() && isTemplateFileName(ent.name)) {
        addFile(path.join(dir, ent.name), true);
      } else if (ent.isDirectory() && isTemplateDirName(ent.name)) {
        const tdir = path.join(dir, ent.name);
        for (const file of listDir(tdir)) {
          if (!file.isFile()) continue;
          const ext = path.extname(file.name);
          if (ext && !/\.md$/i.test(file.name)) continue;
          addFile(path.join(tdir, file.name), false);
        }
      }
    }
  }
  extras.sort((a, b) => a.name.localeCompare(b.name));
  return [...defaults, ...extras];
}

/**
 * Load the repo's pull-request template(s). Local files only: does not need
 * gh or a GitHub remote. Empty templates are success with an empty body.
 *
 * @param {string} projectPath
 * @returns {Promise<
 *   | { ok: true, body: string, path: string | null, templates: ReturnType<typeof collectPrTemplates> }
 *   | { ok: false, reason: string }
 * >}
 */
async function readPrTemplate(projectPath) {
  const cwd = String(projectPath || "");
  if (!cwd) return { ok: false, reason: "not a repo" };
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { ok: false, reason: "not a repo" };
    }
  } catch {
    return { ok: false, reason: "not a repo" };
  }
  const templates = collectPrTemplates(cwd);
  const first = templates[0] || null;
  return {
    ok: true,
    body: first ? first.body : "",
    path: first ? first.path : null,
    templates,
  };
}

function parsePrNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * @param {string} projectPath
 * @returns {Promise<{ ok: true, cwd: string } | { ok: false, reason: string }>}
 */
async function requireGitHubRepo(projectPath) {
  const cwd = String(projectPath || "");
  if (!cwd) return { ok: false, reason: "not a GitHub repo" };
  const remote = await gitTryAsync(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok || !isGitHubRemote(String(remote.stdout || "").trim())) {
    return { ok: false, reason: "not a GitHub repo" };
  }
  return { ok: true, cwd };
}

/**
 * @param {{ ok: boolean, enoent?: boolean, stderr?: string, combined?: string, stdout?: string }} result
 * @param {string} fallback
 */
function ghReason(result, fallback) {
  if (result.enoent) return "gh missing";
  const text = result.stderr || result.combined || result.stdout || "";
  if (isGhAuthFailure(text)) return "auth";
  if (
    /could not find|no pull requests found|not found for|pull request .* not found/i.test(
      String(text || ""),
    )
  ) {
    return "PR not found";
  }
  return tailErr(text, fallback);
}

function optionalCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeMergeable(value) {
  const raw = String(value || "").toUpperCase();
  if (raw === "MERGEABLE" || raw === "CONFLICTING" || raw === "UNKNOWN") {
    return raw;
  }
  return undefined;
}

function normalizeState(value) {
  const raw = String(value || "OPEN").toUpperCase();
  if (raw === "MERGED") return "MERGED";
  if (raw === "CLOSED") return "CLOSED";
  return "OPEN";
}

function commentAuthor(raw) {
  if (!raw) return "unknown";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw.login != null) return String(raw.login);
  return "unknown";
}

/**
 * @param {unknown} raw
 * @returns {Array<{ author: string, body: string, createdAt: string, url?: string }>}
 */
function parsePrComments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const body = row.body != null ? String(row.body) : "";
    out.push({
      author: commentAuthor(row.author),
      body,
      createdAt: row.createdAt != null ? String(row.createdAt) : "",
      ...(row.url ? { url: String(row.url) } : {}),
    });
  }
  return out;
}

/**
 * @param {string} stdout
 * @returns {{
 *   number: number,
 *   title: string,
 *   body: string,
 *   url: string,
 *   state: "OPEN" | "CLOSED" | "MERGED",
 *   isDraft: boolean,
 *   headRefName: string,
 *   baseRefName?: string,
 *   author?: string,
 *   additions?: number,
 *   deletions?: number,
 *   changedFiles?: number,
 *   mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN",
 *   updatedAt?: string,
 *   comments: ReturnType<typeof parsePrComments>,
 * }}
 */
function parsePrDetailJson(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("gh returned unparseable PR JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("gh returned incomplete PR JSON");
  }
  const number = Number(data.number);
  const url = data.url != null ? String(data.url) : "";
  if (!Number.isFinite(number) || number <= 0 || !url) {
    throw new Error("gh returned incomplete PR JSON");
  }
  /** @type {ReturnType<typeof parsePrDetailJson>} */
  const info = {
    number,
    title: data.title != null ? String(data.title) : "",
    body: data.body != null ? String(data.body) : "",
    url,
    state: normalizeState(data.state),
    isDraft: Boolean(data.isDraft),
    headRefName: data.headRefName != null ? String(data.headRefName) : "",
    comments: parsePrComments(data.comments),
  };
  if (data.baseRefName != null && String(data.baseRefName).trim()) {
    info.baseRefName = String(data.baseRefName).trim();
  }
  const author = commentAuthor(data.author);
  if (author && author !== "unknown") info.author = author;
  const additions = optionalCount(data.additions);
  if (additions !== undefined) info.additions = additions;
  const deletions = optionalCount(data.deletions);
  if (deletions !== undefined) info.deletions = deletions;
  const changedFiles = optionalCount(data.changedFiles);
  if (changedFiles !== undefined) info.changedFiles = changedFiles;
  const mergeable = normalizeMergeable(data.mergeable);
  if (mergeable) info.mergeable = mergeable;
  if (data.updatedAt != null && String(data.updatedAt).trim()) {
    info.updatedAt = String(data.updatedAt).trim();
  }
  return info;
}

/**
 * @param {string} cwd
 * @param {number} prNumber
 */
async function viewRaw(cwd, prNumber) {
  const runs = [DETAIL_FIELDS, DETAIL_FIELDS_NO_COMMENTS, DETAIL_FIELDS_FALLBACK];
  let last = null;
  for (const fields of runs) {
    const viewed = await ghTryAsync(
      cwd,
      ["pr", "view", String(prNumber), "--json", fields],
      GH_USER,
    );
    last = viewed;
    if (viewed.ok) return viewed;
    if (viewed.enoent || viewed.timedOut) return viewed;
    if (!isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)) {
      return viewed;
    }
  }
  return last;
}

/**
 * Full PR (title, body, comments, draft) for the workspace panel.
 *
 * @param {string} projectPath
 * @param {unknown} prNumber
 */
async function viewPrDetail(projectPath, prNumber) {
  const number = parsePrNumber(prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;

  const viewed = await viewRaw(repo.cwd, number);
  if (!viewed.ok) {
    return { ok: false, reason: ghReason(viewed, "gh pr view failed") };
  }
  try {
    return { ok: true, pr: parsePrDetailJson(viewed.stdout) };
  } catch (err) {
    return {
      ok: false,
      reason: err && err.message ? String(err.message) : "gh returned unparseable PR JSON",
    };
  }
}

function scanOutbound(text, where) {
  try {
    assertNoOutboundSecrets(text, where);
    return null;
  } catch (err) {
    return err && err.message ? String(err.message) : "blocked by guardrails";
  }
}

function stampMatchingThreads(store, projectPath, prNumber, patch) {
  if (!store || typeof store.getThreads !== "function") return;
  if (typeof store.updateThread !== "function") return;
  const num = Number(prNumber);
  let projectId = null;
  if (typeof store.getProjects === "function") {
    const key = path.resolve(String(projectPath || ""));
    for (const p of store.getProjects()) {
      if (p && p.path && path.resolve(String(p.path)) === key) {
        projectId = p.id;
        break;
      }
    }
  }
  let changed = false;
  for (const t of store.getThreads()) {
    if (!t || t.prNumber !== num) continue;
    if (projectId && t.projectId && t.projectId !== projectId) continue;
    store.updateThread(t.id, patch);
    changed = true;
  }
  if (changed && typeof store.save === "function") store.save();
}

/**
 * @param {string} projectPath
 * @param {{ prNumber: unknown, title?: unknown, body?: unknown }} input
 * @param {{ store?: object, broadcast?: Function }} [opts]
 */
async function editPr(projectPath, input, opts) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const title = input && input.title != null ? String(input.title) : null;
  const body = input && input.body != null ? String(input.body) : null;
  if (title == null && body == null) {
    return { ok: false, reason: "nothing to edit" };
  }
  if (title != null && !title.trim()) {
    return { ok: false, reason: "empty title" };
  }
  const outbound = `${title || ""}\n${body || ""}`;
  const blocked = scanOutbound(outbound, "PR");
  if (blocked) return { ok: false, reason: blocked };

  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;

  /** @type {string[]} */
  const args = ["pr", "edit", String(number)];
  if (title != null) args.push("--title", title);
  if (body != null) args.push("--body", body);
  const edited = await ghTryAsync(repo.cwd, args, GH_USER);
  if (!edited.ok) {
    return { ok: false, reason: ghReason(edited, "gh pr edit failed") };
  }
  const viewed = await viewPrDetail(projectPath, number);
  if (viewed.ok && opts && opts.store) {
    stampMatchingThreads(opts.store, projectPath, number, {
      prUrl: viewed.pr.url,
      prState: viewed.pr.state,
    });
    if (typeof opts.broadcast === "function") {
      try {
        const { listThreads } = require("./services.js");
        opts.broadcast("threads:changed", listThreads(opts.store));
      } catch {
        /* isolated tests */
      }
    }
  }
  return viewed;
}

/**
 * @param {string} projectPath
 * @param {{ prNumber: unknown, body: unknown }} input
 */
async function commentPr(projectPath, input) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const text = input && input.body != null ? String(input.body).trim() : "";
  if (!text) return { ok: false, reason: "empty comment" };
  const blocked = scanOutbound(text, "PR comment");
  if (blocked) return { ok: false, reason: blocked };

  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;

  const posted = await ghTryAsync(
    repo.cwd,
    ["pr", "comment", String(number), "--body", text],
    GH_USER,
  );
  if (!posted.ok) {
    return { ok: false, reason: ghReason(posted, "gh pr comment failed") };
  }
  const stdout = String(posted.stdout || "").trim();
  const urlMatch = stdout.match(/https?:\/\/\S+/);
  const url = urlMatch ? urlMatch[0].replace(/[)\].,;]+$/, "") : "";
  return url ? { ok: true, url } : { ok: true };
}

/**
 * @param {string} projectPath
 * @param {{ prNumber: unknown }} input
 * @param {{ store?: object, broadcast?: Function }} [opts]
 */
async function closePr(projectPath, input, opts) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;

  const closed = await ghTryAsync(
    repo.cwd,
    ["pr", "close", String(number)],
    GH_USER,
  );
  if (!closed.ok) {
    return { ok: false, reason: ghReason(closed, "gh pr close failed") };
  }
  const viewed = await viewPrDetail(projectPath, number);
  if (viewed.ok && opts && opts.store) {
    stampMatchingThreads(opts.store, projectPath, number, {
      prUrl: viewed.pr.url,
      prState: viewed.pr.state,
    });
    if (typeof opts.broadcast === "function") {
      try {
        const { listThreads } = require("./services.js");
        opts.broadcast("threads:changed", listThreads(opts.store));
      } catch {
        /* isolated tests */
      }
    }
  }
  return viewed;
}

/**
 * Mark a draft PR ready, or pass undo:true to convert a ready PR back to draft
 * (`gh pr ready --undo`).
 *
 * @param {string} projectPath
 * @param {{ prNumber: unknown, undo?: unknown }} input
 * @param {{ store?: object, broadcast?: Function }} [opts]
 */
async function readyPr(projectPath, input, opts) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;

  const args = ["pr", "ready", String(number)];
  if (input && input.undo) args.push("--undo");
  const ready = await ghTryAsync(repo.cwd, args, GH_USER);
  if (!ready.ok) {
    return { ok: false, reason: ghReason(ready, "gh pr ready failed") };
  }
  return viewPrDetail(projectPath, number);
}

/**
 * Squash-merge a listed PR by number. Unlike thread-scoped mergePr this does
 * not update-from-base or run the local CI-workflow gate: the checkout may
 * not contain the PR branch.
 *
 * @param {string} projectPath
 * @param {{ prNumber: unknown }} input
 * @param {{ store?: object, broadcast?: Function }} [opts]
 */
async function mergePrAt(projectPath, input, opts) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;

  const merged = await ghTryAsync(
    repo.cwd,
    ["pr", "merge", String(number), "--squash"],
    GH_USER,
  );
  if (!merged.ok) {
    return { ok: false, reason: ghReason(merged, "gh pr merge failed") };
  }
  const viewed = await viewPrDetail(projectPath, number);
  if (viewed.ok && opts && opts.store) {
    stampMatchingThreads(opts.store, projectPath, number, {
      prUrl: viewed.pr.url,
      prState: viewed.pr.state,
    });
    if (typeof opts.broadcast === "function") {
      try {
        const { listThreads } = require("./services.js");
        opts.broadcast("threads:changed", listThreads(opts.store));
      } catch {
        /* isolated tests */
      }
    }
  }
  return viewed;
}

module.exports = {
  TEMPLATE_MAX_BYTES,
  collectPrTemplates,
  readPrTemplate,
  parsePrComments,
  parsePrDetailJson,
  viewPrDetail,
  editPr,
  commentPr,
  closePr,
  readyPr,
  mergePrAt,
};
