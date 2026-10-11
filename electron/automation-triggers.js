"use strict";

/**
 * GitHub event triggers for automations (issue #242). A desktop app has no
 * public URL for webhooks, so each tick polls the project's origin repo over
 * the REST API (token from github.js, same as the PR status poller).
 *
 * Every source returns items with a monotonic `key`. The automation keeps a
 * `triggerCursor`: the highest key already handled. The first poll only sets
 * the baseline so history never fires. New matching items are batched into
 * ONE run; the cursor advances only when that run starts, so events that land
 * while a run is still working are picked up by the next one.
 */

const github = require("./github.js");

const TRIGGER_EVENTS = new Set([
  "pr_opened",
  "pr_merged",
  "pr_labeled",
  "review_submitted",
  "push",
  "ci_completed",
]);

const CI_CONCLUSIONS = new Set(["success", "failure", "cancelled", "timed_out"]);

/** lastError prefix for poll failures, so a good poll clears only its own. */
const POLL_ERROR = "GitHub trigger: ";

/** Events listed in one run's prompt; the rest are counted, not dropped. */
const MAX_EVENTS_IN_PROMPT = 20;

/**
 * Store shape for `automation.trigger`. null means schedule mode.
 * @param {unknown} raw
 * @returns {{ type: "github", event: string, branch: string | null, label: string | null, conclusion: string | null } | null}
 */
function normalizeTrigger(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = /** @type {Record<string, unknown>} */ (raw);
  const event = String(t.event || "");
  if (!TRIGGER_EVENTS.has(event)) return null;
  const str = (v) => {
    const s = v == null ? "" : String(v).trim();
    return s || null;
  };
  const conclusion = str(t.conclusion);
  return {
    type: "github",
    event,
    branch: event === "push" || event === "ci_completed" ? str(t.branch) : null,
    label: event === "pr_labeled" ? str(t.label) : null,
    conclusion:
      event === "ci_completed" && conclusion && CI_CONCLUSIONS.has(conclusion)
        ? conclusion
        : null,
  };
}

/**
 * Validating variant for writes: an unknown event is an error, not "schedule".
 * @param {unknown} raw
 */
function parseTriggerInput(raw) {
  if (raw == null) return null;
  const t = normalizeTrigger(raw);
  if (!t) {
    const ev = raw && typeof raw === "object" ? /** @type {any} */ (raw).event : raw;
    throw new Error(`Unknown trigger event: ${ev || "(empty)"}`);
  }
  return t;
}

/** @param {string} event */
function sourceFor(event) {
  if (event === "pr_opened") return "pulls";
  if (event === "pr_merged" || event === "pr_labeled") return "issueEvents";
  if (event === "ci_completed") return "runs";
  return "events";
}

/**
 * Raw API rows for one source, newest first as GitHub returns them.
 * @param {{ host: string, owner: string, repo: string }} remote
 * @param {string} source
 * @param {(req: object) => Promise<any>} rest
 * @param {string} token
 */
async function fetchSource(remote, source, rest, token) {
  const base = `/repos/${remote.owner}/${remote.repo}`;
  const path =
    source === "pulls"
      ? `${base}/pulls?state=all&sort=created&direction=desc&per_page=30`
      : source === "issueEvents"
        ? `${base}/issues/events?per_page=100`
        : source === "runs"
          ? `${base}/actions/runs?status=completed&per_page=50`
          : `${base}/events?per_page=100`;
  const body = await rest({ host: remote.host, token, method: "GET", path });
  if (source === "runs") return (body && body.workflow_runs) || [];
  return Array.isArray(body) ? body : [];
}

/**
 * Normalized items `{ key, text }` for one trigger, any order. `key` is the
 * cursor value: PR number, event id, or a run's updated_at (ISO strings
 * compare correctly with `>`).
 * @param {{ event: string, branch?: string | null, label?: string | null, conclusion?: string | null }} trigger
 * @param {any[]} rows
 * @param {{ host: string, owner: string, repo: string }} remote
 * @returns {{ all: Array<string | number>, matched: Array<{ key: string | number, text: string }> }}
 */
