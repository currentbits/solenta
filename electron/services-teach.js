"use strict";

// Teach mode, ask mode, and the thread goal.

const {
  getProvider,
  honouredPermissionModes,
  snapPermissionMode,
} = require("./providers.js");
const { canHostWorktree } = require("./services-shared.js");

/* --------------------------------------------------------------- teach mode */

/** Passed-review counts that promote autonomy (issue #373). Mirror src/shared/ipc.ts. */
const TEACH_REVIEW_THRESHOLDS = { review: 3, pair: 8 };

/** What the standing note says at each autonomy rung. */
const TEACH_AUTONOMY_COPY = {
  hint:
    "leave TODO(human) for every interesting piece of logic; scaffold only",
  review:
    "you may fill more scaffolding; still leave the core logic as TODO(human)",
  pair:
    "you may implement more of the glue, still explain, and leave at least " +
    "one meaningful TODO(human) per turn unless the human asked for the solution",
};

const TEACH_REVIEW_PROMPT =
  "The human filled the TODO(human) markers. Review their code now. " +
  "Praise what is right, point at what is wrong, and do not rewrite the " +
  "solution unless they asked. Then call the coder-threads tool teach_review " +
  "with passed true or false and a short note.";

/** Passed-review count → autonomy rung. */
function teachAutonomyFor(reviewsPassed) {
  const n = Number(reviewsPassed) || 0;
  if (n >= TEACH_REVIEW_THRESHOLDS.pair) return "pair";
  if (n >= TEACH_REVIEW_THRESHOLDS.review) return "review";
  return "hint";
}

/**
 * Permission modes allowed at this autonomy rung.
 * hint: ask / plan. review: + accept edits. pair: full access too.
 * @param {string} autonomy
 * @returns {string[]}
 */
function teachAllowedModes(autonomy) {
  if (autonomy === "pair") {
    return ["default", "acceptEdits", "plan", "bypassPermissions"];
  }
  if (autonomy === "review") return ["default", "acceptEdits", "plan"];
  return ["default", "plan"];
}

/**
 * @param {string} mode
 * @param {{ autonomy?: string } | null | undefined} teach
 */
function teachPermissionAllowed(mode, teach) {
  if (!teach || !teach.autonomy) return true;
  return teachAllowedModes(teach.autonomy).includes(String(mode));
}

/**
 * Nearest mode this provider actually honours, still inside the teach cap.
 * Prefer default then plan so claude Full access still drops to Ask first.
 * Empty intersection (kimi at hint) keeps the honoured mode rather than
 * storing Ask first, which the CLI cannot send (issue #177).
 *
 * @param {object | null | undefined} entry
 * @param {string | null | undefined} mode
 * @param {{ autonomy?: string } | null | undefined} teach
 */
function snapPermissionModeForThread(entry, mode, teach) {
  const snapped = snapPermissionMode(entry, mode);
  if (teachPermissionAllowed(snapped, teach)) return snapped;
  const teachOk = honouredPermissionModes(entry).filter((m) =>
    teachPermissionAllowed(m, teach),
  );
  for (const preferred of [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
  ]) {
    if (teachOk.includes(preferred)) return preferred;
  }
  return snapped;
}

/**
 * Standing note appended to every dispatched prompt while Teach mode is on.
 * Same rule as specNoteFor: returns "" when there is nothing to say.
 *
 * @param {{ teach?: { autonomy?: string, reviewsPassed?: number } | null } | null | undefined} thread
 * @returns {string}
 */
