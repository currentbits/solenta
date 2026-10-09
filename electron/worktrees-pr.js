"use strict";

// GitHub CLI helpers and pull requests: list, status, checks, update, merge, refresh and create.

const { execFile } = require("node:child_process");
const { GIT_MAX_BUFFER, gitTry, gitOutAsync, tailErr, gitTryAsync } = require("./worktrees-git.js");
const {
  repoDefaultBranchAsync,
  recordedBaseBranch,
  defaultBranchAsync,
} = require("./worktrees-branches.js");
const {
  unmergedFiles,
  unresolvedFiles,
  conflictError,
  autoResolveMergeArtifacts,
} = require("./worktrees-conflicts.js");
const { push, assertNoOutboundSecrets, scanOutgoingPush } = require("./worktrees-push.js");
const { gateCiWorkflowMerge } = require("./worktrees-changes.js");
const { maybeCleanupMergedWorktree } = require("./worktrees-gc.js");
const prWatch = require("./prWatch.js");
const github = require("./github.js");

/** Per-thread background PR refresh timeout. Hard kill; never block the main process. */
const PR_REFRESH_TIMEOUT_MS = 8_000;

/** MERGED/CLOSED are terminal — never re-query. */
const TERMINAL_PR_STATES = new Set(["MERGED", "CLOSED"]);

const GH_TIMEOUT_MS = 30_000;

/**
 * Resolve the gh binary. Tests set CODER_GH_BIN to a fake; production uses PATH.
 * @returns {string}
 */
function ghBin() {
  return process.env.CODER_GH_BIN || "gh";
}

/**
 * True when origin points at github.com (https, ssh, or git@).
 * Local bare paths, gitlab, and arbitrary ssh hosts return false.
 * @param {string} url
 * @returns {boolean}
 */
