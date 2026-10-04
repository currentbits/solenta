"use strict";

// Crew task board and daily / orchestration budget checks.


/* --------------------------------------------------------- crew task list */

/** Caps for the shared task list (issue #277). Mirrors src/shared/ipc.ts. */
const CREW_TASK_TITLE_MAX = 200;
const CREW_TASK_NOTE_MAX = 2000;
const CREW_TASKS_MAX = 100;
const CREW_TASK_ATTEMPT_CAP = 3;
const CREW_AUTO_TURN_CAP = 25;
/** Walk at most this many handoffFrom hops looking for the crew root. */
const CREW_ROOT_HOPS = 20;

/**
 * The crew root of a thread: walk `handoffFrom` up while the thread is an
 * orchWorker, so every worker of one orchestration resolves to the SAME id
 * and therefore to the same shared task list. A plain thread is its own root.
 *
 * Cycle- and depth-guarded; a missing parent stops the walk (the deepest
 * thread we could still resolve wins, never a dangling id).
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @returns {string}
 */
function crewRootOf(store, threadId) {
  let current = store.getThread(threadId);
  if (!current) return String(threadId);
  const seen = new Set([current.id]);
  for (let hop = 0; hop < CREW_ROOT_HOPS; hop++) {
    if (!current.orchWorker || !current.handoffFrom) break;
    const parentId = String(current.handoffFrom);
    if (seen.has(parentId)) break;
    const parent = store.getThread(parentId);
    if (!parent) break;
    seen.add(parentId);
    current = parent;
  }
  return String(current.id);
}

/**
 * A task is claimable only once every id in `needs` is done. Blocked-ness is
 * DERIVED here rather than stored, so completing a task unblocks its
 * dependents with no second write that could go stale (issue #277).
 * An unknown id in `needs` blocks forever — a typo must not silently open.
 *
 * @param {{ needs?: string[] }} task
 * @param {Map<string, { status?: string }>} byId
 * @returns {boolean}
 */
function isBlocked(task, byId) {
  const needs = Array.isArray(task.needs) ? task.needs : [];
  return needs.some((id) => {
    const dep = byId.get(String(id));
    return !dep || dep.status !== "done";
  });
}

/** @param {Array<object>} tasks */
function taskIndex(tasks) {
  return new Map(tasks.map((t) => [String(t.id), t]));
}

/** Tasks with the derived `blocked` flag the UI and the tools both want. */
function withBlocked(tasks) {
  const byId = taskIndex(tasks);
  return tasks.map((t) => ({ ...t, blocked: isBlocked(t, byId) }));
}

/**
 * The crew's shared task list, newest-last, each entry carrying the derived
 * `blocked` flag.
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ rootThreadId: string, tasks: Array<object> }}
 */
function listCrewTasks(store, input) {
  const rootThreadId = crewRootOf(store, input.threadId);
  return { rootThreadId, tasks: withBlocked(store.getCrewTasks(rootThreadId)) };
}

/**
 * Append tasks to the crew's shared list. Ids are assigned here ("t1", "t2",
 * …) and are what agents quote; `needs` may name tasks added in the same
 * call, but an id that matches nothing in the list is rejected — a dependency
 * typo would otherwise block a task forever.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, tasks: Array<{ title?: unknown, needs?: unknown }> }} input
 * @returns {{ rootThreadId: string, tasks: Array<object>, added: string[] }}
 */
