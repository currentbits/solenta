"use strict";

/**
 * In-app PR workspace helpers (issue #154): repo pull-request templates and
 * project-scoped gh actions (view / edit / comment / close / ready / merge).
 * They run over the GitHub API when a token exists, gh otherwise (#1534).
 *
 * Failures stay in-band (`{ ok: false, reason }`) like listPrs, so the UI
 * can retry without the global run-error banner. Never throws.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  gitTryAsync,
  ghApiTryAsync,
  GH_TIMEOUT_MS,
  isGitHubPrRemote,
  isGhAuthFailure,
  isUnknownJsonField,
  tailErr,
  assertNoOutboundSecrets,
  mergeFlags,
  squashBodyArgs,
} = require("./worktrees.js");
const {
  budgetPatch,
  FILE_PATCH_CAP,
  FILE_PATCH_MAX,
  chunkPath,
} = require("./worktrees-changes.js");
const {
  viewedKey,
  viewedStatus,
  detectPrStacks,
  stackContaining,
  parseRepoSlug,
  normalizePrLinks,
  upsertPrLink,
} = require("./prLinks.js");

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
  if (!remote.ok || !(await isGitHubPrRemote(String(remote.stdout || "").trim()))) {
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

function ghOpts(repo) {
  return repo ? { ...GH_USER, ghRepo: repo } : GH_USER;
}

/**
 * @param {string} cwd
 * @param {number} prNumber
 * @param {string} [repo]
 */
