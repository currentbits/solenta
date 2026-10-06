"use strict";

// PR watch-and-wake (#1493 D). Rides the background PR refresher
// (refreshPrStates): for a watched open PR it notices a failing required
// check, a new changes-requested review, or a merge conflict, and sends the
// thread ONE follow-up turn through runner.deliverNotice. That path queues
// while the thread is working and counts as a machine turn (isAutoTurn), so
// a wake-up can never stand in for the user's approval in orchServer.
//
// Thread fields:
//   prWatch       true | false | null. null = default: on, except threads
//                 made by checkoutPr (someone else's PR), which store false.
//   prWatchState  { pr, wakes, lastWakeAt, lastReason, checks, review,
//                 conflict }: per-PR wake count plus the fingerprints already
//                 reported. Reset when the PR number changes.

/** Most wake-ups per PR before the watch pauses itself. */
const WAKE_CAP = 3;
/** Debounce: no second wake-up for the same PR within this window. */
const WAKE_GAP_MS = 10 * 60 * 1000;
/** Size cap on the failing job log tail put in the turn. */
const LOG_TAIL_CHARS = 4000;
const REVIEW_BODY_CHARS = 1500;
/** `gh pr view --json` fields a watched PR needs on top of number,url,state. */
const PR_WATCH_FIELDS = "number,url,state,mergeable,headRefOid,latestReviews";

/** @param {{ prWatch?: boolean | null } | null | undefined} thread */
function isWatched(thread) {
  return Boolean(thread) && thread.prWatch !== false;
}

/**
 * Fresh state for a PR the app just opened: no baseline, so the first
 * failure already wakes. Threads first seen by the refresher get a silent
 * baseline instead (see observePr), so an upgrade never wakes every old PR.
 * @param {number} pr
 */
function freshState(pr) {
  return {
    pr,
    wakes: 0,
    lastWakeAt: null,
    lastReason: null,
    checks: "",
    review: "",
    conflict: false,
  };
}

/**
 * Failing checks for a PR: required ones, or all of them when the branch
 * marks none required. null when gh could not answer (keep the old baseline).
 * @returns {Promise<Array<{ name: string, link: string }> | null>}
 */
async function failingChecks(cwd, number, runGh, timeout) {
  for (const required of [true, false]) {
    const args = ["pr", "checks", String(number), "--json", "name,bucket,link"];
    if (required) args.push("--required");
    // gh pr checks exits 1 on failures and 8 on pending: read stdout anyway.
    const res = await runGh(cwd, args, { timeout });
    const out = String((res && res.stdout) || "").trim();
    let rows;
    try {
      rows = out.startsWith("[") ? JSON.parse(out) : null;
    } catch {
      rows = null;
    }
    // "no required checks reported" is an error with no JSON: fall back.
    if (!Array.isArray(rows) || (required && rows.length === 0)) continue;
    return rows
      .filter((r) => r && (r.bucket === "fail" || r.bucket === "cancel"))
      .map((r) => ({ name: String(r.name || ""), link: String(r.link || "") }));
  }
  return null;
}

/** Newest CHANGES_REQUESTED review in gh's latestReviews, or null. */
function latestChangesRequested(reviews) {
  let best = null;
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (!r || r.state !== "CHANGES_REQUESTED") continue;
    const at = String(r.submittedAt || "");
    if (!best || at > best.at) {
      best = {
        at,
        author: (r.author && r.author.login) || "a reviewer",
        body: String(r.body || "").trim(),
      };
    }
  }
  return best;
}

/** Last LOG_TAIL_CHARS of `gh run view <id> --log-failed`, or "". */
async function failedLogTail(cwd, checks, runGh, timeout) {
  for (const c of checks) {
    const m = /\/actions\/runs\/(\d+)/.exec(c.link);
    if (!m) continue;
    const res = await runGh(cwd, ["run", "view", m[1], "--log-failed"], {
      timeout,
    });
    const log = String((res && res.stdout) || "").trim();
    if (!log) continue;
    const tail =
      log.length > LOG_TAIL_CHARS ? "…" + log.slice(-LOG_TAIL_CHARS) : log;
    return { runId: m[1], tail };
  }
  return null;
}

