"use strict";

/**
 * Post-merge verification loop (issue #420).
 *
 * When a thread's PR flips to MERGED and it has a verify command, schedule
 * a one-shot re-check hours later against the merged default branch. A
 * failure reopens the planboard issue (or spawns a fix thread). The
 * automations scheduler is the pattern; this is not a user-visible
 * Automation — those mint agent turns on a cadence.
 *
 * Persistence lives on the thread (`postMergeVerify`, `issueNumber`).
 * Callers of schedulePostMergeVerify own durability (same as
 * maybeCleanupMergedWorktree).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** Default delay after merge before the re-check fires. */
const DEFAULT_DELAY_MS = 24 * 60 * 60 * 1000;
const STATUSES = new Set([
  "scheduled",
  "running",
  "passed",
  "failed",
  "skipped",
]);
const ISSUE_PROMPT_RE = /GitHub issue #(\d+)\s*:/i;
// Looser form for the close path only (#632): a fork prompt writes "issue
// #12", not the Planboard start-prompt shape. Requires the word "issue" — a
// bare `#12` is as often a PR or a cross-reference. On the live store 297 of
// 436 thread prompts match this; 173 match ISSUE_PROMPT_RE. Never used for
// the #420 reopen, which must not act on a guessed number.
const LOOSE_ISSUE_RE = /(?:^|[^\w])issues?\s*#(\d+)/i;
/** A "running" check older than this is treated as interrupted. */
const STALE_RUNNING_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const WORKTREE_TIMEOUT_MS = 60_000;

/**
 * Delay before the first fire. Tests set CODER_POSTMERGE_DELAY_MS.
 * @returns {number}
 */