function isGitHubRemote(url) {
  const s = String(url || "").trim();
  if (!s) return false;
  if (/^git@github\.com:/i.test(s)) return true;
  if (/^ssh:\/\/([^@/\s]+@)?github\.com\//i.test(s)) return true;
  if (/^https?:\/\/(www\.)?github\.com\//i.test(s)) return true;
  return false;
}

/**
 * Classify a failed execFileSync/execFile error into the shared ghTry shape.
 * @param {any} err
 * @returns {{ ok: false, enoent: boolean, stdout: string, stderr: string, combined: string, error: any, timedOut: boolean }}
 */
function ghFailFromError(err) {
  if (err && err.code === "ENOENT") {
    return {
      ok: false,
      enoent: true,
      stdout: "",
      stderr: "",
      combined: "",
      error: err,
      timedOut: false,
    };
  }
  const stdout = err && err.stdout != null ? String(err.stdout) : "";
  const stderr = err && err.stderr != null ? String(err.stderr) : "";
  const msg = err && err.message ? String(err.message) : String(err);
  // Node marks timeout kills with err.killed + ETIMEDOUT / "timed out" message.
  const timedOut =
    (err && err.code === "ETIMEDOUT") ||
    (err && err.killed && /ETIMEDOUT|timed out/i.test(msg)) ||
    (err && err.killed === true && err.signal != null);
  const combined = [stdout, stderr, msg].filter(Boolean).join("\n");
  return {
    ok: false,
    enoent: false,
    stdout,
    stderr,
    combined,
    error: err,
    timedOut: Boolean(timedOut),
  };
}

// A synchronous ghTry used to live here. It is deliberately gone (#124): gh is
// a NETWORK call bounded at GH_TIMEOUT_MS (30s), so one hanging GitHub request
// froze every window and every streaming thread for half a minute. Every gh
// caller now goes through ghTryAsync. Do not reintroduce a sync variant.

/**
 * Async gh. NEVER blocks the Electron main process. Uses execFile (not Sync)
 * with a hard timeout that kills the child. Used by the PR-state refresher.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 * @returns {Promise<{ ok: boolean, enoent?: boolean, stdout: string, stderr: string, combined: string, timedOut?: boolean, error?: any }>}
 */
function ghTryAsync(cwd, args, opts) {
  const timeout =
    opts && opts.timeout != null ? opts.timeout : PR_REFRESH_TIMEOUT_MS;
  const env = {
    ...process.env,
    ...(opts && opts.env ? opts.env : {}),
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  return new Promise((resolve) => {
    execFile(
      ghBin(),
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout,
        env,
      },
      (err, stdout, stderr) => {
        if (!err) {
          const out = String(stdout || "").trim();
          resolve({ ok: true, stdout: out, stderr: "", combined: out });
          return;
        }
        // Attach stdout/stderr from the callback when the error object lacks them.
        if (err && err.stdout == null && stdout != null) err.stdout = stdout;
        if (err && err.stderr == null && stderr != null) err.stderr = stderr;
        resolve(ghFailFromError(err));
      },
    );
  });
}

/** @type {{ fetchFn?: typeof fetch, tokenFn?: (host: string) => Promise<string | null> } | null} */
let githubApiTestHook = null;

/**
 * Test hook: route interactive PR ops through an injected fetch/token even
 * under a fake gh (CODER_GH_BIN). Pass null to restore.
 * @param {{ fetchFn?: typeof fetch, tokenFn?: (host: string) => Promise<string | null> } | null} hook
 */
function setGithubApi(hook) {
  githubApiTestHook = hook || null;
}

/**
 * API path on/off, same rule as refreshPrStates: a fake gh turns it off
 * unless a test injected fetch; CODER_GITHUB_API=0 forces gh.
 */
function githubApiEnabled() {
  if (process.env.CODER_GITHUB_API === "0") return false;
  return githubApiTestHook != null || !process.env.CODER_GH_BIN;
}

/**
 * GitHub remote + token for the API path, or null (then only gh applies).
 * Any host parseRemote accepts qualifies once a token exists (GHE).
 * @param {string} originUrl
 */
async function githubApiTarget(originUrl) {
  if (!githubApiEnabled()) return null;
  const remote = github.parseRemote(originUrl);
  if (!remote) return null;
  const tokenFn = (githubApiTestHook && githubApiTestHook.tokenFn) || github.githubToken;
  const token = await tokenFn(remote.host);
  return token ? { remote, token } : null;
}

/**
 * True when PR ops can run here: github.com (gh), or any host the API holds
 * a token for.
 * @param {string} originUrl
 */
async function isGitHubPrRemote(originUrl) {
  return isGitHubRemote(originUrl) || (await githubApiTarget(originUrl)) != null;
}

/**
 * `gh pr …`, `gh issue …` and `gh api graphql …` with the GitHub API first (#1534), same result shape as
 * ghTryAsync so callers keep their gh parsing. Falls back to the real gh when
 * there is no token, the argv is not translated, or the API throws — except:
 * a definitive "no such PR" is returned as gh's own not-found text; a timed
 * out write is returned as a failure (re-sending a comment/create/merge could
 * double it); and a non-github.com host never falls back (gh stays gated on
 * isGitHubRemote).
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeout?: number }} [opts]
 */
async function ghApiTryAsync(cwd, args, opts) {
  const origin = githubApiEnabled()
    ? await gitTryAsync(cwd, ["remote", "get-url", "origin"])
    : null;
  const originUrl = origin && origin.ok ? String(origin.stdout || "").trim() : "";
  const target = originUrl ? await githubApiTarget(originUrl) : null;
  if (target) {
    try {
      const translate = args[0] === "pr" ? github.ghPr : github.ghIssue;
      const out = await translate(target.remote, args, {
        token: target.token,
        fetchFn: githubApiTestHook && githubApiTestHook.fetchFn,
        timeoutMs: opts && opts.timeout != null ? opts.timeout : GH_TIMEOUT_MS,
      });
      return { ok: true, stdout: out, stderr: "", combined: out };
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      const fail = { ok: false, stdout: "", stderr: msg, combined: msg };
      if (err && err.notFound) return fail;
      // Same side effect as a gh auth failure: rescan the forge probe (#608).
      if (err && err.status === 401) isGhAuthFailure("HTTP 401");
      const write = args[0] !== "api" && !["view", "list", "checks"].includes(args[1]);
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      if ((write && timedOut) || !isGitHubRemote(originUrl)) return fail;
    }
  }
  return ghTryAsync(cwd, args, opts);
}

/**
 * Throw a clear Error from a failed ghTry result (or ENOENT / timeout).
 * @param {{ ok: boolean, enoent?: boolean, timedOut?: boolean, stderr?: string, combined?: string }} result
 * @param {string} fallback
 */
function throwGhFailure(result, fallback) {
  if (result.enoent) {
    throw new Error("GitHub CLI (gh) is not installed");
  }
  if (result.timedOut) {
    throw new Error("gh timed out after 30s");
  }
  throw new Error(tailErr(result.stderr || result.combined, fallback));
}

/** Interactive `gh pr view` field set. Background refresh and create stay minimal. */
const PR_JSON_MINIMAL = "number,url,state";
const PR_JSON_ENRICHED =
  "number,url,state,title,additions,deletions,changedFiles,mergeable,baseRefName";

/** GitHub `mergeable` values we persist and show. */
const PR_MERGEABLE = new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);

/**
 * Normalize gh's mergeable field. Unknown / empty → undefined (omitted).
 * @param {unknown} value
 * @returns {"MERGEABLE" | "CONFLICTING" | "UNKNOWN" | undefined}
 */
function normalizeMergeable(value) {
  if (value == null || value === "") return undefined;
  const s = String(value).toUpperCase();
  return PR_MERGEABLE.has(s) ? s : undefined;
}

/**
 * Finite number from gh JSON, or undefined when the field is absent/unusable.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function optionalPrCount(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse `gh pr view --json` into a PrInfo-shaped object.
 * Optional title/diff stats are passed through when present.
 * @param {string} stdout
 * @param {string} branch
 * @param {boolean} created
 * @returns {{
 *   number: number,
 *   url: string,
 *   state: "OPEN" | "CLOSED" | "MERGED",
 *   branch: string,
 *   created: boolean,
 *   title?: string,
 *   additions?: number,
 *   deletions?: number,
 *   changedFiles?: number,
 *   mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN",
 *   baseRefName?: string,
 * }}
 */
function parsePrJson(stdout, branch, created) {
  let data;
  try {
    data = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("gh returned unparseable PR JSON");
  }
  const number = Number(data && data.number);
  const url = data && data.url != null ? String(data.url) : "";
  if (!Number.isFinite(number) || number <= 0 || !url) {
    throw new Error("gh returned incomplete PR JSON");
  }
  const raw = String((data && data.state) || "OPEN").toUpperCase();
  /** @type {"OPEN" | "CLOSED" | "MERGED"} */
  const state =
    raw === "MERGED" ? "MERGED" : raw === "CLOSED" ? "CLOSED" : "OPEN";
  /** @type {{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean, title?: string, additions?: number, deletions?: number, changedFiles?: number, mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN", baseRefName?: string }} */
  const info = { number, url, state, branch, created: Boolean(created) };
  if (data && data.title != null) info.title = String(data.title);
  const additions = optionalPrCount(data && data.additions);
  if (additions !== undefined) info.additions = additions;
  const deletions = optionalPrCount(data && data.deletions);
  if (deletions !== undefined) info.deletions = deletions;
  const changedFiles = optionalPrCount(data && data.changedFiles);
  if (changedFiles !== undefined) info.changedFiles = changedFiles;
  const mergeable = normalizeMergeable(data && data.mergeable);
  if (mergeable) info.mergeable = mergeable;
  if (data && data.baseRefName != null && String(data.baseRefName).trim()) {
    info.baseRefName = String(data.baseRefName).trim();
  }
  return info;
}

const PR_LIST_FIELDS =
  "number,title,url,state,headRefName,isDraft,additions,deletions,updatedAt";
const PR_LIST_FIELDS_FALLBACK = "number,title,url,state,headRefName";

/**
 * True when gh rejected --json because a field name is unknown (older gh).
 * @param {string} text
 * @returns {boolean}
 */
function isUnknownJsonField(text) {
  return /unknown (json )?field/i.test(String(text || ""));
}

/**
 * True when gh's error is missing/expired auth, not a repo or network issue.
 * @param {string} text
 * @returns {boolean}
 */
function isGhAuthFailure(text) {
  const hit =
    /gh auth login|GH_TOKEN|not logged into|authentication required|HTTP 401|Bad credentials/i.test(
      String(text || ""),
    );
  // Mid-session expiry: drop the forge probe so Settings / next-git rescan
  // instead of serving a stale "signed in as …" (#608).
  if (hit) {
    try {
      require("./sourceControl.js").invalidateDiscoveryCache();
    } catch {
      // Probe module is optional for isolated unit tests.
    }
  }
  return hit;
}

/**
 * Normalize one `gh pr list --json` row into a PrListItem.
 * @param {any} row
 * @returns {{
 *   number: number,
 *   title: string,
 *   url: string,
 *   state: "OPEN" | "CLOSED" | "MERGED",
 *   headRefName: string,
 *   isDraft?: boolean,
 *   additions?: number,
 *   deletions?: number,
 *   updatedAt?: string,
 * }}
 */
function parsePrListItem(row) {
  const number = Number(row && row.number);
  const url = row && row.url != null ? String(row.url) : "";
  if (!Number.isFinite(number) || number <= 0 || !url) {
    throw new Error("gh returned incomplete PR list JSON");
  }
  const raw = String((row && row.state) || "OPEN").toUpperCase();
  /** @type {"OPEN" | "CLOSED" | "MERGED"} */
  const state =
    raw === "MERGED" ? "MERGED" : raw === "CLOSED" ? "CLOSED" : "OPEN";
  /** @type {{
   *   number: number,
   *   title: string,
   *   url: string,
   *   state: "OPEN" | "CLOSED" | "MERGED",
   *   headRefName: string,
   *   isDraft?: boolean,
   *   additions?: number,
   *   deletions?: number,
   *   updatedAt?: string,
   * }} */
  const item = {
    number,
    title: row && row.title != null ? String(row.title) : "",
    url,
    state,
    headRefName:
      row && row.headRefName != null ? String(row.headRefName) : "",
  };
  if (typeof (row && row.isDraft) === "boolean") {
    item.isDraft = row.isDraft;
  }
  if (row && row.additions != null && Number.isFinite(Number(row.additions))) {
    item.additions = Number(row.additions);
  }
  if (row && row.deletions != null && Number.isFinite(Number(row.deletions))) {
    item.deletions = Number(row.deletions);
  }
  if (row && row.updatedAt != null && String(row.updatedAt).trim() !== "") {
    item.updatedAt = String(row.updatedAt);
  }
  return item;
}

/**
 * Parse `gh pr list --json ...` stdout (an array) into PrListItem[].
 * @param {string} stdout
 * @returns {ReturnType<typeof parsePrListItem>[]}
 */
function parsePrListJson(stdout) {
  let data;
  try {
    const trimmed = String(stdout || "").trim();
    data = JSON.parse(trimmed === "" ? "[]" : trimmed);
  } catch {
    throw new Error("gh returned unparseable PR list JSON");
  }
  if (!Array.isArray(data)) {
    throw new Error("gh returned incomplete PR list JSON");
  }
  return data.map(parsePrListItem);
}

/**
 * Raw `gh pr list --json` for a checkout. Same origin / unknown-field /
 * auth dance as `listPrs`, but returns the parsed JSON rows so callers that
 * need extra keys (fleet: createdAt, reviews) do not re-implement the
 * fallback. Never throws.
 *
 * @param {string} projectPath
 * @param {{ fields?: string, fallbackFields?: string, extraArgs?: string[] }} [opts]
 * @returns {Promise<{ ok: true, prs: any[] } | { ok: false, reason: string }>}
 */
async function listPrsRaw(projectPath, opts) {
  const cwd = String(projectPath || "");
  if (!cwd) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  const remote = await gitTryAsync(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    return { ok: false, reason: "not a GitHub repo" };
  }
  const originUrl = String(remote.stdout || "").trim();
  if (!(await isGitHubPrRemote(originUrl))) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  const fields = (opts && opts.fields) || PR_LIST_FIELDS;
  const fallback = (opts && opts.fallbackFields) || PR_LIST_FIELDS_FALLBACK;
  const extraArgs = (opts && opts.extraArgs) || ["--limit", "50"];

  let listed = await ghApiTryAsync(
    cwd,
    ["pr", "list", "--json", fields, ...extraArgs],
    { timeout: GH_TIMEOUT_MS },
  );
  if (
    !listed.ok &&
    isUnknownJsonField(listed.stderr || listed.combined || listed.stdout)
  ) {
    listed = await ghApiTryAsync(
      cwd,
      ["pr", "list", "--json", fallback, ...extraArgs],
      { timeout: GH_TIMEOUT_MS },
    );
  }
  if (!listed.ok) {
    if (listed.enoent) {
      return { ok: false, reason: "gh missing" };
    }
    if (isGhAuthFailure(listed.stderr || listed.combined || listed.stdout)) {
      return { ok: false, reason: "auth" };
    }
    return {
      ok: false,
      reason: tailErr(listed.stderr || listed.combined, "gh pr list failed"),
    };
  }
  try {
    const trimmed = String(listed.stdout || "").trim();
    const data = JSON.parse(trimmed === "" ? "[]" : trimmed);
    if (!Array.isArray(data)) {
      return { ok: false, reason: "gh returned incomplete PR list JSON" };
    }
    return { ok: true, prs: data };
  } catch {
    return { ok: false, reason: "gh returned unparseable PR list JSON" };
  }
}

const PR_LIST_DEFAULT_LIMIT = 50;
const PR_LIST_MAX_LIMIT = 200;

/**
 * Clamp a UI `listPrs` page size. `listPrsRaw` extraArgs stay caller-owned
 * (Fleet uses `--limit 100`) and are not passed through here.
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampPrListLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return PR_LIST_DEFAULT_LIMIT;
  return Math.min(PR_LIST_MAX_LIMIT, Math.floor(n));
}

/**
 * Open PRs for a project checkout. Never throws: missing gh, a non-GitHub
 * remote, or auth failure come back as `{ ok: false, reason }` so the UI
 * can render a per-project error row.
 *
 * @param {string} projectPath
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ ok: true, prs: ReturnType<typeof parsePrListItem>[], complete: boolean, limit: number } | { ok: false, reason: string }>}
 */
async function listPrs(projectPath, opts) {
  const limit = clampPrListLimit(opts && opts.limit);
  const raw = await listPrsRaw(projectPath, {
    extraArgs: ["--limit", String(limit)],
  });
  if (!raw.ok) return raw;
  try {
    const prs = raw.prs.map(parsePrListItem);
    return { ok: true, prs, complete: prs.length < limit, limit };
  } catch (err) {
    return {
      ok: false,
      reason:
        err && err.message
          ? String(err.message)
          : "gh returned unparseable PR list JSON",
    };
  }
}

/**
 * True when gh exit means "no PR for this branch" (not an env failure).
 * @param {string} text
 * @returns {boolean}
 */
function isNoPrMessage(text) {
  // Deliberately narrow. A bare /not found/ also matches "HTTP 404: Not Found",
  // which is a deleted or renamed repo or a token without scope, and treating
  // that as "no PR yet" hides a real failure behind a spurious create attempt.
  return /no (open )?pull requests? found|no pull request found/i.test(
    String(text || ""),
  );
}

/**
 * Resolve thread cwd + current branch name (same rules as push).
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {Promise<{ thread: object, project: object, cwd: string, branch: string, originUrl: string }>}
 */
async function resolveThreadGit(store, threadId) {
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const project = store.getProject(thread.projectId);
  if (!project) {
    throw new Error(`Unknown project for thread: ${threadId}`);
  }

  const cwd = thread.worktreePath || project.path;

  let branch = "";
  try {
    branch = await gitOutAsync(cwd, ["branch", "--show-current"]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(
      `Could not determine current branch: ${msg.split("\n")[0]}`,
    );
  }
  if (!branch) {
    throw new Error(
      "Checkout is detached HEAD or has no branch name; check out a branch before opening a PR",
    );
  }

  const remote = await gitTryAsync(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    throw new Error("No git remote configured for this project.");
  }
  const originUrl = String(remote.stdout || "").trim();

  return { thread, project, cwd, branch, originUrl };
}

/**
 * Live PR for the thread's branch, or null when none exists.
 * Rejects on gh missing / not authenticated / non-GitHub remote.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean } | null>}
 */
async function prStatus(opts) {
  const { store, threadId } = opts;
  const { cwd, branch, originUrl } = await resolveThreadGit(store, threadId);

  if (!(await isGitHubPrRemote(originUrl))) {
    throw new Error(
      `Remote origin is not a GitHub repository (got: ${originUrl}). PR status requires github.com.`,
    );
  }

  let viewed = await ghApiTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_ENRICHED], {
    timeout: GH_TIMEOUT_MS,
  });
  if (
    !viewed.ok &&
    isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
  ) {
    viewed = await ghApiTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_MINIMAL], {
      timeout: GH_TIMEOUT_MS,
    });
  }
  if (!viewed.ok) {
    if (viewed.enoent || viewed.timedOut) {
      throwGhFailure(viewed, "gh pr view failed");
    }
    if (isNoPrMessage(viewed.stderr || viewed.combined || viewed.stdout)) {
      return null;
    }
    throwGhFailure(viewed, "gh pr view failed");
  }

  const info = parsePrJson(viewed.stdout, branch, false);
  // Persist last-known PR state (interactive path). Background freshness is
  // refreshPrStates — async, serialized, failure-silent, on a latch.
  store.updateThread(threadId, {
    prNumber: info.number,
    prUrl: info.url,
    prState: info.state,
    prMergeable: info.mergeable || null,
  });
  try {
    require("./postmerge.js").onThreadPrState(store, threadId, info.state);
  } catch {
    // scheduling must never fail an interactive prStatus
  }
  store.save();
  return info;
}