function addCrewTasks(store, input) {
  const thread = store.getThread(input.threadId);
  if (!thread) throw new Error(`Unknown thread: ${input.threadId}`);
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const incoming = Array.isArray(input.tasks) ? input.tasks : [];
  if (incoming.length === 0) throw new Error("tasks must not be empty");
  if (list.length + incoming.length > CREW_TASKS_MAX) {
    throw new Error(
      `Crew task list is capped at ${CREW_TASKS_MAX} tasks (has ${list.length}). ` +
        `Complete or drop tasks before adding more.`,
    );
  }

  const now = Date.now();
  let next = 1;
  for (const t of list) {
    const n = Number(String(t.id).replace(/^t/, ""));
    if (Number.isInteger(n) && n >= next) next = n + 1;
  }
  const added = [];
  for (const raw of incoming) {
    const title = String((raw && raw.title) ?? "")
      .trim()
      .slice(0, CREW_TASK_TITLE_MAX);
    if (!title) throw new Error("Task title must not be empty");
    const needs = Array.isArray(raw && raw.needs)
      ? raw.needs.map((n) => String(n).trim()).filter(Boolean)
      : [];
    const id = `t${next++}`;
    list.push({
      id,
      title,
      needs,
      status: "open",
      owner: null,
      note: "",
      attempts: [],
      createdAt: now,
      updatedAt: now,
    });
    added.push(id);
  }

  const byId = taskIndex(list);
  for (const t of list) {
    for (const need of t.needs) {
      if (!byId.has(String(need))) {
        throw new Error(
          `Task ${t.id} needs unknown task "${need}". Known ids: ` +
            `${list.map((x) => x.id).join(", ")}.`,
        );
      }
      if (String(need) === t.id) {
        throw new Error(`Task ${t.id} cannot need itself`);
      }
    }
  }

  store.setCrewTasks(rootThreadId, list);
  store.save();
  return { rootThreadId, tasks: withBlocked(list), added };
}

/**
 * Claim a task for a thread. With no taskId, takes the first open task whose
 * dependencies are all done (self-claim); with one, claims exactly that task.
 *
 * Loop guardrail (issue #277): a task already attempted CREW_TASK_ATTEMPT_CAP
 * times is refused — the crew must escalate instead of grinding. A re-claim
 * below the cap returns `attempts`, which the caller turns into the forced
 * "what failed / am I repeating myself" reflection.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, taskId?: string | null }} input
 * @returns {{ rootThreadId: string, task: object | null, reason?: string, attempts: Array<object> }}
 */
function claimCrewTask(store, input) {
  const thread = store.getThread(input.threadId);
  if (!thread) throw new Error(`Unknown thread: ${input.threadId}`);
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const byId = taskIndex(list);
  const wanted = input.taskId == null ? null : String(input.taskId);

  let task = null;
  if (wanted == null) {
    task =
      list.find(
        (t) => t.status === "open" && !isBlocked(t, byId),
      ) || null;
    if (!task) {
      const blocked = list.filter(
        (t) => t.status === "open" && isBlocked(t, byId),
      ).length;
      return {
        rootThreadId,
        task: null,
        attempts: [],
        reason: blocked
          ? `No claimable task: ${blocked} still waiting on dependencies. ` +
            `Wait for a peer to finish, or work on something else.`
          : "No open tasks left.",
      };
    }
  } else {
    task = byId.get(wanted) || null;
    if (!task) throw new Error(`Unknown task: ${wanted}`);
    if (task.status === "done") {
      return {
        rootThreadId,
        task: null,
        attempts: task.attempts || [],
        reason: `Task ${task.id} is already done: ${task.note || "no note"}`,
      };
    }
    if (task.status === "claimed" && task.owner !== input.threadId) {
      return {
        rootThreadId,
        task: null,
        attempts: task.attempts || [],
        reason: `Task ${task.id} is already claimed by thread ${task.owner}.`,
      };
    }
    if (isBlocked(task, byId)) {
      const pending = task.needs.filter((n) => {
        const dep = byId.get(String(n));
        return !dep || dep.status !== "done";
      });
      return {
        rootThreadId,
        task: null,
        attempts: task.attempts || [],
        reason: `Task ${task.id} is blocked on ${pending.join(", ")}.`,
      };
    }
  }

  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  if (attempts.length >= CREW_TASK_ATTEMPT_CAP) {
    return {
      rootThreadId,
      task: null,
      attempts,
      reason:
        `Task ${task.id} hit the attempt cap (${CREW_TASK_ATTEMPT_CAP} claims). ` +
        `Stop retrying: report what failed each time to the orchestrator and ` +
        `let a human or a different approach take it.`,
    };
  }

  const now = Date.now();
  task.status = "claimed";
  task.owner = String(input.threadId);
  task.attempts = attempts.concat({ threadId: String(input.threadId), at: now });
  task.updatedAt = now;
  store.setCrewTasks(rootThreadId, list);
  store.save();
  // The attempts BEFORE this claim are what a reflection is owed for.
  return { rootThreadId, task: { ...task }, attempts };
}