/**
 * Compare one refresher sighting of a watched PR with what was already
 * reported and wake the thread when something new needs it. Never throws
 * past its caller's catch; returns true when the thread row changed.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.threadId
 * @param {any} opts.view parsed `gh pr view --json PR_WATCH_FIELDS`
 * @param {string} opts.cwd
 * @param {Function} opts.runGh ghTryAsync-shaped
 * @param {(input: { threadId: string, line: string }) => void} opts.deliver
 * @param {(threadId: string) => boolean} [opts.isRunning]
 * @param {number} [opts.now]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>}
 */
async function observePr(opts) {
  const { store, threadId, view, cwd, runGh, deliver } = opts;
  const now = opts.now != null ? opts.now : Date.now();
  const thread = store.getThread(threadId);
  if (!isWatched(thread) || !view || view.state !== "OPEN") return false;
  const number = Number(view.number);
  const prev =
    thread.prWatchState && thread.prWatchState.pr === number
      ? thread.prWatchState
      : null;

  const checks = await failingChecks(cwd, number, runGh, opts.timeoutMs);
  const review = latestChangesRequested(view.latestReviews);
  const facts = {
    // Head sha in the key: the same job failing again after a push is new.
    checks:
      checks == null
        ? prev
          ? prev.checks
          : ""
        : checks.length
          ? `${view.headRefOid || ""}:${checks.map((c) => c.name).sort().join(",")}`
          : "",
    review: review ? review.at : "",
    conflict: view.mergeable === "CONFLICTING",
  };
  const base = prev || freshState(number);
  const next = { ...base, ...facts };

  if (!prev) {
    // First sighting of a PR the app did not open: baseline, no wake.
    store.updateThread(threadId, { prWatchState: next });
    return true;
  }

  const newChecks = Boolean(facts.checks) && facts.checks !== prev.checks;
  const newReview = Boolean(facts.review) && facts.review !== prev.review;
  const newConflict = facts.conflict && !prev.conflict;
  if (!newChecks && !newReview && !newConflict) {
    if (
      facts.checks === prev.checks &&
      facts.review === prev.review &&
      facts.conflict === prev.conflict
    ) {
      return false;
    }
    store.updateThread(threadId, { prWatchState: next });
    return true;
  }

  // Hold without advancing the fingerprints, so a later pass still wakes:
  // the cap pauses for good (until the user re-arms), the rest just wait.
  if (prev.wakes >= WAKE_CAP) return false;
  if (typeof opts.isRunning === "function" && opts.isRunning(threadId)) {
    return false;
  }
  if (prev.lastWakeAt != null && now - prev.lastWakeAt < WAKE_GAP_MS) {
    return false;
  }

  const reasons = [];
  const lines = [`[pr watch] PR #${number} needs attention.`];
  if (newChecks && checks) {
    reasons.push("checks failed");
    lines.push(
      `- Check${checks.length === 1 ? "" : "s"} failed: ${checks.map((c) => c.name).join(", ")}`,
    );
    const log = await failedLogTail(cwd, checks, runGh, opts.timeoutMs);
    if (log) {
      lines.push(
        `  Log tail (gh run view ${log.runId} --log-failed):`,
        "```",
        log.tail,
        "```",
      );
    }
  }
  if (newReview && review) {
    reasons.push("changes requested");
    const body =
      review.body.length > REVIEW_BODY_CHARS
        ? review.body.slice(0, REVIEW_BODY_CHARS) + "…"
        : review.body;
    lines.push(
      `- @${review.author} requested changes` +
        (body ? `:\n${body.replace(/^/gm, "  > ")}` : ".") +
        `\n  Read the inline comments with: gh pr view ${number} --comments`,
    );
  }
  if (newConflict) {
    reasons.push("merge conflict");
    lines.push(
      "- The PR now conflicts with its base branch. Merge the base in and resolve it.",
    );
  }
  const wakes = prev.wakes + 1;
  lines.push(
    `Fix what you can on this branch and push. This is an automatic follow-up ` +
      `(${wakes} of ${WAKE_CAP} for this PR), not a message from the user.`,
  );

  store.updateThread(threadId, {
    prWatchState: {
      ...next,
      wakes,
      lastWakeAt: now,
      lastReason: reasons.join(", "),
    },
  });
  deliver({ threadId, line: lines.join("\n") });
  return true;
}

module.exports = {
  WAKE_CAP,
  WAKE_GAP_MS,
  LOG_TAIL_CHARS,
  PR_WATCH_FIELDS,
  isWatched,
  freshState,
  failingChecks,
  latestChangesRequested,
  observePr,
};