/** Buckets `gh pr checks --json` reports. */
const PR_CHECK_BUCKETS = new Set([
  "pass",
  "fail",
  "pending",
  "skipping",
  "cancel",
]);

/**
 * Map a gh check state/bucket string onto the five buckets the UI knows.
 * @param {unknown} raw
 * @returns {"pass" | "fail" | "pending" | "skipping" | "cancel"}
 */
function normalizeCheckBucket(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (s === "pass" || s === "success" || s === "completed") return "pass";
  if (s === "fail" || s === "failure" || s === "failed" || s === "error") {
    return "fail";
  }
  if (s === "skipping" || s === "skipped" || s === "skip") return "skipping";
  if (s === "cancel" || s === "cancelled" || s === "canceled") return "cancel";
  if (
    s === "pending" ||
    s === "queued" ||
    s === "in_progress" ||
    s === "inprogress" ||
    s === "waiting"
  ) {
    return "pending";
  }
  return "pending";
}

/**
 * True when gh rejected `pr checks --json` (older CLI, unknown field/flag).
 * @param {string} text
 * @returns {boolean}
 */
function isChecksJsonRejected(text) {
  const s = String(text || "");
  if (isUnknownJsonField(s)) return true;
  return (
    /json/i.test(s) &&
    /unknown flag|flag provided but not defined|unknown (command|argument|shorthand)/i.test(
      s,
    )
  );
}

/**
 * Parse one `gh pr checks --json` row.
 * @param {any} row
 * @returns {{ name: string, bucket: "pass" | "fail" | "pending" | "skipping" | "cancel", link?: string }}
 */
function parsePrCheckItem(row) {
  const name = row && row.name != null ? String(row.name).trim() : "";
  if (!name) {
    throw new Error("gh returned incomplete PR checks JSON");
  }
  const bucket = normalizeCheckBucket(
    (row && row.bucket) || (row && row.state),
  );
  /** @type {{ name: string, bucket: "pass" | "fail" | "pending" | "skipping" | "cancel", link?: string }} */
  const item = { name, bucket };
  if (row && row.link != null && String(row.link).trim() !== "") {
    item.link = String(row.link);
  }
  return item;
}