/**
 * Complete a claimed task and report which tasks that unblocked. `note` is
 * the hand-off: a summary, or a `branch:path` ref a peer reads with
 * `git show` (worktrees share one object store, so no push is needed).
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, taskId: string, note?: unknown }} input
 * @returns {{ rootThreadId: string, task: object, unblocked: Array<object> }}
 */
function completeCrewTask(store, input) {
  const thread = store.getThread(input.threadId);
  if (!thread) throw new Error(`Unknown thread: ${input.threadId}`);
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const byId = taskIndex(list);
  const task = byId.get(String(input.taskId));
  if (!task) throw new Error(`Unknown task: ${input.taskId}`);
  if (task.status === "done") {
    throw new Error(`Task ${task.id} is already done`);
  }
  // The root orchestrator may close anything; a worker only what it holds.
  const isRoot = String(input.threadId) === rootThreadId;
  if (!isRoot && task.owner && task.owner !== String(input.threadId)) {
    throw new Error(
      `Task ${task.id} is claimed by thread ${task.owner}, not by you. ` +
        `Claim it first, or pick another task.`,
    );
  }

  const before = new Set(
    list.filter((t) => t.status === "open" && !isBlocked(t, byId)).map((t) => t.id),
  );
  const now = Date.now();
  task.status = "done";
  task.owner = null;
  task.note = String(input.note ?? "").trim().slice(0, CREW_TASK_NOTE_MAX);
  task.updatedAt = now;

  const after = taskIndex(list);
  const unblocked = list.filter(
    (t) => t.status === "open" && !isBlocked(t, after) && !before.has(t.id),
  );

  store.setCrewTasks(rootThreadId, list);
  store.save();
  return {
    rootThreadId,
    task: { ...task },
    unblocked: unblocked.map((t) => ({ ...t })),
  };
}

/**
 * Give a claimed task back (a worker that gave up, or a failed run). Records
 * the outcome on the attempt so the next claimer sees what already failed.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, taskId?: string | null, outcome?: unknown }} input
 * @returns {Array<object>} the tasks released
 */
function releaseCrewTasks(store, input) {
  const rootThreadId = crewRootOf(store, input.threadId);
  const list = store.getCrewTasks(rootThreadId);
  const owner = String(input.threadId);
  const wanted = input.taskId == null ? null : String(input.taskId);
  const outcome = String(input.outcome ?? "").trim().slice(0, CREW_TASK_NOTE_MAX);
  const released = [];
  for (const task of list) {
    if (task.status !== "claimed" || task.owner !== owner) continue;
    if (wanted != null && task.id !== wanted) continue;
    task.status = "open";
    task.owner = null;
    task.updatedAt = Date.now();
    const attempts = Array.isArray(task.attempts) ? task.attempts : [];
    const last = attempts[attempts.length - 1];
    if (last && last.threadId === owner && outcome) last.outcome = outcome;
    released.push({ ...task });
  }
  if (released.length === 0) return [];
  store.setCrewTasks(rootThreadId, list);
  store.save();
  return released;
}

/**
 * Standing note appended to every dispatched prompt of a thread that holds a
 * crew task (CLI-only, never stored in the transcript). Two jobs:
 *
 * 1. tell the agent what it is holding, so a resumed / compacted session does
 *    not forget its claim;
 * 2. the loop guardrail (issue #277) — when the task was attempted before, or
 *    the thread's last run failed, force the "what failed / am I repeating
 *    myself" reflection BEFORE the retry rather than after the third one.
 *
 * Returns "" when there is nothing to say, same rule as planboardNoteFor /
 * hypothesisNoteFor / specNoteFor.
 *
 * @param {import('./store').Store} store
 * @param {{ id?: string, lastError?: string | null } | null | undefined} thread
 * @returns {string}
 */
