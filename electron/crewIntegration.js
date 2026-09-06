"use strict";

/**
 * Lead Integration (#954): worker → lead staging with a durable receipt.
 * Does not land on the final target. Does not close GitHub issues (#947).
 */

const fs = require("node:fs");
const {
  gitTry,
  mergeWorktree,
  listChangedPaths,
  recordedBaseBranch,
  repoDefaultBranch,
  isGitHubRemote,
} = require("./worktrees.js");

/**
 * @param {unknown} raw
 * @returns {Array<{ workerId: string, sourceSha: string, leadId: string, leadShaAfter: string, at: number }>}
 */
function normalizeReceipts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const workerId = typeof r.workerId === "string" ? r.workerId.trim() : "";
    const sourceSha = typeof r.sourceSha === "string" ? r.sourceSha.trim() : "";
    const leadId = typeof r.leadId === "string" ? r.leadId.trim() : "";
    if (!workerId || !sourceSha || !leadId) continue;
    out.push({
      workerId,
      sourceSha,
      leadId,
      leadShaAfter:
        typeof r.leadShaAfter === "string" ? r.leadShaAfter.trim() : "",
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
    });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ at: number, sha: string | null, via: "merge" | "pr" } | null}
 */
function normalizeLanded(raw) {
  if (!raw || typeof raw !== "object") return null;
  const via = raw.via === "pr" ? "pr" : "merge";
  return {
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0,
    sha: typeof raw.sha === "string" && raw.sha.trim() ? raw.sha.trim() : null,
    via,
  };
}

/**
 * @param {string | null | undefined} cwd
 * @returns {string | null}
 */
function revParse(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const res = gitTry(cwd, ["rev-parse", "HEAD"]);
  if (!res.ok) return null;
  const sha = String(res.stdout || "").trim();
  return sha || null;
}

/**
 * @param {string | null | undefined} cwd
 * @returns {boolean}
 */
