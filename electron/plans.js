"use strict";

/**
 * Thread plans: an agent's live working plan for its current task, published
 * by writing PLAN_FILE_REL in its checkout root (worktree when bound, else
 * the project checkout). The Planboard renders these next to the
 * GitHub-issue roadmap. Read-only here: agents move steps by rewriting the
 * file, never through the app.
 *
 * Lifetime: a plan follows its thread. Archived threads drop off the board;
 * a removed worktree takes its plan with it. Roadmap-level items belong in
 * GitHub issues (electron/issues.js), which outlive any thread.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Plan file an agent publishes, relative to the thread's checkout root. */
const PLAN_FILE_REL = path.join(".solenta", "plan.json");

/** Caps so a runaway plan file cannot flood the board or the IPC payload. */
const MAX_STEP_TEXT = 200;
const MAX_STEPS = 50;
const MAX_TITLE = 120;

const STEP_STATUSES = new Set(["todo", "doing", "done"]);

/**
 * Parse a plan file's contents. Tolerant: unparseable JSON, a non-object
 * root, or zero usable steps all yield null (the thread simply has no
 * boardable plan); malformed steps are skipped and unknown statuses fall
 * back to "todo".
 *
 * @param {string} raw
 * @returns {{ title: string | null, steps: { text: string, status: string }[] } | null}
 */
function parsePlanJson(raw) {
  let data;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const input = Array.isArray(data.steps) ? data.steps : [];
  const steps = [];
  for (const entry of input) {
    if (steps.length >= MAX_STEPS) break;
    if (!entry || typeof entry !== "object") continue;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    steps.push({
      text: text.slice(0, MAX_STEP_TEXT),
      status: STEP_STATUSES.has(entry.status) ? entry.status : "todo",
    });
  }
  if (steps.length === 0) return null;
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim().slice(0, MAX_TITLE)
      : null;
  return { title, steps };
}

/**
 * Read one checkout root's plan file. Null when the file is absent,
 * unreadable, or has no usable steps.
 *
 * @param {string} root
 * @returns {{ title: string | null, steps: { text: string, status: string }[], updatedMs: number | null } | null}
 */
function readThreadPlan(root) {
  const file = path.join(String(root), PLAN_FILE_REL);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const plan = parsePlanJson(raw);
  if (!plan) return null;
  return { ...plan, updatedMs: stat.mtimeMs || null };
}

/**
 * Live thread plans for one project, newest-updated first. Never throws for
 * file problems — those threads are skipped; an unknown project comes back
 * as `{ ok: false, reason }`. Threads sharing one root (no worktree) dedupe
 * to the first thread, so one shared plan file never renders twice.
 *
 * @param {import('./store').Store} store
 * @param {unknown} projectId
 * @returns {{ ok: true, plans: object[] } | { ok: false, reason: string }}
 */
function listPlans(store, projectId) {
  const id = String(projectId || "");
  const project = id ? store.getProject(id) : null;
  if (!project) return { ok: false, reason: "Unknown project" };

  const seenRoots = new Set();
  const plans = [];
  for (const thread of store.getThreads()) {
    if (!thread || thread.projectId !== project.id || thread.archived) {
      continue;
    }
    const root = thread.worktreePath || project.path;
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    const plan = readThreadPlan(root);
    if (!plan) continue;
    plans.push({
      threadId: thread.id,
      threadTitle: thread.title || "Untitled thread",
      title: plan.title,
      steps: plan.steps,
      updatedMs: plan.updatedMs,
    });
  }
  plans.sort((a, b) => (b.updatedMs || 0) - (a.updatedMs || 0));
  return { ok: true, plans };
}

module.exports = {
  PLAN_FILE_REL,
  parsePlanJson,
  listPlans,
};