/**
 * Parse `gh pr checks --json name,state,bucket,link` stdout (an array).
 * @param {string} stdout
 * @returns {ReturnType<typeof parsePrCheckItem>[]}
 */
function parsePrChecksJson(stdout) {
  let data;
  try {
    const trimmed = String(stdout || "").trim();
    data = JSON.parse(trimmed === "" ? "[]" : trimmed);
  } catch {
    throw new Error("gh returned unparseable PR checks JSON");
  }
  if (!Array.isArray(data)) {
    throw new Error("gh returned incomplete PR checks JSON");
  }
  return data.map(parsePrCheckItem);
}

const CHECK_TEXT_BUCKET =
  /^(pass|fail|pending|skipping|cancel|success|failure|failed|error|queued|in_progress|inprogress|waiting|skipped|skip|cancelled|canceled)$/i;

/**
 * Parse plain `gh pr checks <number>` text (tab- or multi-space-separated
 * name / pass-fail-pending / duration / link rows).
 * @param {string} stdout
 * @returns {ReturnType<typeof parsePrCheckItem>[]}
 */
function parsePrChecksText(stdout) {
  const checks = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.includes("\t")
      ? trimmed.split("\t").map((s) => s.trim())
      : trimmed.split(/\s{2,}/).map((s) => s.trim());
    if (cols.length < 2) continue;
    let bucketIdx = -1;
    for (let i = 0; i < cols.length; i++) {
      if (CHECK_TEXT_BUCKET.test(cols[i])) {
        bucketIdx = i;
        break;
      }
    }
    if (bucketIdx <= 0) continue;
    const name = cols.slice(0, bucketIdx).join(" ").trim();
    if (!name) continue;
    const bucket = normalizeCheckBucket(cols[bucketIdx]);
    /** @type {{ name: string, bucket: "pass" | "fail" | "pending" | "skipping" | "cancel", link?: string }} */
    const item = { name, bucket };
    const last = cols[cols.length - 1];
    if (last && /^https?:\/\//i.test(last)) item.link = last;
    checks.push(item);
  }
  return checks;
}

/**
 * Counts per check bucket. Unknown buckets are ignored.
 * @param {{ bucket: string }[]} checks
 * @returns {{ pass: number, fail: number, pending: number, skipping: number, cancel: number }}
 */
function rollupPrChecks(checks) {
  const counts = {
    pass: 0,
    fail: 0,
    pending: 0,
    skipping: 0,
    cancel: 0,
  };
  if (!Array.isArray(checks)) return counts;
  for (const c of checks) {
    const bucket = c && c.bucket;
    if (PR_CHECK_BUCKETS.has(bucket)) counts[bucket] += 1;
  }
  return counts;
}

/**
 * Pull checks from a ghTry result. `gh pr checks` exits 1 when any check
 * failed and 8 when some are pending, so a non-zero exit with parseable
 * stdout is still success.
 * @param {{ ok: boolean, stdout?: string, stderr?: string, combined?: string }} result
 * @param {boolean} preferText
 * @returns {ReturnType<typeof parsePrCheckItem>[] | null}
 */
function extractPrChecks(result, preferText) {
  const out = result && result.stdout != null ? String(result.stdout) : "";
  const trimmed = out.trim();
  if (!preferText && (trimmed.startsWith("[") || trimmed.startsWith("{"))) {
    try {
      return parsePrChecksJson(trimmed);
    } catch {
      // Fall through to the text table (older gh, or JSON mixed with a banner).
    }
  }
  const fromText = parsePrChecksText(trimmed);
  if (fromText.length > 0) return fromText;
  if (preferText || trimmed === "") return fromText;
  try {
    return parsePrChecksJson(trimmed);
  } catch {
    return null;
  }
}

/**
 * CI checks for the thread's current PR. Failures stay in-band so the
 * card can retry: `{ ok: false, reason }` for missing gh, no PR, or auth.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @returns {Promise<{ ok: true, checks: ReturnType<typeof parsePrCheckItem>[] } | { ok: false, reason: string }>}
 */
async function prChecks(opts) {
  const { store, threadId } = opts;
  let cwd;
  let branch;
  let originUrl;
  try {
    const resolved = await resolveThreadGit(store, threadId);
    cwd = resolved.cwd;
    branch = resolved.branch;
    originUrl = resolved.originUrl;
  } catch (err) {
    return {
      ok: false,
      reason: err && err.message ? String(err.message) : "no PR",
    };
  }

  if (!(await isGitHubPrRemote(originUrl))) {
    return { ok: false, reason: "not a GitHub repo" };
  }

  let viewed = await ghApiTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_ENRICHED], {
    timeout: GH_TIMEOUT_MS,
  });
  if (
    !viewed.ok &&
    isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
  ) {
    viewed = await ghApiTryAsync(cwd, ["pr", "view", branch, "--json", PR_JSON_MINIMAL], {
      timeout: GH_TIMEOUT_MS,
    });
  }
  if (!viewed.ok) {
    if (viewed.enoent) return { ok: false, reason: "gh missing" };
    if (isGhAuthFailure(viewed.stderr || viewed.combined || viewed.stdout)) {
      return { ok: false, reason: "auth" };
    }
    if (isNoPrMessage(viewed.stderr || viewed.combined || viewed.stdout)) {
      return { ok: false, reason: "no PR" };
    }
    return {
      ok: false,
      reason: tailErr(viewed.stderr || viewed.combined, "gh pr view failed"),
    };
  }

  let info;
  try {
    info = parsePrJson(viewed.stdout, branch, false);
  } catch (err) {
    return {
      ok: false,
      reason:
        err && err.message
          ? String(err.message)
          : "gh returned unparseable PR JSON",
    };
  }

  let checked = await ghApiTryAsync(cwd, [
    "pr",
    "checks",
    String(info.number),
    "--json",
    "name,state,bucket,link",
  ], { timeout: GH_TIMEOUT_MS });
  let preferText = false;
  if (
    !checked.ok &&
    isChecksJsonRejected(checked.stderr || checked.combined || checked.stdout)
  ) {
    checked = await ghApiTryAsync(cwd, ["pr", "checks", String(info.number)], {
      timeout: GH_TIMEOUT_MS,
    });
    preferText = true;
  }

  if (checked.enoent) return { ok: false, reason: "gh missing" };
  if (isGhAuthFailure(checked.stderr || checked.combined || checked.stdout)) {
    return { ok: false, reason: "auth" };
  }

  const checks = extractPrChecks(checked, preferText);
  if (checks) return { ok: true, checks };

  return {
    ok: false,
    reason: tailErr(
      checked.stderr || checked.combined,
      "gh pr checks failed",
    ),
  };
}

/**
 * Fetch origin (best effort) and merge the PR base into the thread branch.
 * Leaves the worktree conflicted and throws MERGE_CONFLICT: on overlap.
 * Completing a previous conflicted merge (MERGE_HEAD, markers gone) commits
 * it. An empty unique tree vs the base means the work is already landed.
 *
 * Tests set CODER_GH_BIN and skip the network fetch — they advance local
 * main instead. Production always fetches.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.branch
 * @param {object} opts.project
 * @param {string} [opts.baseRefName]
 * @returns {Promise<{ updated: boolean, baseName: string }>}
 */