function crewTaskNoteFor(store, thread) {
  if (!thread || !thread.id) return "";
  let held;
  try {
    const { tasks } = listCrewTasks(store, { threadId: thread.id });
    held = tasks.filter((t) => t.status === "claimed" && t.owner === thread.id);
  } catch {
    return "";
  }
  if (held.length === 0) return "";
  const lines = held.map((t) => {
    const needs = t.needs.length ? ` (needed ${t.needs.join(", ")})` : "";
    return `- ${t.id}: ${t.title}${needs}`;
  });
  let note =
    "\n\n[Crew task] You hold these tasks from the shared list. " +
    "Call task_complete with a note (a summary, or a `branch:path` another " +
    "worker can read with git show) the moment one lands.\n" +
    lines.join("\n");

  // Prior attempts on a held task, plus this thread's own last failure, are
  // exactly the "am I repeating myself" evidence.
  const priorLines = [];
  for (const t of held) {
    const attempts = Array.isArray(t.attempts) ? t.attempts : [];
    // The current claim is the last attempt; everything before it is history.
    for (const a of attempts.slice(0, -1)) {
      priorLines.push(
        `- ${t.id} was already attempted by thread ${a.threadId}` +
          (a.outcome ? `: ${a.outcome}` : " (no outcome recorded)"),
      );
    }
  }
  const lastError = thread.lastError ? String(thread.lastError).trim() : "";
  if (lastError) priorLines.push(`- your own last run failed: ${lastError}`);
  if (priorLines.length > 0) {
    note +=
      "\n\n[Reflect first] This is a retry, not a fresh start:\n" +
      priorLines.join("\n") +
      "\nBefore you touch anything, say in one or two lines WHAT FAILED and " +
      "whether you are about to repeat it. If the answer is yes, change " +
      "approach or hand the task back with task_release. Record the verdict " +
      `with hypothesis_record. A task is refused after ${CREW_TASK_ATTEMPT_CAP} ` +
      "claims, so this is a limited budget.";
  }
  return note;
}

/**
 * Reject when a daily budget is set and today's spend is already at/over it.
 * Start-time only; does not kill in-flight runs.
 * @param {import('./store').Store} store
 */
function assertUnderDailyBudget(store) {
  const settings = store.getSettings();
  const budget = settings.dailyBudgetUsd;
  if (budget == null) return;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return;
  }
  const spent = store.getSpendToday();
  if (spent >= budget) {
    throw new Error(
      `Daily budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Raise or clear the cap in Settings.`,
    );
  }
}

/**
 * Total lifetime cost (USD) of an orchestration: the orchestrator thread's own
 * usage plus every direct orchWorker forked from it. Nested crews are NOT
 * rolled up — each worker that fans out is its own orchestrator with its own
 * ceiling check.
 * @param {import('./store').Store} store
 * @param {string} threadId orchestrator thread id
 * @returns {number}
 */
function orchestrationSpend(store, threadId) {
  let total = 0;
  const own = store.getUsage(threadId);
  if (own && Number.isFinite(own.costUsd)) total += own.costUsd;
  for (const t of store.getThreads()) {
    if (!t || !t.orchWorker || t.handoffFrom !== threadId) continue;
    const u = store.getUsage(t.id);
    if (u && Number.isFinite(u.costUsd)) total += u.costUsd;
  }
  return total;
}

/**
 * Reject when a per-orchestration ceiling is set and this orchestrator's crew
 * (its own turns plus its workers') has already reached it. Checked at
 * orchestration wake-up time only (issue #67); never kills in-flight runs and
 * never blocks a user-sent turn, so the thread stays resumable via Retry.
 * @param {import('./store').Store} store
 * @param {string} threadId orchestrator thread id
 */
function assertUnderOrchestrationBudget(store, threadId) {
  const settings = store.getSettings();
  const ceiling = settings.orchestrationBudgetUsd;
  if (ceiling == null) return;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) {
    return;
  }
  const spent = orchestrationSpend(store, threadId);
  if (spent >= ceiling) {
    throw new Error(
      `Orchestration budget reached ($${spent.toFixed(2)} of $${ceiling.toFixed(2)} for this thread's crew). Raise or clear the per-orchestration cap in Settings.`,
    );
  }
}

module.exports = {
  CREW_TASK_TITLE_MAX,
  CREW_TASK_NOTE_MAX,
  CREW_TASKS_MAX,
  CREW_TASK_ATTEMPT_CAP,
  CREW_AUTO_TURN_CAP,
  crewRootOf,
  listCrewTasks,
  addCrewTasks,
  claimCrewTask,
  completeCrewTask,
  releaseCrewTasks,
  crewTaskNoteFor,
  assertUnderDailyBudget,
  orchestrationSpend,
  assertUnderOrchestrationBudget,
};
