"use strict";

const {
  gitTryAsync,
  listPrsRaw,
  PR_LIST_FIELDS_FALLBACK,
} = require("./worktrees.js");

const DEFAULT_DAYS = 90;
const DURABILITY_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// ponytail: blame is per file and explodes on a big repo. Cap files blamed
// and merge-commits examined per collect; upgrade path is one pickaxe
// (`git log -S`) walk or a single blame-per-file inverted sha map.
const BLAME_FILE_CAP = 300;
const BLAME_COMMIT_CAP = 80;

const FLEET_PR_FIELDS =
  "number,title,url,state,headRefName,createdAt,mergedAt,closedAt,additions,deletions,reviews";

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseIsoMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The "felt" half of felt-vs-actual (issue #401): savedMs when the user
 * answered the one-tap estimate, null for declined / never asked / junk.
 *
 * @param {unknown} estimate
 * @returns {number | null}
 */
function feltSavedMsOf(estimate) {
  if (!estimate || typeof estimate !== "object") return null;
  if (estimate.kind !== "saved") return null;
  const ms = Number(estimate.savedMs);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Summed per-run spans, not wall clock. A single-item run contributes 0.
 *
 * @param {Array<{ runId?: string, timestamp?: number }> | null | undefined} items
 * @returns {number}
 */
function activeMsFromWorkLog(items) {
  /** @type {Map<string, { min: number, max: number, n: number }>} */
  const runs = new Map();
  for (const item of items || []) {
    if (!item || !item.runId) continue;
    const ts = item.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    const g = runs.get(item.runId);
    if (!g) {
      runs.set(item.runId, { min: ts, max: ts, n: 1 });
    } else {
      if (ts < g.min) g.min = ts;
      if (ts > g.max) g.max = ts;
      g.n += 1;
    }
  }
  let sum = 0;
  for (const g of runs.values()) {
    if (g.n >= 2) sum += g.max - g.min;
  }
  return sum;
}

/**
 * @param {object | null | undefined} project
 * @returns {string}
 */
function projectSlug(project) {
  if (!project) return "project";
  return project.slug || project.name || project.id || "project";
}

/**
 * @param {unknown} raw
 * @returns {"OPEN" | "CLOSED" | "MERGED"}
 */
function prState(raw) {
  const s = String(raw || "OPEN").toUpperCase();
  if (s === "MERGED") return "MERGED";
  if (s === "CLOSED") return "CLOSED";
  return "OPEN";
}

/**
 * Earliest reviews[].submittedAt. Missing/unparseable reviews → null so
 * the unknown-field fallback cannot crash the view.
 *
 * @param {any} row
 * @returns {number | null}
 */
function firstReviewAtFrom(row) {
  const reviews = row && row.reviews;
  if (!Array.isArray(reviews) || reviews.length === 0) return null;
  let min = null;
  for (const review of reviews) {
    const ms = parseIsoMs(review && review.submittedAt);
    if (ms == null) continue;
    if (min == null || ms < min) min = ms;
  }
  return min;
}

/**
 * @param {any} row
 * @param {string} projectId
 * @param {string | null} threadId
 * @returns {{
 *   projectId: string,
 *   number: number,
 *   url: string,
 *   title: string,
 *   headRefName: string,
 *   state: "OPEN" | "CLOSED" | "MERGED",
 *   createdAt: number,
 *   mergedAt: number | null,
 *   closedAt: number | null,
 *   additions: number,
 *   deletions: number,
 *   firstReviewAt: number | null,
 *   threadId: string | null,
 * } | null}
 */
function normalizePr(row, projectId, threadId) {
  const number = Number(row && row.number);
  const url = row && row.url != null ? String(row.url) : "";
  if (!Number.isFinite(number) || number <= 0 || !url) return null;
  const createdAt = parseIsoMs(row && row.createdAt);
  if (createdAt == null) return null;
  return {
    projectId,
    number,
    url,
    title: row && row.title != null ? String(row.title) : "",
    headRefName: row && row.headRefName != null ? String(row.headRefName) : "",
    state: prState(row && row.state),
    createdAt,
    mergedAt: parseIsoMs(row && row.mergedAt),
    closedAt: parseIsoMs(row && row.closedAt),
    additions: num(row && row.additions),
    deletions: num(row && row.deletions),
    firstReviewAt: firstReviewAtFrom(row),
    threadId,
  };
}

/**
 * @param {string} raw
 * @returns {string}
 */
function resolveNumstatPath(raw) {
  const s = String(raw || "");
  const braced = s.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1");
  if (braced !== s) return braced;
  const idx = s.lastIndexOf(" => ");
  return idx >= 0 ? s.slice(idx + 4) : s;
}

/**
 * @param {string} stdout
 * @returns {{ path: string, added: number }[]}
 */
function parseNumstat(stdout) {
  /** @type {{ path: string, added: number }[]} */
  const files = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = tab1 >= 0 ? line.indexOf("\t", tab1 + 1) : -1;
    if (tab1 < 0 || tab2 < 0) continue;
    const addedRaw = line.slice(0, tab1);
    if (addedRaw === "-") continue;
    const added = Number(addedRaw);
    if (!Number.isFinite(added) || added < 0) continue;
    files.push({
      path: resolveNumstatPath(line.slice(tab2 + 1)),
      added,
    });
  }
  return files;
}

/**
 * @param {string} stdout
 * @returns {{ sha: string, atSec: number, subject: string }[]}
 */
function parseLog(stdout) {
  /** @type {{ sha: string, atSec: number, subject: string }[]} */
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\0");
    if (parts.length < 3) continue;
    const sha = parts[0].trim();
    const atSec = Number(parts[1]);
    const subject = parts.slice(2).join("\0").trim();
    if (!/^[0-9a-f]{40}$/i.test(sha) || !Number.isFinite(atSec)) continue;
    out.push({ sha, atSec, subject });
  }
  return out;
}