async function updatePrBranchFromBase(opts) {
  const { cwd, branch, project } = opts;
  const pending = unresolvedFiles(cwd);
  if (pending.length) {
    if (!autoResolveMergeArtifacts(cwd) || unresolvedFiles(cwd).length) {
      throw conflictError(
        "Unresolved conflicts in the worktree:",
        unresolvedFiles(cwd).length ? unresolvedFiles(cwd) : pending,
        "Resolve them in the worktree, then merge again.",
      );
    }
  }

  const mergeHead = await gitTryAsync(cwd, [
    "rev-parse",
    "-q",
    "--verify",
    "MERGE_HEAD",
  ]);
  if (mergeHead.ok) {
    const committed = await gitTryAsync(cwd, [
      "add",
      "-A",
    ]);
    if (!committed.ok) {
      throw new Error(
        `Failed to stage resolved merge: ${tailErr(committed.combined, "git add failed")}`,
      );
    }
    const finished = await gitTryAsync(cwd, [
      "commit",
      "--no-edit",
      "-m",
      `Merge base into ${branch}`,
    ]);
    if (!finished.ok) {
      throw new Error(
        `Failed to finish merge: ${tailErr(finished.combined, "git commit failed")}`,
      );
    }
    return { updated: true, baseName: opts.baseRefName || "main" };
  }

  const status = await gitTryAsync(cwd, ["status", "--porcelain", "-uall"], {
    raw: true,
  });
  if (String(status.stdout || "").trim()) {
    throw new Error(
      "Commit or discard uncommitted changes before merging the PR.",
    );
  }

  // Fake-gh tests must not wait on a network fetch of the dummy origin.
  if (!process.env.CODER_GH_BIN) {
    await gitTryAsync(cwd, ["fetch", "origin"], { timeout: 15_000 });
  }

  let baseName =
    opts.baseRefName && String(opts.baseRefName).trim()
      ? String(opts.baseRefName).trim()
      : "";
  if (!baseName) {
    try {
      baseName = await defaultBranchAsync(project.path);
    } catch {
      baseName = "main";
    }
  }

  const originBase = `origin/${baseName}`;
  const hasOrigin = await gitTryAsync(cwd, ["rev-parse", "--verify", originBase]);
  const hasLocal = await gitTryAsync(cwd, ["rev-parse", "--verify", baseName]);
  const base = hasOrigin.ok ? originBase : hasLocal.ok ? baseName : null;
  if (!base) {
    return { updated: false, baseName };
  }

  const before = await gitOutAsync(cwd, ["rev-parse", "HEAD"]);
  const merged = await gitTryAsync(cwd, [
    "merge",
    "--no-edit",
    "-m",
    `Merge ${baseName} into ${branch}`,
    base,
  ]);
  if (!merged.ok) {
    const files = unmergedFiles(cwd);
    if (autoResolveMergeArtifacts(cwd)) {
      const finished = await gitTryAsync(cwd, [
        "commit",
        "--no-edit",
        "-m",
        `Merge ${baseName} into ${branch}`,
      ]);
      if (!finished.ok) {
        throw new Error(
          `Failed to finish merge: ${tailErr(finished.combined, "git commit failed")}`,
        );
      }
    } else if (files.length) {
      throw conflictError(
        `${branch} conflicts with ${baseName}:`,
        files,
        `${baseName} was merged into the worktree — resolve these files there, then merge again.`,
      );
    } else {
      throw new Error(tailErr(merged.combined, "git merge failed"));
    }
  }

  const treeEq = await gitTryAsync(cwd, ["diff", "--quiet", base, "HEAD"]);
  if (treeEq.ok) {
    throw new Error(
      `This branch has no unique commits vs ${baseName}. The work is already on ${baseName} — close the PR instead of merging.`,
    );
  }

  const after = await gitOutAsync(cwd, ["rev-parse", "HEAD"]);
  return { updated: before !== after, baseName };
}

const MERGE_METHODS = ["squash", "merge", "rebase"];

/**
 * `gh pr merge` flags for a merge method (default squash) and auto-merge.
 * @param {{ method?: unknown, auto?: unknown } | null | undefined} opts
 * @returns {string[]}
 */
function mergeFlags(opts) {
  const method = opts && opts.method != null ? String(opts.method) : "squash";
  if (!MERGE_METHODS.includes(method)) {
    throw new Error(`Unknown merge method: ${method}`);
  }
  return opts && opts.auto === true ? [`--${method}`, "--auto"] : [`--${method}`];
}

/**
 * `--body` override for a squash merge when settings.stripAgentCoauthors is on
 * (#1531); [] otherwise, so GitHub keeps its own message.
 * @param {{ getSettings?: () => { stripAgentCoauthors?: boolean } } | null | undefined} store
 * @param {string} cwd
 * @param {number | string} number
 * @param {{ method?: unknown } | null | undefined} opts
 * @returns {Promise<string[]>}
 */
async function squashBodyArgs(store, cwd, number, opts) {
  const method = opts && opts.method != null ? String(opts.method) : "squash";
  if (method !== "squash") return [];
  const settings = store && typeof store.getSettings === "function" ? store.getSettings() : null;
  if (!settings || settings.stripAgentCoauthors !== true) return [];
  const { strippedSquashBodyArgs } = require("./coauthors.js");
  return strippedSquashBodyArgs(cwd, number, (c, args) =>
    ghTryAsync(c, args, { timeout: GH_TIMEOUT_MS }),
  );
}

const MERGE_OPTIONS_TTL_MS = 10 * 60 * 1000;
/** @type {Map<string, { at: number, value: { ok: true, methods: string[], defaultMethod: string } }>} */
const mergeOptionsCache = new Map();

/**
 * Merge methods the repo allows, and the one to preselect, from
 * `gh repo view --json`. Cached per checkout for MERGE_OPTIONS_TTL_MS;
 * failures stay in-band and are not cached.
 *
 * @param {string} cwd
 * @param {{ runGh?: typeof ghTryAsync, now?: number }} [opts]
 * @returns {Promise<{ ok: true, methods: string[], defaultMethod: string } | { ok: false, reason: string }>}
 */
async function repoMergeOptions(cwd, opts) {
  const now = opts && opts.now != null ? opts.now : Date.now();
  const hit = mergeOptionsCache.get(cwd);
  if (hit && now - hit.at < MERGE_OPTIONS_TTL_MS) return hit.value;
  const runGh = (opts && opts.runGh) || ghTryAsync;
  const viewed = await runGh(
    cwd,
    [
      "repo",
      "view",
      "--json",
      "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod",
    ],
    { timeout: GH_TIMEOUT_MS },
  );
  if (!viewed.ok) {
    return { ok: false, reason: tailErr(viewed.stderr || viewed.combined, "gh repo view failed") };
  }
  let data;
  try {
    data = JSON.parse(viewed.stdout);
  } catch {
    return { ok: false, reason: "gh returned unparseable repo JSON" };
  }
  const allowed = {
    squash: data.squashMergeAllowed !== false,
    merge: data.mergeCommitAllowed !== false,
    rebase: data.rebaseMergeAllowed !== false,
  };
  const methods = MERGE_METHODS.filter((m) => allowed[m]);
  if (methods.length === 0) methods.push("squash");
  const viewerDefault = String(data.viewerDefaultMergeMethod || "").toLowerCase();
  const defaultMethod = methods.includes(viewerDefault)
    ? viewerDefault
    : methods.includes("squash")
      ? "squash"
      : methods[0];
  const value = { ok: /** @type {const} */ (true), methods, defaultMethod };
  mergeOptionsCache.set(cwd, { at: now, value });
  return value;
}

/**
 * repoMergeOptions for a thread's checkout, or a project checkout when
 * projectPath is given. Never throws.
 * @param {{ store: import('./store').Store, threadId?: string, projectPath?: string }} opts
 */
async function mergeOptions(opts) {
  try {
    if (opts.projectPath) {
      // PR list view: no bound thread, just the project checkout.
      const cwd = String(opts.projectPath);
      const remote = await gitTryAsync(cwd, ["remote", "get-url", "origin"]);
      if (!remote.ok || !isGitHubRemote(remote.stdout.trim())) {
        return { ok: false, reason: "not a GitHub repo" };
      }
      return await repoMergeOptions(cwd);
    }
    const { cwd, originUrl } = await resolveThreadGit(opts.store, opts.threadId);
    if (!isGitHubRemote(originUrl)) return { ok: false, reason: "not a GitHub repo" };
    return await repoMergeOptions(cwd);
  } catch (err) {
    return { ok: false, reason: err && err.message ? String(err.message) : "no repo" };
  }
}