async function viewRaw(cwd, prNumber, repo) {
  const runs = [DETAIL_FIELDS, DETAIL_FIELDS_NO_COMMENTS, DETAIL_FIELDS_FALLBACK];
  let last = null;
  for (const fields of runs) {
    const viewed = await ghApiTryAsync(
      cwd,
      ["pr", "view", String(prNumber), "--json", fields],
      ghOpts(repo),
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
async function viewPrDetail(projectPath, prNumber, opts) {
  const number = parsePrNumber(prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;
  const other = parseRepoSlug(opts && opts.repo);

  const viewed = await viewRaw(repo.cwd, number, other);
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

function threadHasPr(thread, num) {
  if (thread && thread.prNumber === num) return true;
  return normalizePrLinks(thread).some((l) => l.number === num && !l.repo);
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
    if (!t || !threadHasPr(t, num)) continue;
    if (projectId && t.projectId && t.projectId !== projectId) continue;
    const links = upsertPrLink(normalizePrLinks(t), {
      number: num,
      url: patch.prUrl,
      state: patch.prState,
    });
    store.updateThread(t.id, { ...patch, prLinks: links });
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
  const other = parseRepoSlug(input && input.repo);

  /** @type {string[]} */
  const args = ["pr", "edit", String(number)];
  if (title != null) args.push("--title", title);
  if (body != null) args.push("--body", body);
  const edited = await ghApiTryAsync(repo.cwd, args, ghOpts(other));
  if (!edited.ok) {
    return { ok: false, reason: ghReason(edited, "gh pr edit failed") };
  }
  const viewed = await viewPrDetail(projectPath, number, { repo: other });
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

  const posted = await ghApiTryAsync(
    repo.cwd,
    ["pr", "comment", String(number), "--body", text],
    ghOpts(parseRepoSlug(input && input.repo)),
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

  const other = parseRepoSlug(input && input.repo);
  const closed = await ghApiTryAsync(
    repo.cwd,
    ["pr", "close", String(number)],
    ghOpts(other),
  );
  if (!closed.ok) {
    return { ok: false, reason: ghReason(closed, "gh pr close failed") };
  }
  const viewed = await viewPrDetail(projectPath, number, { repo: other });
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
  const ready = await ghApiTryAsync(
    repo.cwd,
    args,
    ghOpts(parseRepoSlug(input && input.repo)),
  );
  if (!ready.ok) {
    return { ok: false, reason: ghReason(ready, "gh pr ready failed") };
  }
  return viewPrDetail(projectPath, number, { repo: input && input.repo });
}

/**
 * Merge a listed PR by number (squash unless input.method says otherwise;
 * `--auto` when input.auto). Unlike thread-scoped mergePr this does
 * not update-from-base or run the local CI-workflow gate: the checkout may
 * not contain the PR branch.
 *
 * @param {string} projectPath
 * @param {{ prNumber: unknown, method?: unknown, auto?: unknown }} input
 * @param {{ store?: object, broadcast?: Function }} [opts]
 */
async function mergePrAt(projectPath, input, opts) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  let flags;
  try {
    flags = mergeFlags(input);
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;
  const other = parseRepoSlug(input && input.repo);

  const body = await squashBodyArgs(opts && opts.store, repo.cwd, number, input);
  const merged = await ghApiTryAsync(
    repo.cwd,
    ["pr", "merge", String(number), ...flags, ...body],
    ghOpts(other),
  );
  if (!merged.ok) {
    return { ok: false, reason: ghReason(merged, "gh pr merge failed") };
  }
  const viewed = await viewPrDetail(projectPath, number, { repo: other });
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

async function originSlug(cwd) {
  const remote = await gitTryAsync(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) return null;
  return parseRepoSlug(String(remote.stdout || "").trim());
}

function wrapGithubPatch(filePath, patch) {
  const body = String(patch || "");
  if (!body.trim()) return "";
  if (/^diff --git /m.test(body)) return body.endsWith("\n") ? body : `${body}\n`;
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${body.endsWith("\n") ? body : `${body}\n`}`;
}

function parseFilesJson(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const filePath = String(row.path || row.filename || "").trim();
    if (!filePath) continue;
    const status = String(row.status || "M").charAt(0).toUpperCase() || "M";
    out.push({
      path: filePath,
      status: status === "R" ? "R" : status,
      additions: optionalCount(row.additions) || 0,
      deletions: optionalCount(row.deletions) || 0,
      ...(row.sha || row.blobSha ? { blobSha: String(row.sha || row.blobSha) } : {}),
    });
  }
  return out;
}

function parseCommitsJson(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const sha = String(row.oid || row.sha || row.commit || "").trim();
    if (!sha) continue;
    const title = String(
      row.messageHeadline ||
        row.title ||
        (row.commit && row.commit.message) ||
        "",
    ).split("\n")[0];
    out.push({ sha, title });
  }
  return out;
}

function filesFromPatch(patch) {
  const out = [];
  for (const chunk of String(patch || "").split(/(?=^diff --git )/m)) {
    const filePath = chunkPath(chunk);
    if (!filePath) continue;
    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    out.push({ path: filePath, status: "M", additions, deletions });
  }
  return out;
}

function applyViewed(files, marks, headSha) {
  return files.map((file) => ({
    ...file,
    viewed: viewedStatus(marks[file.path], {
      blobSha: file.blobSha,
      headSha,
    }),
  }));
}

function readViewedMarks(store, key) {
  if (!store || typeof store.getPrViewedMarks !== "function") return {};
  return store.getPrViewedMarks(key) || {};
}

/**
 * PR file list + lazy/capped patch (#1527). Same budget as git.diff.
 */
async function prDiff(projectPath, input, opts) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;
  const other = parseRepoSlug(input && input.repo);
  const slug = other || (await originSlug(repo.cwd));
  const commit = input && input.commit ? String(input.commit).trim() : "";
  const only = input && input.path ? String(input.path).trim() : "";
  const full = Boolean(input && input.full);
  const key = viewedKey(slug, number);
  const marks = readViewedMarks(opts && opts.store, key);

  const meta = await ghApiTryAsync(
    repo.cwd,
    ["pr", "view", String(number), "--json", "commits,headRefOid,files,url"],
    ghOpts(other),
  );
  let headSha = "";
  let commits = [];
  let files = [];
  if (meta.ok) {
    try {
      const data = JSON.parse(String(meta.stdout || "").trim());
      headSha = String((data && data.headRefOid) || "").trim();
      commits = parseCommitsJson(data && data.commits);
      files = parseFilesJson(data && data.files);
    } catch {
      /* fall through to the patch */
    }
  }

  if (commit && slug) {
    const one = await ghApiTryAsync(
      repo.cwd,
      ["api", `repos/${slug}/commits/${commit}`],
      GH_USER,
    );
    if (!one.ok) return { ok: false, reason: ghReason(one, "commit diff failed") };
    let data;
    try {
      data = JSON.parse(String(one.stdout || "").trim());
    } catch {
      return { ok: false, reason: "gh returned unparseable commit JSON" };
    }
    const commitFiles = Array.isArray(data && data.files) ? data.files : [];
    files = parseFilesJson(
      commitFiles.map((f) => ({
        path: f.filename,
        filename: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status,
        sha: f.sha,
      })),
    );
    if (only) {
      const row = commitFiles.find((f) => f.filename === only);
      const patch = wrapGithubPatch(only, row && row.patch);
      const cap = full ? FILE_PATCH_MAX : FILE_PATCH_CAP;
      return {
        ok: true,
        headSha: headSha || commit,
        commits,
        files: [],
        patch: patch.length > cap ? patch.slice(0, cap) : patch,
        truncated: patch.length > cap,
      };
    }
    const raw = commitFiles.map((f) => wrapGithubPatch(f.filename, f.patch)).join("");
    const budgeted = budgetPatch(raw);
    for (const [file, why] of budgeted.omitted) {
      const entry = files.find((f) => f.path === file);
      if (entry) entry.patchOmitted = why;
    }
    return {
      ok: true,
      headSha: headSha || commit,
      commits,
      files: applyViewed(files, marks, headSha || commit),
      patch: budgeted.patch,
      truncated: false,
    };
  }

  const diffArgs = ["pr", "diff", String(number)];
  if (only) diffArgs.push("--", only);
  const diffed = await ghApiTryAsync(repo.cwd, diffArgs, ghOpts(other));
  if (!diffed.ok) return { ok: false, reason: ghReason(diffed, "gh pr diff failed") };
  const rawPatch = String(diffed.stdout || "");

  if (only) {
    const cap = full ? FILE_PATCH_MAX : FILE_PATCH_CAP;
    return {
      ok: true,
      headSha,
      commits,
      files: [],
      patch: rawPatch.length > cap ? rawPatch.slice(0, cap) : rawPatch,
      truncated: rawPatch.length > cap,
    };
  }

  if (files.length === 0) files = filesFromPatch(rawPatch);
  const budgeted = budgetPatch(rawPatch);
  for (const [file, why] of budgeted.omitted) {
    const entry = files.find((f) => f.path === file);
    if (entry) entry.patchOmitted = why;
  }
  return {
    ok: true,
    headSha,
    commits,
    files: applyViewed(files, marks, headSha),
    patch: budgeted.patch,
    truncated: false,
  };
}

function prViewed(store, input) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const key = viewedKey(parseRepoSlug(input && input.repo), number);
  return { ok: true, marks: readViewedMarks(store, key) };
}

function prMarkViewed(store, input) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const filePath = String((input && input.path) || "").trim();
  if (!filePath) return { ok: false, reason: "missing path" };
  const headSha = String((input && input.headSha) || "").trim();
  if (!headSha) return { ok: false, reason: "missing head SHA" };
  if (!store || typeof store.setPrViewedMark !== "function") {
    return { ok: false, reason: "store unavailable" };
  }
  const key = viewedKey(parseRepoSlug(input && input.repo), number);
  const viewed = input && input.viewed === false
    ? null
    : {
        headSha,
        ...(input && input.blobSha ? { blobSha: String(input.blobSha) } : {}),
      };
  store.setPrViewedMark(key, filePath, viewed);
  return { ok: true, marks: readViewedMarks(store, key) };
}

function defaultBaseName(name) {
  const raw = refKey(name);
  return raw || "main";
}

function refKey(name) {
  return String(name || "").trim().replace(/^refs\/heads\//, "");
}

/**
 * Stack containing this PR, or empty when it is not in a chain.
 */
async function prStack(projectPath, input) {
  const number = parsePrNumber(input && input.prNumber);
  if (number == null) return { ok: false, reason: "invalid PR number" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;
  const other = parseRepoSlug(input && input.repo);
  const listed = await ghApiTryAsync(
    repo.cwd,
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,title,url,state,headRefName,baseRefName",
    ],
    ghOpts(other),
  );
  if (!listed.ok) return { ok: false, reason: ghReason(listed, "gh pr list failed") };
  let rows = [];
  try {
    const data = JSON.parse(String(listed.stdout || "").trim());
    rows = (Array.isArray(data) ? data : []).map((row) => ({
      number: Number(row.number),
      title: row.title != null ? String(row.title) : "",
      url: row.url != null ? String(row.url) : "",
      state: normalizeState(row.state),
      headRefName: String(row.headRefName || ""),
      baseRefName: String(row.baseRefName || ""),
    }));
  } catch {
    return { ok: false, reason: "gh returned unparseable PR JSON" };
  }
  const current = rows.find((p) => p.number === number);
  const stack = stackContaining(detectPrStacks(rows), number) || [];
  // The stack's landing base is the BOTTOM PR's base (usually main), not
  // the viewed PR's. Using the top PR's base here would retarget the next
  // PR onto a sibling branch after merge deletes the old head.
  const bottom = stack[0] || current;
  const defaultBase = defaultBaseName(bottom && bottom.baseRefName);
  return { ok: true, stack, defaultBase: defaultBase || "main" };
}

async function retargetPrBase(cwd, prNumber, base, repo) {
  const edited = await ghApiTryAsync(
    cwd,
    ["pr", "edit", String(prNumber), "--base", base],
    ghOpts(repo),
  );
  if (!edited.ok) return { ok: false, reason: ghReason(edited, "gh pr edit --base failed") };
  return { ok: true };
}

/**
 * Merge the stack bottom-up. After each merge, retarget the next PR onto
 * the default base before GitHub deletes the old head branch.
 */
async function mergePrStack(projectPath, input, opts) {
  const stacked = await prStack(projectPath, input);
  if (!stacked.ok) return stacked;
  if (stacked.stack.length < 2) {
    return { ok: false, reason: "not a stacked pull request" };
  }
  const open = stacked.stack.filter((p) => p.state === "OPEN");
  if (open.length === 0) return { ok: false, reason: "stack already merged" };
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;
  const other = parseRepoSlug(input && input.repo);
  const base = stacked.defaultBase || "main";
  for (let i = 0; i < open.length; i += 1) {
    const current = open[i];
    const merged = await mergePrAt(
      projectPath,
      { prNumber: current.number, method: input && input.method },
      opts,
    );
    if (!merged.ok) return merged;
    const next = open[i + 1];
    if (next) {
      const retarget = await retargetPrBase(repo.cwd, next.number, base, other);
      if (!retarget.ok) return retarget;
    }
  }
  return { ok: true, stack: open, defaultBase: base };
}

function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Rebase each PR onto the previous head (bottom onto the default base)
 * and force-push with lease.
 */
async function rebasePrStack(projectPath, input) {
  const stacked = await prStack(projectPath, input);
  if (!stacked.ok) return stacked;
  if (stacked.stack.length < 2) {
    return { ok: false, reason: "not a stacked pull request" };
  }
  const repo = await requireGitHubRepo(projectPath);
  if (!repo.ok) return repo;
  const fetched = await gitTryAsync(repo.cwd, ["fetch", "origin"]);
  if (!fetched.ok) {
    return { ok: false, reason: tailErr(fetched.stderr || fetched.combined, "git fetch failed") };
  }
  const base = stacked.defaultBase || "main";
  const open = stacked.stack.filter((p) => p.state === "OPEN");
  for (let i = 0; i < open.length; i += 1) {
    const current = open[i];
    const onto = i === 0 ? `origin/${base}` : `origin/${open[i - 1].headRefName}`;
    const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "solenta-stack-"));
    const ref = `refs/solenta-stack/${current.number}`;
    try {
      const got = await gitTryAsync(repo.cwd, [
        "fetch",
        "origin",
        `pull/${current.number}/head:${ref}`,
      ]);
      if (!got.ok) {
        return { ok: false, reason: tailErr(got.stderr || got.combined, `fetch #${current.number} failed`) };
      }
      const added = await gitTryAsync(repo.cwd, ["worktree", "add", "--detach", tmp, ref]);
      if (!added.ok) {
        return { ok: false, reason: tailErr(added.stderr || added.combined, `worktree #${current.number} failed`) };
      }
      const rebased = await gitTryAsync(tmp, ["rebase", onto]);
      if (!rebased.ok) {
        await gitTryAsync(tmp, ["rebase", "--abort"]);
        return { ok: false, reason: `Rebase of #${current.number} onto ${onto} failed` };
      }
      const pushed = await gitTryAsync(tmp, [
        "push",
        "--force-with-lease",
        "origin",
        `HEAD:refs/heads/${current.headRefName}`,
      ]);
      if (!pushed.ok) {
        return { ok: false, reason: tailErr(pushed.stderr || pushed.combined, `push #${current.number} failed`) };
      }
    } finally {
      await gitTryAsync(repo.cwd, ["worktree", "remove", "--force", tmp]);
      await gitTryAsync(repo.cwd, ["update-ref", "-d", ref]);
      rmTree(tmp);
    }
  }
  return { ok: true, stack: open, defaultBase: base };
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
  prDiff,
  prViewed,
  prMarkViewed,
  prStack,
  mergePrStack,
  rebasePrStack,
};
