"use strict";

// Outbound secret scanning and branch push.

const { scanSecrets } = require("./guardrails.js");
const { gitOut, gitTry } = require("./worktrees-git.js");

/**
 * Push the thread's current branch (worktree if set, else project checkout)
 * to origin with -u.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @returns {{ remote: string, branch: string }}
 */
function push(opts) {
  const { store, threadId, broadcast } = opts;

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
    branch = gitOut(cwd, ["branch", "--show-current"]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    throw new Error(
      `Could not determine current branch: ${msg.split("\n")[0]}`,
    );
  }
  if (!branch) {
    throw new Error(
      "Checkout is detached HEAD or has no branch name; check out a branch before pushing",
    );
  }

  const remote = gitTry(cwd, ["remote", "get-url", "origin"]);
  if (!remote.ok) {
    throw new Error("No git remote configured for this project.");
  }

  scanOutgoingPush(cwd, branch);

  // Never prompt for credentials on the main process; cap wait so a hung
  // remote cannot freeze Electron.
  const result = gitTry(cwd, ["push", "-u", "origin", branch], {
    env: { GIT_TERMINAL_PROMPT: "0" },
    timeout: 30_000,
  });
  if (!result.ok) {
    if (result.timedOut) {
      throw new Error("git push timed out after 30s");
    }
    const errText = (result.stderr || result.combined || "").trim();
    // Last 300 chars (tail), not the head: useful error text is often at the end.
    const tail =
      (errText.length <= 300 ? errText : errText.slice(-300)) ||
      "git push failed";
    throw new Error(tail);
  }

  if (typeof broadcast === "function") {
    const { listThreads } = require("./services.js");
    broadcast("threads:changed", listThreads(store));
  }

  return { remote: "origin", branch };
}

/** Cap scanned outbound text so a huge diff cannot stall the main process. */
const OUTBOUND_SCAN_CAP = 2 * 1024 * 1024;
const OUTBOUND_SCAN_TIMEOUT_MS = 15_000;

/**
 * Hits already carry redacted excerpts (first 8 chars + length). Never add
 * the raw match to this string.
 * @param {Array<{ rule: string, match: string }>} hits
 * @param {string} where
 */
function formatSecretBlock(hits, where) {
  const listed = hits.map((h) => `${h.rule}: ${h.match}`).join(", ");
  return `Blocked by Solenta guardrails: ${hits.length} secret(s) detected in the ${where} (${listed}). Remove them or set CODER_GUARDRAILS=off to override.`;
}

/**
 * Scan text that is about to leave the machine. Throws on hits. Fail-open
 * if the scanner itself throws: a guardrail bug must not brick push/PR/commit.
 * @param {string} text
 * @param {string} where
 */
function assertNoOutboundSecrets(text, where) {
  let result;
  try {
    result = scanSecrets(text);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.warn(
      `solenta: guardrails: scanSecrets failed (${where}); allowing: ${msg}`,
    );
    return;
  }
  if (!result || !Array.isArray(result.hits) || result.hits.length === 0) {
    return;
  }
  throw new Error(formatSecretBlock(result.hits, where));
}

/**
 * Diff of the commits about to be pushed. Prefer origin/<branch>..HEAD;
 * if that ref is missing (first push), fall back to HEAD~1..HEAD, then
 * `git show HEAD`. Returns null when the range cannot be determined.
 * @param {string} cwd
 * @param {string} branch
 * @returns {string | null}
 */
function pushDiffText(cwd, branch) {
  const remoteRef = `origin/${branch}`;
  const haveRemote = gitTry(cwd, ["rev-parse", "--verify", remoteRef], {
    timeout: OUTBOUND_SCAN_TIMEOUT_MS,
  });
  // First push of a branch has no origin/<branch>: scanning HEAD~1..HEAD there
  // would cover one commit out of however many the branch carries, which is
  // worse than not scanning because it reads as covered. Diff from the fork
  // point instead.
  let range = `${remoteRef}..HEAD`;
  if (!haveRemote.ok) {
    const base = gitTry(cwd, ["merge-base", "HEAD", "origin/HEAD"], {
      timeout: OUTBOUND_SCAN_TIMEOUT_MS,
    });
    const sha = base.ok ? String(base.stdout || "").trim() : "";
    range = sha ? `${sha}..HEAD` : "HEAD~1..HEAD";
  }
  let result = gitTry(cwd, ["diff", range], {
    timeout: OUTBOUND_SCAN_TIMEOUT_MS,
  });
  if (!result.ok && !haveRemote.ok) {
    result = gitTry(cwd, ["show", "--format=%B", "HEAD"], {
      timeout: OUTBOUND_SCAN_TIMEOUT_MS,
    });
  }
  if (!result.ok) {
    console.warn(
      `solenta: guardrails: could not determine push diff range (${range}); skipping secret scan`,
    );
    return null;
  }
  const text = String(result.stdout || "");
  if (text.length > OUTBOUND_SCAN_CAP) {
    // ponytail: a secret past 2 MB is not scanned. Say so rather than let the
    // silence read as coverage; stream the diff if that ever matters.
    console.warn(
      `solenta: guardrails: push diff is ${text.length} bytes; only the first ${OUTBOUND_SCAN_CAP} were scanned`,
    );
    return text.slice(0, OUTBOUND_SCAN_CAP);
  }
  return text;
}

/**
 * Secret-scan the outgoing push. Scanner / git errors log and let the push
 * proceed; hits throw on the same Error channel as other push failures.
 * @param {string} cwd
 * @param {string} branch
 */
function scanOutgoingPush(cwd, branch) {
  let text;
  try {
    text = pushDiffText(cwd, branch);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.warn(
      `solenta: guardrails: push diff failed; allowing push: ${msg}`,
    );
    return;
  }
  if (text == null) return;
  assertNoOutboundSecrets(text, "push");
}

module.exports = {
  push,
  assertNoOutboundSecrets,
  scanOutgoingPush,
};