/**
 * Merge the thread's current PR via `gh pr merge` (squash unless
 * opts.method says otherwise; `--auto` when opts.auto), then
 * return the refreshed PrInfo. Throws (with gh's own tail) on failure.
 * OPEN PRs are first updated from the base branch (issue #524).
 * CLOSED/MERGED PRs are left to gh; we do not invent a pre-check.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {boolean} [opts.ciWorkflowApproved] explicit human sign-off (#510)
 * @param {"squash" | "merge" | "rebase"} [opts.method] default squash
 * @param {boolean} [opts.auto] `--auto`: GitHub merges once checks pass
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {Promise<Awaited<ReturnType<typeof prStatus>>>}
 */
async function mergePr(opts) {
  const { store, threadId, broadcast } = opts;
  const { cwd, branch, originUrl, project } = await resolveThreadGit(
    store,
    threadId,
  );

  if (!(await isGitHubPrRemote(originUrl))) {
    throw new Error(
      `Remote origin is not a GitHub repository (got: ${originUrl}). Merging a PR requires github.com.`,
    );
  }

  let viewed = await ghApiTryAsync(cwd, [
    "pr",
    "view",
    branch,
    "--json",
    PR_JSON_ENRICHED,
  ]);
  if (
    !viewed.ok &&
    isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
  ) {
    viewed = await ghApiTryAsync(cwd, [
      "pr",
      "view",
      branch,
      "--json",
      PR_JSON_MINIMAL,
    ]);
  }
  if (!viewed.ok) {
    if (viewed.enoent || viewed.timedOut) {
      throwGhFailure(viewed, "gh pr view failed");
    }
    if (isNoPrMessage(viewed.stderr || viewed.combined || viewed.stdout)) {
      throw new Error("No pull request found for this branch");
    }
    throwGhFailure(viewed, "gh pr view failed");
  }

  const info = parsePrJson(viewed.stdout, branch, false);
  const base =
    (info.baseRefName && String(info.baseRefName).trim()) ||
    (await defaultBranchAsync(project.path));
  gateCiWorkflowMerge(
    cwd,
    base,
    false,
    opts.ciWorkflowApproved === true,
  );
  if (info.state === "OPEN") {
    const update = await updatePrBranchFromBase({
      cwd,
      branch,
      project,
      baseRefName: info.baseRefName,
    });
    if (update.updated) {
      scanOutgoingPush(cwd, branch);
      const pushed = await gitTryAsync(cwd, ["push", "-u", "origin", branch], {
        timeout: 30_000,
      });
      if (!pushed.ok) {
        throw new Error(
          tailErr(
            pushed.stderr || pushed.combined,
            `git push failed after updating from ${update.baseName}`,
          ),
        );
      }
    }
  }

  const merged = await ghApiTryAsync(cwd, [
    "pr",
    "merge",
    String(info.number),
    ...mergeFlags(opts),
    ...(await squashBodyArgs(store, cwd, info.number, opts)),
  ]);
  if (!merged.ok) {
    throwGhFailure(merged, "gh pr merge failed");
  }

  const live = await prStatus({ store, threadId });
  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }
  return live;
}

/**
 * True when a thread should be considered for background PR-state refresh:
 * has a prNumber, is not archived, and prState is not already terminal.
 * @param {object} t
 * @returns {boolean}
 */
function isPrRefreshCandidate(t) {
  if (!t || typeof t !== "object") return false;
  if (t.archived) return false;
  if (t.prNumber == null || !Number.isFinite(Number(t.prNumber))) return false;
  const raw =
    t.prState == null || t.prState === ""
      ? null
      : String(t.prState).toUpperCase();
  if (raw && TERMINAL_PR_STATES.has(raw)) return false;
  return true;
}

/**
 * Lazy background PR-state refresh for non-archived threads with a prNumber
 * whose prState is not yet terminal (MERGED/CLOSED).
 *
 * Structural guarantees (docs/ISSUES.md):
 * - gh is ALWAYS async (execFile, never execFileSync) so the main process
 *   cannot freeze the way prStatus once did.
 * - Strictly serialized: one gh at a time (for-await), never parallel.
 * - Hard per-call timeout (~8s) with kill.
 * - Non-GitHub origin, missing gh, network, timeout: skip silently — never
 *   surface an error, never persist a failure.
 * - ONE store.save() and ONE threads:changed push at the end iff anything
 *   actually changed.
 *
 * @param {import('./store').Store} store
 * @param {object} [opts]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {number} [opts.timeoutMs] default PR_REFRESH_TIMEOUT_MS
 * @param {(cwd: string, args: string[], opts?: object) => Promise<object>} [opts.ghTryAsyncFn] test inject
 * @param {typeof import('./github.js').fetchPrStates} [opts.fetchPrStatesFn] test inject
 * @param {{ deliver: (input: { threadId: string, line: string }) => void, isRunning?: (threadId: string) => boolean }} [opts.prWatch]
 *   runner hooks for watch-and-wake (electron/prWatch.js); absent = refresh only
 * @returns {Promise<{ examined: number, changed: number, spawned: number }>}
 */
/**
 * Does this PR state change settle the thread? Mirrors src/threadSettle.ts:
 * CLOSED always, MERGED unless autoSettleOnMerge is off; never a working,
 * pinned, already-settled or "active"-overridden thread.
 * @param {import('./store').Store} store
 * @param {object} prev thread before the change
 * @param {string} nextState
 */
function prFlipSettles(store, prev, nextState) {
  if (nextState !== "MERGED" && nextState !== "CLOSED") return false;
  const settings = store.getSettings ? store.getSettings() : {};
  if (nextState === "MERGED" && settings.autoSettleOnMerge === false) {
    return false;
  }
  const was = String(prev.prState || "").toUpperCase();
  if (was === "MERGED" || was === "CLOSED") return false;
  if (prev.status === "working" || prev.status === "quota-wait") return false;
  if (prev.pinnedAt != null && Number.isFinite(prev.pinnedAt)) return false;
  return prev.settledOverride == null;
}