function teachNoteFor(thread) {
  const teach = thread && thread.teach;
  if (!teach || !teach.autonomy) return "";
  const reviewsPassed = Number(teach.reviewsPassed) || 0;
  const level = teachAutonomyFor(reviewsPassed);
  const how = TEACH_AUTONOMY_COPY[level] || TEACH_AUTONOMY_COPY.hint;
  return (
    "\n\n[Teach mode] You are a teacher, not a solution engine. " +
    "Socratic: ask questions and give hints; do not dump a complete implementation. " +
    "Scaffold structure and types, then leave TODO(human) markers on the " +
    "interesting logic for the human to write. After they fill a marker, review " +
    "their code: say what is right, point at what is wrong, and do not rewrite " +
    "it unless they explicitly ask for the answer. Never replace a TODO(human) " +
    "with the solution on your own. " +
    `Autonomy: ${level} (${how}). ` +
    "When you have reviewed a fill, call the coder-threads tool teach_review " +
    "with passed true or false."
  );
}

/**
 * Turn Teach mode on at the hint rung. Idempotent. Downgrades permission
 * mode when the current one is above the hint cap. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function startTeach(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.teach && thread.teach.autonomy) return { ...thread };
  const teach = { autonomy: "hint", reviewsPassed: 0 };
  /** @type {{ teach: { autonomy: string, reviewsPassed: number }, permissionMode?: string, ask?: boolean }} */
  const patch = { teach };
  if (thread.ask === true) patch.ask = false;
  // Always snap: leftover grok/cursor Ask first is teach-allowed as a label
  // but the CLI cannot send it, so it would keep remapping to Full access.
  patch.permissionMode = snapPermissionModeForThread(
    getProvider(thread.provider),
    thread.permissionMode,
    teach,
  );
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Turn Teach mode off. Leaves permission mode where it is. Idempotent.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function stopTeach(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.teach) return { ...thread };
  const updated = store.updateThread(threadId, { teach: null });
  store.save();
  return updated ? { ...updated } : { ...thread, teach: null };
}

/**
 * Standing note while Ask mode is on. Delegates to electron/ask.js so the
 * wording lives next to the completion prompt (issue #392).
 *
 * @param {{ ask?: boolean } | null | undefined} thread
 * @returns {string}
 */
function askNoteFor(thread) {
  return require("./ask.js").askNoteFor(thread);
}

/**
 * Turn Ask mode on (issue #392). Idempotent. Clears teach (the personas
 * conflict), drops pendingWorktree so the first send cannot materialize
 * one, and leaves an already-created worktree on disk unused. Never bumps
 * updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function startAsk(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.ask === true && !thread.pendingWorktree && !thread.teach) {
    return { ...thread };
  }
  /** @type {{ ask: boolean, pendingWorktree?: boolean, teach?: null }} */
  const patch = { ask: true };
  if (thread.pendingWorktree) patch.pendingWorktree = false;
  if (thread.teach) patch.teach = null;
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Turn Ask mode off. With `worktree: true` (Start work + defaultWorktree)
 * the thread becomes a regular isolated thread: pendingWorktree is armed
 * only when the project can host one and none exists yet. Idempotent.
 * Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, worktree?: boolean }} input
 */
function stopAsk(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.ask !== true && !input?.worktree) return { ...thread };
  /** @type {{ ask: boolean, pendingWorktree?: boolean }} */
  const patch = { ask: false };
  if (
    input &&
    input.worktree === true &&
    !thread.worktreePath &&
    !thread.pendingWorktree
  ) {
    const project = store.getProject(thread.projectId);
    if (canHostWorktree(project)) patch.pendingWorktree = true;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Record a review of the human's TODO(human) fill. A pass increments
 * reviewsPassed and may promote autonomy. Called by the coder-threads
 * MCP tool `teach_review`, never inferred from the transcript.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, passed?: boolean, note?: string }} input
 * @returns {{ reviewsPassed: number, autonomy: string, promoted: boolean, passed: boolean }}
 */
function recordTeachReview(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.teach || !thread.teach.autonomy) {
    throw new Error("Thread is not in teach mode");
  }
  const passed = input && input.passed === true;
  const prev = Number(thread.teach.reviewsPassed) || 0;
  const reviewsPassed = passed ? prev + 1 : prev;
  const autonomy = teachAutonomyFor(reviewsPassed);
  const promoted = autonomy !== thread.teach.autonomy;
  const teach = { autonomy, reviewsPassed };
  store.updateThread(threadId, { teach });
  store.save();
  return { reviewsPassed, autonomy, promoted, passed };
}