/**
 * Count porcelain blame lines whose header sha is `sha`.
 *
 * @param {string} stdout
 * @param {string} sha
 * @returns {number}
 */
function countBlameSurviving(stdout, sha) {
  const needle = String(sha || "").toLowerCase();
  if (needle.length < 40) return 0;
  let n = 0;
  for (const line of String(stdout || "").split("\n")) {
    if (
      line.length >= 41 &&
      line[40] === " " &&
      line.toLowerCase().startsWith(needle)
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * Default PR listing: `--state all --limit 100` plus reviews/dates.
 * Older gh without a field falls back to the short set (firstReviewAt null).
 *
 * @param {object} project
 * @returns {Promise<{ ok: true, prs: any[] } | { ok: false, reason: string }>}
 */
async function defaultListPrs(project) {
  return listPrsRaw(project && project.path, {
    fields: FLEET_PR_FIELDS,
    fallbackFields: PR_LIST_FIELDS_FALLBACK,
    extraArgs: ["--state", "all", "--limit", "100"],
  });
}

/**
 * @param {object | null | undefined} opts
 * @returns {{
 *   collectedAt: number,
 *   durabilityWindowDays: number,
 *   threads: object[],
 *   prs: object[],
 *   notes: string[],
 * }}
 */
function emptyEvidence(opts) {
  return {
    collectedAt: opts && Number.isFinite(opts.nowMs) ? opts.nowMs : 0,
    durabilityWindowDays: DURABILITY_WINDOW_DAYS,
    threads: [],
    prs: [],
    notes: ["fleet: collector failed"],
  };
}

/**
 * @param {object} store
 * @returns {Map<string, object>}
 */
function indexThreadsByBranch(store) {
  /** @type {Map<string, object>} */
  const byBranch = new Map();
  for (const thread of store.getThreads() || []) {
    if (!thread || thread.archived || !thread.branch) continue;
    const key = `${thread.projectId}\0${thread.branch}`;
    const prev = byBranch.get(key);
    if (!prev || num(thread.createdAt) >= num(prev.createdAt)) {
      byBranch.set(key, thread);
    }
  }
  return byBranch;
}

/**
 * @param {{
 *   cwd: string,
 *   sha: string,
 *   gitFn: (cwd: string, args: string[]) => Promise<{ ok?: boolean, stdout?: string }>,
 *   budget: { files: number },
 * }} opts
 * @returns {Promise<{ added: number, surviving: number } | { budget: true } | null>}
 */
async function measureCommit(opts) {
  const { cwd, sha, gitFn, budget } = opts;
  let show;
  try {
    show = await gitFn(cwd, ["show", "--numstat", "--format=", sha]);
  } catch {
    return null;
  }
  if (!show || !show.ok) return null;
  const files = parseNumstat(show.stdout || "");
  const toBlame = files.filter((f) => f.added > 0);
  if (budget.files + toBlame.length > BLAME_FILE_CAP) {
    return { budget: true };
  }
  let added = 0;
  let surviving = 0;
  for (const f of files) added += f.added;
  for (const f of toBlame) {
    budget.files += 1;
    let blame;
    try {
      blame = await gitFn(cwd, [
        "blame",
        "--line-porcelain",
        "HEAD",
        "--",
        f.path,
      ]);
    } catch {
      blame = null;
    }
    if (blame && blame.ok) {
      surviving += countBlameSurviving(blame.stdout || "", sha);
    }
  }
  return { added, surviving };
}

/**
 * Collect raw fleet evidence (issue #375). Facts only — rates live in
 * src/fleet.ts. Never throws: per-project failures land in `notes`.
 *
 * @param {{
 *   store: object,
 *   nowMs: number,
 *   days?: number,
 *   listPrsFn?: (project: object) => Promise<{ ok: true, prs: any[] } | { ok: false, reason: string }>,
 *   gitFn?: (cwd: string, args: string[]) => Promise<{ ok?: boolean, stdout?: string, stderr?: string, combined?: string }>,
 * }} opts
 * @returns {Promise<{
 *   collectedAt: number,
 *   durabilityWindowDays: number,
 *   threads: object[],
 *   prs: object[],
 *   notes: string[],
 * }>}
 */
async function collectFleet(opts) {
  try {
    return await collectFleetInner(opts || {});
  } catch {
    return emptyEvidence(opts);
  }
}

/**
 * @param {{
 *   store: object,
 *   nowMs: number,
 *   days?: number,
 *   listPrsFn?: (project: object) => Promise<{ ok: true, prs: any[] } | { ok: false, reason: string }>,
 *   gitFn?: (cwd: string, args: string[]) => Promise<{ ok?: boolean, stdout?: string }>,
 * }} opts
 */
async function collectFleetInner(opts) {
  const store = opts.store;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : 0;
  const daysRaw = Number(opts.days);
  const days =
    Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : DEFAULT_DAYS;
  const sinceMs = nowMs - days * DAY_MS;
  const listPrsFn = opts.listPrsFn || defaultListPrs;
  const gitFn = opts.gitFn || gitTryAsync;
  const durabilityMs = DURABILITY_WINDOW_DAYS * DAY_MS;

  /** @type {string[]} */
  const notes = [];
  /** @type {object[]} */
  const threads = [];
  /** @type {Map<string, object>} */
  const threadById = new Map();

  for (const thread of (store && store.getThreads && store.getThreads()) || []) {
    if (!thread || thread.archived) continue;
    if (!(typeof thread.createdAt === "number" && thread.createdAt >= sinceMs)) {
      continue;
    }
    const usage =
      store.getUsage && store.getUsage(thread.id) != null
        ? store.getUsage(thread.id)
        : null;
    const workLog =
      store.getWorkLog && store.getWorkLog(thread.id)
        ? store.getWorkLog(thread.id)
        : [];
    const row = {
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title != null ? String(thread.title) : "",
      provider: thread.provider != null ? String(thread.provider) : "",
      model: thread.model != null ? thread.model : null,
      createdAt: thread.createdAt,
      endedAt: thread.updatedAt,
      activeMs: activeMsFromWorkLog(workLog),
      costUsd: usage ? num(usage.costUsd) : 0,
      inputTokens: usage ? num(usage.inputTokens) : 0,
      outputTokens: usage ? num(usage.outputTokens) : 0,
      turns: usage ? num(usage.turns) : 0,
      feltSavedMs: feltSavedMsOf(thread.feltEstimate),
      linesAdded: null,
      linesSurviving: null,
      durabilityMeasurable: false,
    };
    threads.push(row);
    threadById.set(thread.id, row);
  }

  const byBranch = indexThreadsByBranch(store);
  /** @type {object[]} */
  const prs = [];
  const projects =
    (store && store.getProjects && store.getProjects()) || [];

  for (const project of projects) {
    if (!project || project.remoteHost) continue;
    let listed;
    try {
      listed = await listPrsFn(project);
    } catch {
      notes.push(`${projectSlug(project)}: gh failed`);
      continue;
    }
    if (!listed || !listed.ok) {
      const reason =
        listed && listed.reason ? String(listed.reason) : "gh failed";
      notes.push(`${projectSlug(project)}: ${reason}`);
      continue;
    }
    for (const row of listed.prs || []) {
      const head =
        row && row.headRefName != null ? String(row.headRefName) : "";
      const match = head
        ? byBranch.get(`${project.id}\0${head}`)
        : null;
      const fleetPr = normalizePr(
        row,
        project.id,
        match ? match.id : null,
      );
      if (fleetPr) prs.push(fleetPr);
    }
  }

  await measureDurability({
    projects,
    prs,
    threadById,
    gitFn,
    nowMs,
    durabilityMs,
    notes,
  });

  threads.sort((a, b) => b.createdAt - a.createdAt || a.threadId.localeCompare(b.threadId));
  prs.sort((a, b) => b.createdAt - a.createdAt || a.number - b.number);

  return {
    collectedAt: nowMs,
    durabilityWindowDays: DURABILITY_WINDOW_DAYS,
    threads,
    prs,
    notes,
  };
}

/**
 * @param {{
 *   projects: object[],
 *   prs: object[],
 *   threadById: Map<string, object>,
 *   gitFn: (cwd: string, args: string[]) => Promise<{ ok?: boolean, stdout?: string }>,
 *   nowMs: number,
 *   durabilityMs: number,
 *   notes: string[],
 * }} opts
 */
async function measureDurability(opts) {
  const { projects, prs, threadById, gitFn, nowMs, durabilityMs, notes } = opts;
  /** @type {Map<string, { added: number, surviving: number, allOld: boolean }>} */
  const acc = new Map();
  const tainted = new Set();

  /**
   * @param {string} threadId
   * @param {{ added: number, surviving: number, old: boolean }} measured
   */
  function addMeasured(threadId, measured) {
    if (tainted.has(threadId)) return;
    const cur = acc.get(threadId) || {
      added: 0,
      surviving: 0,
      allOld: true,
    };
    cur.added += measured.added;
    cur.surviving += measured.surviving;
    cur.allOld = cur.allOld && measured.old;
    acc.set(threadId, cur);
  }

  /** @param {string} threadId */
  function taint(threadId) {
    tainted.add(threadId);
    acc.delete(threadId);
  }

  for (const project of projects) {
    if (!project || project.remoteHost || !project.path) continue;
    const targets = prs.filter(
      (p) =>
        p.projectId === project.id &&
        p.state === "MERGED" &&
        p.threadId &&
        threadById.has(p.threadId),
    );
    if (targets.length === 0) continue;

    let branchOut;
    try {
      branchOut = await gitFn(project.path, ["branch", "--show-current"]);
    } catch {
      notes.push(`${projectSlug(project)}: git failed`);
      continue;
    }
    const defaultBranch =
      branchOut && branchOut.ok ? String(branchOut.stdout || "").trim() : "";
    if (!defaultBranch) {
      notes.push(`${projectSlug(project)}: git failed`);
      continue;
    }

    let logOut;
    try {
      logOut = await gitFn(project.path, [
        "log",
        defaultBranch,
        "--format=%H%x00%at%x00%s",
      ]);
    } catch {
      notes.push(`${projectSlug(project)}: git failed`);
      continue;
    }
    if (!logOut || !logOut.ok) {
      notes.push(`${projectSlug(project)}: git failed`);
      continue;
    }

    /** @type {Map<number, { sha: string, atSec: number, subject: string }>} */
    const byPrNumber = new Map();
    for (const commit of parseLog(logOut.stdout || "")) {
      const m = commit.subject.match(/\(#(\d+)\)\s*$/);
      if (!m) continue;
      const n = Number(m[1]);
      if (!byPrNumber.has(n)) byPrNumber.set(n, commit);
    }

    targets.sort(
      (a, b) => (a.mergedAt || a.createdAt) - (b.mergedAt || b.createdAt),
    );

    const budget = { files: 0, commits: 0 };
    let unmeasured = 0;

    for (const pr of targets) {
      const commit = byPrNumber.get(pr.number);
      if (!commit) continue;

      if (
        budget.commits >= BLAME_COMMIT_CAP ||
        budget.files >= BLAME_FILE_CAP
      ) {
        unmeasured += 1;
        taint(pr.threadId);
        continue;
      }

      budget.commits += 1;
      const measured = await measureCommit({
        cwd: project.path,
        sha: commit.sha,
        gitFn,
        budget,
      });
      if (measured && "budget" in measured) {
        unmeasured += 1;
        taint(pr.threadId);
        continue;
      }
      if (!measured) continue;
      addMeasured(pr.threadId, {
        added: measured.added,
        surviving: measured.surviving,
        old: nowMs - commit.atSec * 1000 >= durabilityMs,
      });
    }

    if (unmeasured > 0) {
      notes.push(
        `${projectSlug(project)}: blame budget reached, ${unmeasured} commits unmeasured`,
      );
    }
  }

  for (const [threadId, row] of acc) {
    const thread = threadById.get(threadId);
    if (!thread) continue;
    thread.linesAdded = row.added;
    thread.linesSurviving = row.surviving;
    thread.durabilityMeasurable = row.allOld;
  }
}

module.exports = {
  collectFleet,
  BLAME_COMMIT_CAP,
};