async function refreshPrStates(store, opts) {
  const broadcast = opts && opts.broadcast;
  const timeoutMs =
    opts && opts.timeoutMs != null ? opts.timeoutMs : PR_REFRESH_TIMEOUT_MS;
  const runGh =
    opts && typeof opts.ghTryAsyncFn === "function"
      ? opts.ghTryAsyncFn
      : ghTryAsync;
  // Watch-and-wake rides this pass instead of a second poller (#1493 D).
  // API path (#1528). A fake gh (injected or CODER_GH_BIN) turns it off unless
  // the test also injects fetchPrStatesFn, so gh-fake suites keep exercising
  // the fallback and never reach the network. CODER_GITHUB_API=0 forces gh.
  const injectedFetch =
    opts && typeof opts.fetchPrStatesFn === "function" ? opts.fetchPrStatesFn : null;
  const fetchStates = injectedFetch || github.fetchPrStates;
  const apiEnabled =
    process.env.CODER_GITHUB_API !== "0" &&
    (injectedFetch != null ||
      (!(opts && opts.ghTryAsyncFn) && !process.env.CODER_GH_BIN));
  const prWatchDeps =
    opts && opts.prWatch && typeof opts.prWatch.deliver === "function"
      ? opts.prWatch
      : null;

  const candidates = store.getThreads().filter(isPrRefreshCandidate);
  if (candidates.length === 0) {
    return { examined: 0, changed: 0, spawned: 0 };
  }

  let changed = 0;
  let spawned = 0;

  // API pre-pass (#1528): one request per repo for every unwatched thread.
  // Watched threads need gh's watch fields, so they keep the per-thread path.
  /** @type {Map<string, { cwd: string, originUrl: string }>} */
  const resolvedById = new Map();
  /** @type {Map<string, { number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED" } | null>} */
  const batched = new Map();
  if (apiEnabled) {
    /** @type {Map<string, { remote: { host: string, owner: string, repo: string }, rows: typeof candidates }>} */
    const groups = new Map();
    for (const snapshot of candidates) {
      if (prWatchDeps && prWatch.isWatched(snapshot)) continue;
      let resolved;
      try {
        resolved = await resolveThreadGit(store, snapshot.id);
      } catch {
        continue;
      }
      resolvedById.set(snapshot.id, resolved);
      const remote = github.parseRemote(resolved.originUrl);
      if (!remote) continue;
      const key = `${remote.host}/${remote.owner}/${remote.repo}`.toLowerCase();
      if (!groups.has(key)) groups.set(key, { remote, rows: [] });
      groups.get(key).rows.push(snapshot);
    }
    // Any host with a token qualifies (GHE); a GitLab origin costs one cached
    // `gh auth token` miss, never a PR call. A failed repo falls back to gh below.
    for (const group of groups.values()) {
      let states;
      try {
        states = await fetchStates(
          group.remote,
          group.rows.map((t) => Number(t.prNumber)),
          { timeoutMs },
        );
      } catch {
        continue;
      }
      for (const t of group.rows) batched.set(t.id, states.get(Number(t.prNumber)) || null);
    }
  }

  // Strict serialization: await each call before starting the next.
  for (const snapshot of candidates) {
    const threadId = snapshot.id;
    try {
      let cwd;
      let originUrl;
      try {
        const resolved =
          resolvedById.get(threadId) || (await resolveThreadGit(store, threadId));
        cwd = resolved.cwd;
        originUrl = resolved.originUrl;
      } catch {
        // Missing project/cwd/branch: not an event. Skip.
        continue;
      }

      let info;
      let watching = false;
      /** @type {any} */
      let viewed = null;
      if (batched.has(threadId)) {
        info = batched.get(threadId);
        // Unresolvable PR: skip, same as a failed gh view.
        if (!info) continue;
      } else {
        if (!isGitHubRemote(originUrl)) {
          // Non-GitHub origin must never paint an error (ISSUES.md). Skip.
          continue;
        }

        const prNumber = Number(snapshot.prNumber);
        const watch = prWatchDeps && prWatch.isWatched(snapshot);
        spawned += 1;
        viewed = await runGh(
          cwd,
          [
            "pr",
            "view",
            String(prNumber),
            "--json",
            watch ? prWatch.PR_WATCH_FIELDS : "number,url,state",
          ],
          { timeout: timeoutMs },
        );
        watching = Boolean(watch);
        if (
          watch &&
          viewed &&
          !viewed.ok &&
          isUnknownJsonField(viewed.stderr || viewed.combined || viewed.stdout)
        ) {
          // Older gh without latestReviews/headRefOid: plain refresh, no watch.
          watching = false;
          viewed = await runGh(
            cwd,
            ["pr", "view", String(prNumber), "--json", "number,url,state"],
            { timeout: timeoutMs },
          );
        }
        if (!viewed || !viewed.ok) {
          // gh missing / network / timeout / no-PR: skip silently.
          continue;
        }

        try {
          info = parsePrJson(viewed.stdout, "", false);
        } catch {
          continue;
        }
      }

      if (watching) {
        const woke = await prWatch.observePr({
          store,
          threadId,
          view: JSON.parse(viewed.stdout),
          cwd,
          runGh,
          deliver: prWatchDeps.deliver,
          isRunning: prWatchDeps.isRunning,
          timeoutMs,
        });
        if (woke) changed += 1;
      }

      const current = store.getThread(threadId);
      if (!current) continue;

      const nextState = info.state;
      const nextUrl = info.url;
      const nextNumber = info.number;
      if (
        current.prState === nextState &&
        current.prUrl === nextUrl &&
        current.prNumber === nextNumber
      ) {
        continue;
      }

      // Do not touch updatedAt: a background PR poll is not user activity.
      store.updateThread(threadId, {
        prNumber: nextNumber,
        prUrl: nextUrl,
        prState: nextState,
      });
      changed += 1;

      if (prFlipSettles(store, current, nextState)) {
        // solenta.json onSettle (#1531). A merge waits for it (bounded by
        // its timeout) because the cleanup below deletes the checkout it
        // runs in; a close does not.
        const ran = require("./projectCommands.js").runOnSettle({
          store,
          threadId,
          broadcast,
        });
        if (nextState === "MERGED") await ran;
      }

      if (nextState === "MERGED") {
        // The PR path used to strand worktree+branch forever (t3 deep-dive).
        // Reclaim now; dirty/unpushed trees are skipped for manual cleanup.
        await maybeCleanupMergedWorktree(store, threadId);
        // Issue #420: arm a delayed re-check. Does not save; this pass does.
        try {
          require("./postmerge.js").onThreadPrState(store, threadId, nextState);
        } catch {
          // scheduling must never fail a PR refresh
        }
      }
    } catch {
      // A refresh failure is not an event. Never throw out of the loop.
      continue;
    }
  }

  if (changed > 0) {
    store.save();
    if (typeof broadcast === "function") {
      const { listThreads } = require("./services.js");
      broadcast("threads:changed", listThreads(store));
    }
  }

  return { examined: candidates.length, changed, spawned };
}

/**
 * Schedule + latch for background PR refresh.
 * - Boolean latch: a tick during a running pass is a no-op (not queued).
 * - Startup pass after startupDelayMs; then every intervalMs.
 * - Timers are unref'd so they do not keep a short-lived process alive.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {number} [opts.intervalMs] default 5 min
 * @param {number} [opts.startupDelayMs] default 30s
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 * @param {typeof refreshPrStates} [opts.refreshFn]
 * @param {object} [opts.refreshOpts] forwarded into refreshFn (timeoutMs, ghTryAsyncFn)
 */