function resolveDelayMs() {
  const raw = process.env.CODER_POSTMERGE_DELAY_MS;
  if (raw == null || raw === "") return DEFAULT_DELAY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DELAY_MS;
  return n;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function normalizeIssueNumber(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * First `GitHub issue #N:` in a start-from-issue prompt.
 * @param {unknown} text
 * @returns {number | null}
 */
function parseIssueNumberFromText(text) {
  const m = String(text || "").match(ISSUE_PROMPT_RE);
  if (!m) return null;
  return normalizeIssueNumber(m[1]);
}

/**
 * Heal / drop a persisted postMergeVerify blob.
 * A crash mid-check leaves status "running"; that becomes scheduled-due.
 *
 * @param {unknown} raw
 * @returns {import("../src/shared/ipc").PostMergeVerify | null}
 */
function normalizePostMerge(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  if (!STATUSES.has(String(rec.status || ""))) return null;
  const dueAt = Number(rec.dueAt);
  if (!Number.isFinite(dueAt)) return null;
  /** @type {import("../src/shared/ipc").PostMergeVerifyStatus} */
  let status = /** @type {any} */ (String(rec.status));
  let nextDue = dueAt;
  if (status === "running") {
    status = "scheduled";
    nextDue = Math.min(dueAt, Date.now());
  }
  const atNum = Number(rec.at);
  return {
    dueAt: nextDue,
    status,
    at: Number.isFinite(atNum) ? atNum : null,
    result: rec.result && typeof rec.result === "object" ? rec.result : null,
    fixThreadId:
      typeof rec.fixThreadId === "string" && rec.fixThreadId
        ? rec.fixThreadId
        : null,
    skipReason: typeof rec.skipReason === "string" ? rec.skipReason : null,
  };
}

/**
 * Issue number stored on the thread, or parsed from the first user prompt.
 * @param {import("./store").Store} store
 * @param {object} thread
 * @returns {number | null}
 */
function issueNumberFromThread(store, thread) {
  const stored = normalizeIssueNumber(thread && thread.issueNumber);
  if (stored) return stored;
  const messages = store.getMessages(thread.id) || [];
  for (const m of messages) {
    if (!m || m.role !== "user") continue;
    const n = parseIssueNumberFromText(m.text);
    if (n) return n;
  }
  return null;
}

/**
 * Loose `issue #N` in the thread's FIRST user message (#632). Only the first
 * message: a later "see issue #83" is context, not what this thread is.
 *
 * @param {import("./store").Store} store
 * @param {object} thread
 * @returns {number | null}
 */
function firstPromptIssueNumber(store, thread) {
  const first = (store.getMessages(thread.id) || []).find(
    (m) => m && m.role === "user",
  );
  if (!first) return null;
  const m = String(first.text || "").match(LOOSE_ISSUE_RE);
  return m ? normalizeIssueNumber(m[1]) : null;
}

/**
 * @param {object | null | undefined} thread
 * @returns {boolean}
 */
function shouldSchedule(thread) {
  if (!thread) return false;
  if (String(thread.prState || "").toUpperCase() !== "MERGED") return false;
  if (typeof thread.verifyCommand !== "string" || !thread.verifyCommand) {
    return false;
  }
  const existing = thread.postMergeVerify;
  if (existing && existing.status) return false;
  return true;
}

/**
 * Arm a delayed re-check. Does not save — callers own durability.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {number} now
 * @param {{ delayMs?: number }} [opts]
 * @returns {object | null} updated thread, or null when nothing was armed
 */
function schedulePostMergeVerify(store, threadId, now, opts) {
  const thread = store.getThread(threadId);
  if (!shouldSchedule(thread)) return null;
  const delay =
    opts && opts.delayMs != null ? Number(opts.delayMs) : resolveDelayMs();
  const dueAt = now + (Number.isFinite(delay) && delay >= 0 ? delay : 0);
  const issueNumber = issueNumberFromThread(store, thread);
  /** @type {import("../src/shared/ipc").PostMergeVerify} */
  const check = {
    dueAt,
    status: "scheduled",
    at: null,
    result: null,
    fixThreadId: null,
  };
  const patch = { postMergeVerify: check };
  if (issueNumber && !thread.issueNumber) patch.issueNumber = issueNumber;
  return store.updateThread(threadId, patch);
}

/**
 * Hook for every writer that stamps prState. No-op unless MERGED.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {unknown} prState
 * @param {number} [now]
 * @returns {object | null}
 */
function onThreadPrState(store, threadId, prState, now) {
  if (String(prState || "").toUpperCase() !== "MERGED") return null;
  void completeThreadIssue(store, threadId).catch(() => {});
  return schedulePostMergeVerify(store, threadId, now == null ? Date.now() : now);
}

/**
 * Issues completed in this process. completeIssue already no-ops on a closed
 * issue, so this only spares a burst of gh calls when the interactive
 * prStatus path re-reports the same MERGED pr.
 * ponytail: in-memory only; a restart re-checks each issue once.
 */
const completedIssues = new Set();

/**
 * Move a landed thread's planboard issue to plan:done and close it (#632).
 *
 * The board only ever moved forward: "Start task" and autodispatch set
 * plan:doing, and nothing wrote the done edge — so finished work sat in
 * Doing until a human noticed. Called fire-and-forget from the two places
 * work actually lands (local merge, PR → MERGED). No linked issue, or an
 * issue that is not plan:doing, means no action.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {{ completeIssue?: Function }} [deps]
 * @returns {Promise<object | null>}
 */
async function completeThreadIssue(store, threadId, deps) {
  const thread = store.getThread(threadId);
  if (!thread) return null;
  const issueNumber =
    issueNumberFromThread(store, thread) ||
    firstPromptIssueNumber(store, thread);
  if (!issueNumber) return null;
  const project = store.getProject(thread.projectId);
  if (!project || !project.path || project.remoteHost) return null;

  const key = `${thread.projectId}:${issueNumber}`;
  if (completedIssues.has(key)) return null;
  completedIssues.add(key);

  const complete =
    (deps && deps.completeIssue) || require("./issues.js").completeIssue;
  const pr = thread.prNumber ? ` (PR #${thread.prNumber})` : "";
  const res = await complete(project.path, issueNumber, {
    comment: `Landed from Solenta thread "${thread.title}"${pr}. Closed on merge.`,
  });
  if (!res || !res.ok) {
    completedIssues.delete(key);
    return res || null;
  }
  if (res.skipped) return res;
  appendEvent(store, thread.id, `Planboard: #${issueNumber} moved to Done.`);
  store.save();
  return res;
}

/**
 * Scheduled checks whose dueAt is at or before now, plus interrupted
 * "running" rows older than STALE_RUNNING_MS (migrateThread already
 * heals those, this is the in-process safety net).
 *
 * @param {import("./store").Store} store
 * @param {number} now
 * @returns {object[]}
 */
function duePostMergeChecks(store, now) {
  return store.getThreads().filter((t) => {
    if (!t || !t.postMergeVerify) return false;
    const check = t.postMergeVerify;
    if (check.status === "scheduled") {
      return typeof check.dueAt === "number" && check.dueAt <= now;
    }
    if (check.status === "running") {
      const started = Number(check.at) || 0;
      return now - started >= STALE_RUNNING_MS;
    }
    return false;
  });
}

/**
 * Resolve a ref that points at the merged default branch.
 * Prefers origin/HEAD, then origin/main, origin/master, then HEAD.
 *
 * @param {string} cwd
 * @param {{ gitTryAsync?: Function }} [deps]
 * @returns {Promise<string>}
 */
async function resolveMergedRef(cwd, deps) {
  const gitTryAsync =
    (deps && deps.gitTryAsync) || require("./worktrees.js").gitTryAsync;
  const refs = ["origin/HEAD", "origin/main", "origin/master", "HEAD"];
  for (const ref of refs) {
    const probed = await gitTryAsync(cwd, ["rev-parse", "--verify", ref]);
    if (probed && probed.ok && String(probed.stdout || "").trim()) return ref;
  }
  return "HEAD";
}

/**
 * Detached worktree at the merged default branch. Caller MUST cleanup.
 * Fetch is best-effort: a local origin/HEAD is enough when offline.
 *
 * @param {object} project
 * @param {{ gitTryAsync?: Function, tmpDir?: string }} [deps]
 * @returns {Promise<{ cwd: string, sha: string | null, cleanup: () => Promise<void> }>}
 */
async function prepareMergedCheckout(project, deps) {
  const gitTryAsync =
    (deps && deps.gitTryAsync) || require("./worktrees.js").gitTryAsync;
  const cwd = String(project.path || "");
  if (!cwd) throw new Error("project has no path");

  await gitTryAsync(cwd, ["fetch", "--quiet", "origin"], {
    timeout: FETCH_TIMEOUT_MS,
  });

  const ref = await resolveMergedRef(cwd, { gitTryAsync });
  const dir = path.join(
    (deps && deps.tmpDir) || os.tmpdir(),
    `solenta-postmerge-${randomUUID()}`,
  );
  const added = await gitTryAsync(
    cwd,
    ["worktree", "add", "--detach", dir, ref],
    { timeout: WORKTREE_TIMEOUT_MS },
  );
  if (!added || !added.ok) {
    const why = added && (added.stderr || added.combined);
    throw new Error(
      why ? String(why).split("\n")[0] : "could not check out merged state",
    );
  }
  let sha = null;
  const rev = await gitTryAsync(dir, ["rev-parse", "HEAD"]);
  if (rev && rev.ok) {
    const trimmed = String(rev.stdout || "").trim();
    sha = trimmed || null;
  }
  return {
    cwd: dir,
    sha,
    cleanup: async () => {
      await gitTryAsync(cwd, ["worktree", "remove", "--force", dir], {
        timeout: 30_000,
      });
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Comment body posted when a planboard issue is reopened.
 *
 * @param {import("../src/shared/ipc").VerifyResult} result
 * @param {{ fixThreadTitle?: string, prNumber?: number | null }} [meta]
 * @returns {string}
 */
function buildReopenComment(result, meta) {
  const why = result.timedOut
    ? `timed out after ${Math.round(result.durationMs / 1000)}s`
    : `exited ${result.exitCode}`;
  const lines = [
    "Post-merge verification failed on the merged default branch.",
    "",
    `Command: ${result.command}`,
    `Result: ${why}`,
  ];
  if (result.sha) lines.push(`HEAD: ${result.sha}`);
  if (meta && meta.prNumber) lines.push(`Merged PR: #${meta.prNumber}`);
  if (meta && meta.fixThreadTitle) {
    lines.push(`Fix thread started in Solenta: ${meta.fixThreadTitle}`);
  }
  lines.push("", "```", result.log || "(no output)", "```");
  return lines.join("\n");
}

/**
 * Spawn a fixer thread with the #296 failure bundle. Does not save.
 *
 * @param {{ store: import("./store").Store, runner?: { startRun: Function }, broadcast?: Function }} ctx
 * @param {object} source
 * @param {import("../src/shared/ipc").VerifyResult} result
 * @param {number | null} issueNumber
 * @returns {Promise<object>}
 */
async function spawnFixThread(ctx, source, result, issueNumber) {
  const services = require("./services.js");
  const { buildFixPrompt } = require("./verify.js");
  const title = String(source.title || "merged thread").startsWith("Regression:")
    ? source.title
    : `Regression: ${source.title}`;
  const thread = services.createThread(ctx.store, {
    projectId: source.projectId,
    title,
    issueNumber,
  });
  ctx.store.updateThread(thread.id, {
    pendingWorktree: true,
    verifyCommand: source.verifyCommand,
    handoffFrom: source.id,
    provider: source.provider,
    model: source.model,
  });
  if (typeof ctx.broadcast === "function") {
    ctx.broadcast("threads:changed", services.listThreads(ctx.store));
  }
  const header = [
    "[post-merge regression] Verification failed on the merged default branch.",
    "This turn is a fix for work that already merged. 'Merged' is not 'worked'.",
    issueNumber ? `Planboard issue: #${issueNumber} (reopened).` : null,
    source.prNumber ? `Merged PR: #${source.prNumber}` : null,
    `Source thread: ${source.title}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
  const prompt = `${header}\n${buildFixPrompt(result)}`;
  if (ctx.runner && typeof ctx.runner.startRun === "function") {
    await ctx.runner.startRun({ threadId: thread.id, prompt });
  }
  return ctx.store.getThread(thread.id) || thread;
}

/**
 * Run one due check. Never throws out to the ticker.
 *
 * @param {{
 *   store: import("./store").Store,
 *   runner?: { startRun: Function },
 *   broadcast?: Function,
 *   prepareCheckout?: typeof prepareMergedCheckout,
 *   runVerify?: Function,
 *   reopenIssue?: Function,
 *   spawnFix?: typeof spawnFixThread,
 * }} ctx
 * @param {object} thread
 * @param {number} now
 */
async function runPostMergeCheck(ctx, thread, now) {
  const store = ctx.store;
  const existing = thread.postMergeVerify || {};
  const mark = (patch) => {
    const next = { ...existing, ...patch };
    store.updateThread(thread.id, { postMergeVerify: next });
    store.save();
    return next;
  };

  mark({ status: "running", at: now });

  const command =
    typeof thread.verifyCommand === "string" ? thread.verifyCommand : null;
  if (!command) {
    mark({
      status: "skipped",
      at: Date.now(),
      skipReason: "verify command cleared",
    });
    return;
  }

  const project = store.getProject(thread.projectId);
  if (!project || !project.path) {
    mark({
      status: "skipped",
      at: Date.now(),
      skipReason: "project missing",
    });
    return;
  }
  if (project.remoteHost) {
    mark({
      status: "skipped",
      at: Date.now(),
      skipReason: "remote project",
    });
    return;
  }

  const prepare = ctx.prepareCheckout || prepareMergedCheckout;
  const runVerify = ctx.runVerify || require("./verify.js").runVerifyCommand;
  let checkout = null;
  /** @type {import("../src/shared/ipc").VerifyResult} */
  let result;
  try {
    checkout = await prepare(project);
    const ran = await runVerify({
      command,
      cwd: checkout.cwd,
      project,
    });
    result = {
      runId: "postmerge",
      command,
      ok: ran.ok,
      exitCode: ran.exitCode,
      timedOut: ran.timedOut,
      log: ran.log,
      sha: checkout.sha || null,
      durationMs: ran.durationMs,
      at: Date.now(),
      attempt: 0,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    mark({
      status: "skipped",
      at: Date.now(),
      skipReason: msg.split("\n")[0].slice(0, 200),
    });
    return;
  } finally {
    if (checkout && typeof checkout.cleanup === "function") {
      try {
        await checkout.cleanup();
      } catch {
        // ignore
      }
    }
  }

  if (result.ok) {
    mark({ status: "passed", at: result.at, result, skipReason: null });
    appendEvent(
      store,
      thread.id,
      `Post-merge verification passed${result.sha ? ` at ${result.sha.slice(0, 7)}` : ""}.`,
    );
    store.save();
    if (typeof ctx.broadcast === "function") {
      const services = require("./services.js");
      ctx.broadcast("threads:changed", services.listThreads(store));
    }
    return;
  }

  const issueNumber = issueNumberFromThread(store, thread);
  let fixThread = null;
  const spawn = ctx.spawnFix || spawnFixThread;
  try {
    fixThread = await spawn(ctx, thread, result, issueNumber);
  } catch {
    fixThread = null;
  }

  if (issueNumber && project.path) {
    const reopen = ctx.reopenIssue || require("./issues.js").reopenIssue;
    try {
      await reopen(project.path, issueNumber, {
        comment: buildReopenComment(result, {
          fixThreadTitle: fixThread ? fixThread.title : undefined,
          prNumber: thread.prNumber,
        }),
      });
    } catch {
      // reopen is best-effort; the fix thread is the durable action
    }
  }

  mark({
    status: "failed",
    at: result.at,
    result,
    fixThreadId: fixThread ? fixThread.id : null,
    skipReason: null,
  });
  const bits = ["Post-merge verification failed."];
  if (issueNumber) bits.push(`Reopened #${issueNumber}.`);
  if (fixThread) bits.push(`Started fix thread "${fixThread.title}".`);
  appendEvent(store, thread.id, bits.join(" "));
  store.save();
  if (typeof ctx.broadcast === "function") {
    const services = require("./services.js");
    ctx.broadcast("threads:changed", services.listThreads(store));
  }
}

/**
 * Event line on the source thread. Uses setMessages so a bookkeeping
 * note does not bump updatedAt the way appendMessage would.
 *
 * @param {import("./store").Store} store
 * @param {string} threadId
 * @param {string} text
 */
function appendEvent(store, threadId, text) {
  const list = (store.getMessages(threadId) || []).slice();
  list.push({
    id: randomUUID(),
    role: "event",
    text,
    createdAt: Date.now(),
  });
  store.setMessages(threadId, list);
}

/**
 * Minute ticker. Finds due post-merge checks and runs them.
 *
 * @param {{
 *   store: import("./store").Store,
 *   runner?: { startRun: Function },
 *   broadcast?: Function,
 *   intervalMs?: number,
 *   now?: () => number,
 *   prepareCheckout?: typeof prepareMergedCheckout,
 *   runVerify?: Function,
 *   reopenIssue?: Function,
 *   spawnFix?: typeof spawnFixThread,
 * }} ctx
 */
function startPostMergeScheduler(ctx) {
  const intervalMs = ctx.intervalMs == null ? 60_000 : ctx.intervalMs;
  const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
  /** @type {Set<string>} */
  const firing = new Set();
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const now = nowFn();
    const due = duePostMergeChecks(ctx.store, now);
    for (const thread of due) {
      if (!thread || !thread.id || firing.has(thread.id)) continue;
      firing.add(thread.id);
      try {
        await runPostMergeCheck(ctx, thread, now);
      } catch {
        // never kill the ticker
      } finally {
        firing.delete(thread.id);
      }
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  return { stop, tick };
}

module.exports = {
  DEFAULT_DELAY_MS,
  STALE_RUNNING_MS,
  resolveDelayMs,
  normalizeIssueNumber,
  parseIssueNumberFromText,
  normalizePostMerge,
  issueNumberFromThread,
  firstPromptIssueNumber,
  shouldSchedule,
  schedulePostMergeVerify,
  onThreadPrState,
  completeThreadIssue,
  duePostMergeChecks,
  resolveMergedRef,
  prepareMergedCheckout,
  buildReopenComment,
  spawnFixThread,
  runPostMergeCheck,
  startPostMergeScheduler,
};
