"use strict";

const fs = require("node:fs");
const {
  defaultBranchAsync,
  gitTryAsync,
  parseShortstat,
} = require("./worktrees.js");
const { isCiWorkflowPath } = require("./blastRadius.js");

const ZERO_STATS = {
  filesChanged: 0,
  additions: 0,
  deletions: 0,
  commits: 0,
  ciWorkflow: false,
};
const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000;
const CHECK_RE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b|\bnpx?\s+(vitest|jest|tsc)\b|\b(pytest|go test|cargo test|make test)\b/;

async function namesTouchCi(cwd, range) {
  try {
    const names = await gitTryAsync(cwd, ["diff", "--name-only", range], {
      raw: true,
    });
    if (!names || !names.ok) return false;
    return String(names.stdout || "")
      .split("\n")
      .some((line) => isCiWorkflowPath(line.trim()));
  } catch {
    return false;
  }
}

/**
 * Git change stats for one digest row. Never throws: any failure is zeros.
 * ponytail: untracked files are not counted — shortstat only sees tracked
 * diffs. `git status --porcelain` if a receipt needs the dirty extras.
 *
 * @param {object} thread
 * @param {object | null} project
 * @returns {Promise<{ filesChanged: number, additions: number, deletions: number, commits: number, ciWorkflow: boolean }>}
 */
async function defaultGitStats(thread, project) {
  try {
    if (!project || project.remoteHost) return { ...ZERO_STATS };
    const cwd = (thread && thread.worktreePath) || project.path;
    if (!cwd || !fs.existsSync(cwd)) return { ...ZERO_STATS };

    if (thread && thread.worktreePath) {
      const base = await defaultBranchAsync(project.path);
      const diff = await gitTryAsync(cwd, ["diff", "--shortstat", base], {
        raw: true,
      });
      const parsed = parseShortstat(diff && diff.stdout);
      const rev = await gitTryAsync(cwd, [
        "rev-list",
        "--count",
        `${base}..HEAD`,
      ]);
      const commits = Number.parseInt(
        String((rev && rev.stdout) || "").trim(),
        10,
      );
      return {
        filesChanged: parsed ? parsed.files : 0,
        additions: parsed ? parsed.additions : 0,
        deletions: parsed ? parsed.deletions : 0,
        commits: Number.isFinite(commits) ? commits : 0,
        ciWorkflow: await namesTouchCi(cwd, base),
      };
    }

    const diff = await gitTryAsync(cwd, ["diff", "--shortstat", "HEAD"], {
      raw: true,
    });
    const parsed = parseShortstat(diff && diff.stdout);
    return {
      filesChanged: parsed ? parsed.files : 0,
      additions: parsed ? parsed.additions : 0,
      deletions: parsed ? parsed.deletions : 0,
      commits: 0,
      ciWorkflow: await namesTouchCi(cwd, "HEAD"),
    };
  } catch {
    return { ...ZERO_STATS };
  }
}

function num(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * ponytail: stands in for the verification stage of issue #296 until that
 * lands. isError is the only failure signal used.
 *
 * @param {object} store
 * @param {string} threadId
 * @param {number} sinceMs
 * @returns {{ ran: boolean, failed: boolean, label: string | null }}
 */
function checksFor(store, threadId, sinceMs) {
  const msgs = store.getMessages(threadId) || [];
  let last = null;
  for (const m of msgs) {
    if (!m || m.role !== "tool") continue;
    if (!(m.createdAt >= sinceMs)) continue;
    const input = m.tool && m.tool.input;
    if (typeof input !== "string") continue;
    const match = input.match(CHECK_RE);
    if (!match) continue;
    last = {
      label: match[0].trim().slice(0, 40) || null,
      failed: m.tool.isError === true,
    };
  }
  if (!last) return { ran: false, failed: false, label: null };
  return { ran: true, failed: last.failed, label: last.label };
}

/**
 * Collect raw evidence for every thread that ran inside an unattended
 * window (issue #323). Facts only — ranking lives in src/digest.ts.
 *
 * @param {{
 *   store: object,
 *   sinceMs?: number,
 *   nowMs: number,
 *   gitStats?: (thread: object, project: object | null) => Promise<{ filesChanged: number, additions: number, deletions: number, commits: number }>,
 * }} opts
 * @returns {Promise<{ sinceMs: number, generatedAt: number, runs: object[] }>}
 */
async function collectDigest(opts) {
  const store = opts.store;
  const nowMs = opts.nowMs;
  const gitStats = opts.gitStats || defaultGitStats;
  const sinceMs =
    opts.sinceMs ?? store.getDigestSeenAt() ?? nowMs - DEFAULT_WINDOW_MS;

  const candidates = [];
  for (const thread of store.getThreads() || []) {
    if (!thread || thread.archived) continue;
    if (!(thread.updatedAt >= sinceMs)) continue;
    // Skip a still-running thread: it has no result yet. One stalled on a
    // permission prompt all night (working + awaitingInput) is exactly what
    // the digest exists to surface.
    if (thread.status === "working" && !thread.awaitingInput) continue;
    candidates.push(thread);
  }

  const runs = await Promise.all(
    candidates.map(async (thread) => {
      const project = store.getProject(thread.projectId);
      let stats = ZERO_STATS;
      try {
        const got = await gitStats(thread, project);
        if (got && typeof got === "object") stats = got;
      } catch {
        stats = ZERO_STATS;
      }
      const usage = store.getUsage(thread.id);
      // ponytail: this is the thread's cumulative session cost, not the
      // window's incremental spend. Per-window deltas land with #296.
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        projectSlug: (project && project.slug) || thread.projectId,
        title: thread.title,
        provider: thread.provider,
        status: thread.status,
        awaitingInput: Boolean(thread.awaitingInput),
        lastError: thread.lastError != null ? thread.lastError : null,
        endedAt: thread.updatedAt,
        costUsd: usage ? num(usage.costUsd) : 0,
        turns: usage ? num(usage.turns) : 0,
        filesChanged: num(stats.filesChanged),
        additions: num(stats.additions),
        deletions: num(stats.deletions),
        commits: num(stats.commits),
        prNumber: thread.prNumber != null ? thread.prNumber : null,
        prState: thread.prState != null ? thread.prState : null,
        ciWorkflow: Boolean(stats.ciWorkflow),
        checks: checksFor(store, thread.id, sinceMs),
      };
    }),
  );

  runs.sort((a, b) => b.endedAt - a.endedAt);
  return { sinceMs, generatedAt: nowMs, runs };
}

module.exports = { collectDigest };