function createPrStateRefresher(opts) {
  const store = opts.store;
  const broadcast = opts.broadcast;
  const intervalMs =
    opts.intervalMs != null ? opts.intervalMs : 5 * 60 * 1000;
  const startupDelayMs =
    opts.startupDelayMs != null ? opts.startupDelayMs : 30_000;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const refreshFn = opts.refreshFn || refreshPrStates;
  const refreshOpts = opts.refreshOpts || {};

  let running = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let startupTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let intervalTimer = null;

  /**
   * @returns {Promise<{ ran: boolean, result?: { examined: number, changed: number, spawned: number } | null }>}
   */
  async function trigger() {
    if (running) return { ran: false };
    running = true;
    try {
      const result = await refreshFn(store, {
        broadcast,
        ...refreshOpts,
      });
      return { ran: true, result };
    } catch {
      // refreshPrStates is failure-silent; this is belt-and-suspenders.
      return { ran: true, result: null };
    } finally {
      running = false;
    }
  }

  function start() {
    if (startupTimer != null || intervalTimer != null) return;
    startupTimer = setTimeoutFn(() => {
      startupTimer = null;
      void trigger();
    }, startupDelayMs);
    if (startupTimer && typeof startupTimer.unref === "function") {
      startupTimer.unref();
    }
    intervalTimer = setIntervalFn(() => {
      void trigger();
    }, intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === "function") {
      intervalTimer.unref();
    }
  }

  function stop() {
    if (startupTimer != null) {
      clearTimeoutFn(startupTimer);
      startupTimer = null;
    }
    if (intervalTimer != null) {
      clearIntervalFn(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    trigger,
    start,
    stop,
    isRunning: () => running,
  };
}

/**
 * Stable prefix of the createPr oversize error (issue #402). The renderer
 * matches on it to offer "split into stacked PRs" / "create anyway"; keep it
 * in sync with PR_TOO_LARGE_PREFIX in src/prUi.ts.
 */
const PR_TOO_LARGE_PREFIX = "PR too large";

/**
 * Sum `git diff --numstat` output. Binary files ("-\t-\tpath") add no lines
 * but still count as files.
 * @param {string} text
 * @returns {{ additions: number, deletions: number, files: number, lines: number }}
 */
function parseNumstat(text) {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files += 1;
    if (m[1] !== "-") additions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }
  return { additions, deletions, files, lines: additions + deletions };
}

/**
 * Changed lines of the thread branch vs the base branch (three-dot diff, the
 * same range a PR would show). Null when git fails: a stat hiccup must never
 * block PR creation — the guardrail fails open, the ahead-check already
 * guarantees there is something to propose.
 * @param {string} cwd
 * @param {string} baseBranch
 * @param {string} branch
 * @returns {Promise<{ additions: number, deletions: number, files: number, lines: number } | null>}
 */
async function diffStatVsBase(cwd, baseBranch, branch) {
  const res = await gitTryAsync(cwd, [
    "diff",
    "--numstat",
    `${baseBranch}...${branch}`,
  ]);
  if (!res.ok) return null;
  return parseNumstat(res.stdout);
}

/**
 * Watch state for a PR this thread just opened: armed with no baseline so
 * the first failing check already wakes it. Empty when the user opted out.
 * @param {{ prWatch?: boolean | null }} thread
 * @param {number} number
 */
function watchStart(thread, number) {
  return prWatch.isWatched(thread)
    ? { prWatchState: prWatch.freshState(number) }
    : {};
}

/**
 * Push the thread branch, open a GitHub PR via gh, persist prNumber/prUrl.
 * Idempotent: an existing PR is returned with created:false.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {boolean} [opts.draft]
 * @param {boolean} [opts.allowOversize] skip the prDiffCapLines guard (#402)
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {Promise<{ number: number, url: string, state: "OPEN" | "CLOSED" | "MERGED", branch: string, created: boolean }>}
 */
async function createPr(opts) {
  const { store, threadId, title, body, draft, broadcast } = opts;

  const { thread, project, cwd, branch, originUrl } = await resolveThreadGit(
    store,
    threadId,
  );

  if (!(await isGitHubPrRemote(originUrl))) {
    throw new Error(
      `Remote origin is not a GitHub repository (got: ${originUrl}). PR creation requires github.com.`,
    );
  }

  const baseBranch =
    recordedBaseBranch(thread) || (await repoDefaultBranchAsync(project.path));
  const ahead = gitTry(cwd, ["log", `${baseBranch}..${branch}`, "--oneline"]);
  if (!ahead.ok) {
    throw new Error(
      `Could not compare branch to ${baseBranch}: ${tailErr(ahead.combined, "git log failed")}`,
    );
  }
  if (!String(ahead.stdout || "").trim()) {
    throw new Error(
      `Branch has no commits ahead of ${baseBranch}; nothing to propose in a pull request`,
    );
  }

  // Review-bottleneck guardrail (issue #402): refuse oversized PRs before
  // anything is pushed. DORA small batches as the product default — the cap
  // comes from settings (default 400 lines); allowOversize is the explicit
  // human override, and a stat failure never blocks creation.
  const settings = store.getSettings ? store.getSettings() : {};
  const cap = settings.prDiffCapLines;
  if (cap != null && !opts.allowOversize) {
    const stats = await diffStatVsBase(cwd, baseBranch, branch);
    if (stats && stats.lines > cap) {
      throw new Error(
        `${PR_TOO_LARGE_PREFIX}: ${stats.lines} lines changed vs ${baseBranch} across ${stats.files} file${stats.files === 1 ? "" : "s"} (cap ${cap}). Split the branch into smaller stacked PRs, or create the PR anyway.`,
      );
    }
  }

  // Reuse push for remote/branch/timeout/prompt discipline; no intermediate broadcast.
  push({ store, threadId });

  // Idempotency: return the existing PR rather than erroring.
  const existing = await ghApiTryAsync(cwd, [
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state",
  ]);
  // Only an OPEN PR short-circuits. gh pr view also returns CLOSED and MERGED
  // ones, and returning those would permanently block opening a follow-up PR
  // from a branch whose first PR was already merged.
  const existingInfo = existing.ok
    ? parsePrJson(existing.stdout, branch, false)
    : null;
  if (existingInfo && existingInfo.state === "OPEN") {
    const info = existingInfo;
    store.updateThread(threadId, {
      prNumber: info.number,
      prUrl: info.url,
      prState: info.state,
    });
    store.save();
    if (typeof broadcast === "function") {
      const { listThreads } = require("./services.js");
      broadcast("threads:changed", listThreads(store));
    }
    return info;
  }
  // A successful view of a CLOSED or MERGED PR is not a failure: it just means
  // there is no CURRENT PR, so fall through and open one. Only classify the
  // error text when the view itself actually failed.
  if (!existing.ok) {
    if (existing.enoent || existing.timedOut) {
      throwGhFailure(existing, "gh pr view failed");
    }
    if (!isNoPrMessage(existing.stderr || existing.combined || existing.stdout)) {
      // Auth / network / other: surface gh's own message (tail-trimmed).
      throwGhFailure(existing, "gh pr view failed");
    }
  }

  const titleText = String(title ?? "");
  const bodyText = body != null ? String(body) : "";
  assertNoOutboundSecrets(`${titleText}\n${bodyText}`, "PR");

  /** @type {string[]} */
  const createArgs = [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    titleText,
    "--body",
    bodyText,
  ];
  if (draft) {
    createArgs.push("--draft");
  }

  const created = await ghApiTryAsync(cwd, createArgs);
  if (!created.ok) {
    // Race: PR appeared between view and create. Prefer idempotent return.
    if (!created.enoent && !created.timedOut) {
      const raced = await ghApiTryAsync(cwd, [
        "pr",
        "view",
        branch,
        "--json",
        "number,url,state",
      ]);
      // Same OPEN filter as the first lookup. Without it a MERGED PR on this
      // branch turns a genuine create failure into a silent success: we would
      // return the old merged PR, swallow gh's error, and stamp the store.
      const racedInfo = raced.ok
        ? parsePrJson(raced.stdout, branch, false)
        : null;
      if (racedInfo && racedInfo.state === "OPEN") {
        const info = racedInfo;
        store.updateThread(threadId, {
          prNumber: info.number,
          prUrl: info.url,
          prState: info.state,
        });
        store.save();
        if (typeof broadcast === "function") {
          const { listThreads } = require("./services.js");
          broadcast("threads:changed", listThreads(store));
        }
        return info;
      }
    }
    throwGhFailure(created, "gh pr create failed");
  }

  // create prints a URL; re-view for number/state so we match PrInfo exactly.
  const viewed = await ghApiTryAsync(cwd, [
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state",
  ]);
  if (!viewed.ok) {
    // Fall back to URL-only parse from create stdout when view is flaky.
    const urlMatch = String(created.stdout || "").match(
      /https:\/\/github\.com\/[^\s]+/i,
    );
    if (urlMatch) {
      const url = urlMatch[0];
      const numMatch = url.match(/\/pull\/(\d+)/i);
      if (numMatch) {
        const info = {
          number: Number(numMatch[1]),
          url,
          state: /** @type {"OPEN"} */ ("OPEN"),
          branch,
          created: true,
        };
        store.updateThread(threadId, {
          prNumber: info.number,
          prUrl: info.url,
          prState: info.state,
          ...watchStart(thread, info.number),
        });
        store.save();
        if (typeof broadcast === "function") {
          const { listThreads } = require("./services.js");
          broadcast("threads:changed", listThreads(store));
        }
        return info;
      }
    }
    throwGhFailure(viewed, "gh pr view failed after create");
  }

  const info = parsePrJson(viewed.stdout, branch, true);
  store.updateThread(threadId, {
    prNumber: info.number,
    prUrl: info.url,
    prState: info.state,
    ...watchStart(thread, info.number),
  });
  store.save();
  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }
  return info;
}

module.exports = {
  PR_REFRESH_TIMEOUT_MS,
  GH_TIMEOUT_MS,
  ghApiTryAsync,
  isGitHubPrRemote,
  setGithubApi,
  isGitHubRemote,
  ghTryAsync,
  parsePrJson,
  PR_LIST_FIELDS,
  PR_LIST_FIELDS_FALLBACK,
  isUnknownJsonField,
  isGhAuthFailure,
  parsePrListJson,
  listPrsRaw,
  listPrs,
  prStatus,
  parsePrChecksJson,
  parsePrChecksText,
  rollupPrChecks,
  prChecks,
  mergePr,
  mergeFlags,
  squashBodyArgs,
  repoMergeOptions,
  mergeOptions,
  isPrRefreshCandidate,
  refreshPrStates,
  createPrStateRefresher,
  PR_TOO_LARGE_PREFIX,
  parseNumstat,
  diffStatVsBase,
  createPr,
};