function matchRows(trigger, rows, remote) {
  const web = `https://${remote.host}/${remote.owner}/${remote.repo}`;
  /** @type {Array<string | number>} */
  const all = [];
  /** @type {Array<{ key: string | number, text: string }>} */
  const matched = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    switch (trigger.event) {
      case "pr_opened": {
        const key = Number(r.number);
        if (!Number.isInteger(key)) continue;
        all.push(key);
        matched.push({
          key,
          text: `PR #${key} opened by ${r.user?.login || "?"}: ${r.title || ""} (${r.html_url || `${web}/pull/${key}`})`,
        });
        break;
      }
      case "pr_merged":
      case "pr_labeled": {
        const key = Number(r.id);
        if (!Number.isFinite(key)) continue;
        all.push(key);
        const n = r.issue?.number;
        const title = r.issue?.title || "";
        const url = r.issue?.html_url || `${web}/issues/${n}`;
        if (trigger.event === "pr_merged") {
          if (r.event !== "merged") continue;
          matched.push({ key, text: `PR #${n} merged: ${title} (${url})` });
        } else {
          if (r.event !== "labeled") continue;
          const name = r.label?.name || "";
          if (trigger.label && name.toLowerCase() !== trigger.label.toLowerCase()) continue;
          const kind = r.issue?.pull_request ? "PR" : "Issue";
          matched.push({ key, text: `${kind} #${n} labeled "${name}": ${title} (${url})` });
        }
        break;
      }
      case "ci_completed": {
        const key = typeof r.updated_at === "string" ? r.updated_at : "";
        if (!key) continue;
        all.push(key);
        if (trigger.branch && r.head_branch !== trigger.branch) continue;
        if (trigger.conclusion && r.conclusion !== trigger.conclusion) continue;
        matched.push({
          key,
          text: `CI "${r.name || "workflow"}" ${r.conclusion || "completed"} on ${r.head_branch || "?"} @ ${String(r.head_sha || "").slice(0, 7)} (${r.html_url || web})`,
        });
        break;
      }
      default: {
        // Activity events API. Payloads were trimmed in 2025; only ids,
        // numbers, refs and states are relied on here.
        const key = Number(r.id);
        if (!Number.isFinite(key)) continue;
        all.push(key);
        const p = r.payload || {};
        if (trigger.event === "push") {
          if (r.type !== "PushEvent") continue;
          const branch = String(p.ref || "").replace(/^refs\/heads\//, "");
          if (trigger.branch && branch !== trigger.branch) continue;
          matched.push({
            key,
            text: `Push to ${branch} by ${r.actor?.login || "?"} @ ${String(p.head || "").slice(0, 7)} (${web}/commits/${branch})`,
          });
        } else {
          if (r.type !== "PullRequestReviewEvent") continue;
          const n = p.pull_request?.number;
          const state = p.review?.state || "submitted";
          matched.push({
            key,
            text: `Review ${state} on PR #${n} by ${r.actor?.login || "?"} (${web}/pull/${n})`,
          });
        }
      }
    }
  }
  return { all, matched };
}

/** @param {Array<string | number>} keys */
function maxKey(keys, fallback) {
  let best = fallback;
  for (const k of keys) if (best == null || k > best) best = k;
  return best;
}

/**
 * Prompt section describing the events that fired this run.
 * @param {string} event
 * @param {{ owner: string, repo: string }} remote
 * @param {Array<{ text: string }>} items oldest first
 */
function formatTriggerNote(event, remote, items) {
  const shown = items.slice(-MAX_EVENTS_IN_PROMPT);
  const lines = [
    `[Trigger] GitHub ${event} on ${remote.owner}/${remote.repo} (${items.length} new event${items.length === 1 ? "" : "s"}):`,
    ...shown.map((i) => `- ${i.text}`),
  ];
  if (items.length > shown.length) {
    lines.push(`(${items.length - shown.length} older events omitted)`);
  }
  return lines.join("\n");
}

/**
 * Resolve the project's origin to a GitHub remote. Null when the project has
 * no origin or the origin is not a GitHub-shaped URL.
 * @param {string} projectPath
 */