/**
 * The prompt that asks the agent to review the human's fills.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ thread: object, prompt: string }}
 */
function requestTeachReview(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.teach || !thread.teach.autonomy) {
    throw new Error("Thread is not in teach mode");
  }
  return { thread: { ...thread }, prompt: TEACH_REVIEW_PROMPT };
}

/* --------------------------------------------------------------------- goal */

/** Providers with a native goal (Codex app-server thread/goal/*, #1531). */
const NATIVE_GOAL_PROVIDERS = new Set(["codex"]);

const GOAL_MAX_CHARS = 4000;

/**
 * Standing note for a thread goal on providers without a native one.
 * Codex gets thread/goal/set instead (electron/codex-appserver.js), and a
 * finished goal stops steering the agent.
 *
 * @param {{ provider?: string, goal?: { objective?: string, status?: string } | null } | null | undefined} thread
 * @returns {string}
 */
function goalNoteFor(thread) {
  const goal = thread && thread.goal;
  if (!goal || !goal.objective || goal.status === "complete") return "";
  if (NATIVE_GOAL_PROVIDERS.has(String(thread.provider || ""))) return "";
  return (
    "\n\n[Goal] The user set a standing goal for this thread: " +
    `${goal.objective}\n` +
    "Keep working toward it across turns. When it is fully achieved, say so plainly."
  );
}

/**
 * Set or clear (goal null/blank) the thread goal (`/goal`, #1531). A new
 * objective starts active; re-setting a finished or blocked one restarts
 * it. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, goal?: string | null }} input
 */
function setGoal(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const objective = String((input && input.goal) || "")
    .trim()
    .slice(0, GOAL_MAX_CHARS);
  if (!objective) {
    if (!thread.goal) return { ...thread };
    const updated = store.updateThread(threadId, { goal: null });
    store.save();
    return updated ? { ...updated } : { ...thread, goal: null };
  }
  const cur = thread.goal;
  if (cur && cur.objective === objective && cur.status === "active") {
    return { ...thread };
  }
  const goal = { objective, status: "active", setAt: Date.now() };
  const updated = store.updateThread(threadId, { goal });
  store.save();
  return updated ? { ...updated } : { ...thread, goal };
}

/**
 * Fold a native goal report (Codex thread/goal/updated) into the stored
 * goal. Adopts a goal the agent created itself; ignores a report for a
 * different objective than the one the user set. Returns true on change.
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {{ objective?: string, status?: string, tokensUsed?: number } | null | undefined} native
 */
function applyNativeGoal(store, threadId, native) {
  const thread = store.getThread(threadId);
  if (!thread || !native || !native.objective) return false;
  const cur = thread.goal;
  if (cur && cur.objective !== native.objective) return false;
  const status = String(native.status || "active");
  const tokensUsed = Number(native.tokensUsed) || 0;
  if (cur && cur.status === status && cur.tokensUsed === tokensUsed) {
    return false;
  }
  store.updateThread(threadId, {
    goal: {
      ...(cur || { objective: native.objective, setAt: Date.now() }),
      status,
      tokensUsed,
    },
  });
  return true;
}

module.exports = {
  NATIVE_GOAL_PROVIDERS,
  goalNoteFor,
  setGoal,
  applyNativeGoal,
  TEACH_REVIEW_THRESHOLDS,
  TEACH_REVIEW_PROMPT,
  teachAutonomyFor,
  teachAllowedModes,
  teachPermissionAllowed,
  snapPermissionModeForThread,
  teachNoteFor,
  startTeach,
  stopTeach,
  askNoteFor,
  startAsk,
  stopAsk,
  recordTeachReview,
  requestTeachReview,
};