function hasUnmerged(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return false;
  const res = gitTry(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (!res.ok) return false;
  return String(res.stdout || "")
    .split("\n")
    .some((line) => line.trim());
}

/**
 * @param {string | null | undefined} cwd
 * @returns {boolean}
 */
function worktreeLive(cwd) {
  return Boolean(cwd && fs.existsSync(cwd));
}

/**
 * @param {object} store
 * @param {object} lead
 * @param {{ workerId: string, sourceSha: string, leadId: string, leadShaAfter: string, at: number }} receipt
 */
function recordReceipt(store, lead, receipt) {
  const current = store.getThread(lead.id) || lead;
  const existing = normalizeReceipts(current.integrationReceipts);
  const next = existing.filter(
    (r) =>
      !(r.workerId === receipt.workerId && r.sourceSha === receipt.sourceSha),
  );
  next.push(receipt);
  store.updateThread(lead.id, { integrationReceipts: next });
  store.save();
}

/**
 * Squash a finished worker onto the lead's isolated worktree.
 *
 * @param {object} opts
 * @param {import('./store').Store} opts.store
 * @param {string} opts.leadThreadId
 * @param {string} opts.workerThreadId
 * @param {boolean} [opts.ciWorkflowApproved]
 * @param {(channel: string, payload: unknown) => void} [opts.broadcast]
 * @param {(threadId: string) => boolean} [opts.isRunning]
 * @returns {{ noop: boolean, receipt: object, merged: boolean }}
 */
function integrateWorker(opts) {
  const {
    store,
    leadThreadId,
    workerThreadId,
    ciWorkflowApproved,
    broadcast,
    isRunning,
  } = opts;
  const lead = store.getThread(leadThreadId);
  if (!lead) throw new Error(`Unknown lead thread: ${leadThreadId}`);
  const worker = store.getThread(workerThreadId);
  if (!worker) throw new Error(`Unknown worker thread: ${workerThreadId}`);

  if (String(worker.handoffFrom || "") !== String(leadThreadId)) {
    throw new Error(
      `Worker ${workerThreadId} is not this lead's worker (handoffFrom mismatch)`,
    );
  }
  if (worker.status === "working") {
    throw new Error("Worker is still running");
  }
  if (typeof isRunning === "function" && isRunning(worker.id)) {
    throw new Error("Worker is still running");
  }
  if (!worktreeLive(lead.worktreePath)) {
    throw new Error("Set up a lead worktree first");
  }

  const receipts = normalizeReceipts(lead.integrationReceipts);
  const sourceSha = revParse(worker.worktreePath);
  const existing = receipts.find((r) => {
    if (r.workerId !== worker.id) return false;
    if (!sourceSha) return true;
    return r.sourceSha === sourceSha;
  });
  if (existing) {
    return { noop: true, merged: false, receipt: existing };
  }

  if (!worktreeLive(worker.worktreePath)) {
    throw new Error(
      `Worker ${worker.id} has no worktree to integrate; the path is missing and there is no receipt`,
    );
  }
  if (!sourceSha) {
    throw new Error(`Worker ${worker.id} has no source SHA (unknown HEAD)`);
  }

  let recorded = null;
  mergeWorktree({
    store,
    threadId: worker.id,
    intoPath: lead.worktreePath,
    ciWorkflowApproved: ciWorkflowApproved === true,
    broadcast,
    skipIssueComplete: true,
    afterMerge: () => {
      const leadShaAfter = revParse(lead.worktreePath);
      recorded = {
        workerId: worker.id,
        sourceSha,
        leadId: lead.id,
        leadShaAfter: leadShaAfter || "",
        at: Date.now(),
      };
      recordReceipt(store, lead, recorded);
    },
  });

  if (!recorded) {
    const after = store.getThread(lead.id);
    recorded =
      normalizeReceipts(after && after.integrationReceipts).find(
        (r) => r.workerId === worker.id && r.sourceSha === sourceSha,
      ) || {
        workerId: worker.id,
        sourceSha,
        leadId: lead.id,
        leadShaAfter: revParse(lead.worktreePath) || "",
        at: Date.now(),
      };
  }

  return { noop: false, merged: true, receipt: recorded };
}

/**
 * @param {object[]} tasks
 * @param {object} worker
 * @returns {object | null}
 */
function taskForWorker(tasks, worker) {
  const owned = tasks.find((t) => t.owner === worker.id);
  if (owned) return owned;
  const done = tasks.find(
    (t) =>
      t.status === "done" &&
      Array.isArray(t.attempts) &&
      t.attempts.some((a) => a && a.threadId === worker.id),
  );
  if (done) return done;
  const title = String(worker.title || "").trim();
  if (!title) return null;
  return (
    tasks.find((t) => {
      const taskTitle = String(t.title || "").trim();
      return taskTitle && (title === taskTitle || title.includes(taskTitle));
    }) || null
  );
}

/**
 * @param {object} worker
 * @param {object | null} receipt
 * @param {boolean} landed
 * @returns {"running" | "ready" | "conflicted" | "integrated" | "landed" | "missing"}
 */
function deriveState(worker, receipt, landed) {
  if (receipt && landed) return "landed";
  if (receipt) return "integrated";
  if (worker.status === "working") return "running";
  const live = worktreeLive(worker.worktreePath);
  if (live && hasUnmerged(worker.worktreePath)) return "conflicted";
  if (!live) return "missing";
  if (worker.pendingFork) return "running";
  return "ready";
}

/**
 * Snapshot SHA recorded at fork (#948) when present.
 * @param {object} worker
 * @returns {string | null}
 */
function snapshotSha(worker) {
  for (const key of ["leadSnapshotSha", "startSha", "sourceSha"]) {
    const v = worker[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Per-lead integration read model. Includes archived workers.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function crewIntegration(store, input) {
  const threadId = input && input.threadId;
  const lead = store.getThread(threadId);
  if (!lead) throw new Error(`Unknown thread: ${threadId}`);

  const project = store.getProject(lead.projectId);
  const projectPath = project && project.path;
  let finalTarget = recordedBaseBranch(lead);
  if (!finalTarget && projectPath) {
    try {
      finalTarget = repoDefaultBranch(projectPath);
    } catch {
      finalTarget = "main";
    }
  }
  if (!finalTarget) finalTarget = "main";

  const receipts = normalizeReceipts(lead.integrationReceipts);
  const landedRecord = normalizeLanded(lead.integrationLanded);
  const landed = Boolean(landedRecord) || lead.prState === "MERGED";
  const leadLive = worktreeLive(lead.worktreePath);
  const leadHeadSha = leadLive ? revParse(lead.worktreePath) : null;
  const leadBranch =
    (typeof lead.branch === "string" && lead.branch.trim()) ||
    (leadLive
      ? String(
          gitTry(lead.worktreePath, ["branch", "--show-current"]).stdout || "",
        ).trim()
      : "") ||
    null;

  let github = false;
  if (projectPath) {
    const origin = gitTry(projectPath, ["remote", "get-url", "origin"]);
    github = origin.ok && isGitHubRemote(origin.stdout);
  }
  const finalAction =
    github && !lead.prNumber ? "pr" : "merge";

  let tasks = [];
  try {
    const { listCrewTasks } = require("./services.js");
    tasks = listCrewTasks(store, { threadId: lead.id }).tasks || [];
  } catch {
    tasks = [];
  }

  const workers = store
    .getThreads()
    .filter(
      (t) =>
        t &&
        t.id !== lead.id &&
        String(t.handoffFrom || "") === String(lead.id),
    )
    .map((worker) => {
      const receipt =
        receipts.find((r) => r.workerId === worker.id) || null;
      const task = taskForWorker(tasks, worker);
      const state = deriveState(worker, receipt, landed);
      const liveHead = revParse(worker.worktreePath);
      const sourceSha =
        snapshotSha(worker) || liveHead || (receipt && receipt.sourceSha) || null;
      let changedFiles = [];
      if (worktreeLive(worker.worktreePath) && projectPath) {
        const base =
          snapshotSha(worker) ||
          recordedBaseBranch(worker) ||
          finalTarget;
        const listed = listChangedPaths(worker.worktreePath, { base });
        if (listed && listed.ok) changedFiles = listed.paths || [];
      }
      const verify = worker.verify && typeof worker.verify === "object"
        ? worker.verify
        : null;
      return {
        workerId: worker.id,
        title: (task && task.title) || worker.title || worker.id,
        taskId: task ? task.id : null,
        sourceSha,
        changedFiles,
        verify,
        destination: leadBranch || "lead worktree",
        state,
        blocked: Boolean(task && task.blocked),
        needs: task && Array.isArray(task.needs) ? task.needs.slice() : [],
        archived: worker.archived === true,
        worktreePath: worker.worktreePath || null,
        missingReason:
          state === "missing"
            ? "Worker worktree is missing and there is no integrate receipt"
            : null,
      };
    });

  let combinedFiles = [];
  if (leadLive && lead.worktreePath) {
    const listed = listChangedPaths(lead.worktreePath, { base: finalTarget });
    if (listed && listed.ok) combinedFiles = listed.paths || [];
  }

  const verify =
    lead.verify && typeof lead.verify === "object" ? lead.verify : null;
  const verifyStale = Boolean(
    verify &&
      verify.sha &&
      leadHeadSha &&
      String(verify.sha) !== String(leadHeadSha),
  );

  return {
    leadThreadId: lead.id,
    leadBranch,
    leadWorktreePath: lead.worktreePath || null,
    missingLeadWorktree: !leadLive,
    finalTarget,
    finalAction,
    combinedFiles,
    leadHeadSha,
    leadVerify: verify,
    verifyStale,
    landed,
    workers,
    receipts,
  };
}

module.exports = {
  integrateWorker,
  crewIntegration,
  normalizeReceipts,
  normalizeLanded,
};