async function projectRemote(projectPath) {
  const { gitTryAsync } = require("./worktrees.js");
  const r = await gitTryAsync(projectPath, ["remote", "get-url", "origin"]);
  if (!r.ok) return null;
  return github.parseRemote(String(r.stdout || "").trim());
}

/**
 * Poll every enabled event-triggered automation once and fire the ones with
 * new matching events. One fetch per repo+source per tick, shared across
 * automations. Errors land in lastError; they never count toward the
 * failure breaker (GitHub being down is not the automation failing).
 *
 * @param {{ store: import("./store").Store, fireRun: (auto: object, note: string) => Promise<void>, deps?: { remoteFor?: (p: string) => Promise<any>, rest?: Function, token?: (host: string) => Promise<string | null> } }} ctx
 * @param {Set<string>} firing ids already firing this tick
 */
async function pollTriggers(ctx, firing) {
  const deps = ctx.deps || {};
  const remoteFor = deps.remoteFor || projectRemote;
  const rest = deps.rest || github.rest;
  const tokenFor = deps.token || ((host) => github.githubToken(host));
  /** @type {Map<string, Promise<any[]>>} */
  const cache = new Map();
  const { patchAutomation } = require("./automations.js");
  const { mergeAutomations, canAutoFire } = require("./automations-file.js");

  for (const auto of mergeAutomations(ctx.store, Date.now())) {
    if (!canAutoFire(ctx.store, auto) || !auto.trigger || firing.has(auto.id)) continue;
    // A run is still going: leave the cursor alone so its events batch into
    // the next run instead of piling up parallel ones.
    if (auto.pendingRunThreadId) continue;
    const project = ctx.store.getProject(auto.projectId);
    if (!project || !project.path) continue;
    const trigger = auto.trigger;
    try {
      const remote = await remoteFor(project.path);
      if (!remote) throw new Error("project origin is not a GitHub repo");
      const source = sourceFor(trigger.event);
      const cacheKey = `${remote.host}/${remote.owner}/${remote.repo}|${source}`;
      if (!cache.has(cacheKey)) {
        cache.set(
          cacheKey,
          (async () => {
            const token = await tokenFor(remote.host);
            if (!token) throw new Error(`no token for ${remote.host} (run gh auth login)`);
            return fetchSource(remote, source, rest, token);
          })(),
        );
      }
      const rows = await cache.get(cacheKey);
      const { all, matched } = matchRows(trigger, rows, remote);
      if (auto.lastError && auto.lastError.startsWith(POLL_ERROR)) {
        patchAutomation(ctx.store, auto.id, { lastError: null });
        ctx.store.save();
      }
      const cursor = auto.triggerCursor;
      if (cursor == null) {
        // Baseline: an empty repo starts at the zero of its key type.
        const zero = trigger.event === "ci_completed" ? "" : 0;
        patchAutomation(ctx.store, auto.id, { triggerCursor: maxKey(all, zero) });
        ctx.store.save();
        continue;
      }
      const fresh = matched.filter((m) => m.key > cursor);
      if (fresh.length === 0) continue;
      fresh.sort((a, b) => (a.key > b.key ? 1 : a.key < b.key ? -1 : 0));
      patchAutomation(ctx.store, auto.id, {
        triggerCursor: maxKey(fresh.map((f) => f.key), cursor),
      });
      ctx.store.save();
      firing.add(auto.id);
      try {
        await ctx.fireRun(
          ctx.store.getAutomation(auto.id),
          formatTriggerNote(trigger.event, remote, fresh),
        );
      } finally {
        firing.delete(auto.id);
      }
    } catch (err) {
      const msg = POLL_ERROR + (err && err.message ? String(err.message) : String(err));
      if (auto.lastError !== msg) {
        patchAutomation(ctx.store, auto.id, { lastError: msg });
        ctx.store.save();
      }
    }
  }
}

module.exports = {
  TRIGGER_EVENTS,
  CI_CONCLUSIONS,
  normalizeTrigger,
  parseTriggerInput,
  sourceFor,
  matchRows,
  formatTriggerNote,
  pollTriggers,
};
