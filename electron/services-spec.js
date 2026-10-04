"use strict";

// Spec mode: staged requirements / design / tasks artifacts.

const fs = require("node:fs");
const path = require("node:path");
const { specCwd } = require("./services-shared.js");
const { THREAD_TITLE_MAX } = require("./services-notes.js");
const { forkThread, forkWorkerThread } = require("./services-threads.js");
const {
  listCrewTasks,
  addCrewTasks,
  claimCrewTask,
  completeCrewTask,
} = require("./services-crew.js");

/* --------------------------------------------------------------- spec mode */

/** The three gated artifacts, in approval order (issue #269). */
const SPEC_ARTIFACTS = ["requirements", "design", "tasks"];
/** Spec folder inside the worktree, so artifacts review and diff like code. */
const SPEC_DIR = ".solenta/specs";

/** What the agent must produce at each stage. */
const SPEC_GOAL = {
  requirements:
    "requirements.md — numbered acceptance criteria, each one testable " +
    '("WHEN <trigger> THE SYSTEM SHALL <behavior>"), plus what is out of scope',
  design:
    "design.md — the technical approach: files touched, data shapes, and " +
    "the alternatives you rejected and why",
  tasks:
    "tasks.md — an ordered checkbox list of implementation tasks, each " +
    "naming the files it touches and the requirement numbers it satisfies. " +
    "Independent tasks may run in parallel; express a dependency as " +
    "`needs: <id>` on the same line (ids are a leading `1.` / `T1:` or " +
    "1-based order)",
};

/** The stage after `stage`, or null when `stage` is unknown / already build. */
function nextSpecStage(stage) {
  const i = SPEC_ARTIFACTS.indexOf(stage);
  if (i < 0) return null;
  return SPEC_ARTIFACTS[i + 1] || "build";
}

/**
 * Absolute path of one artifact. `cwd` is the thread's worktree (or the
 * project path when it has none) — the same folder the CLI runs in.
 * @param {{ spec?: { slug?: string } } | null | undefined} thread
 * @param {string} cwd
 * @param {string} stage
 */
function specArtifactPath(thread, cwd, stage) {
  const slug = (thread && thread.spec && thread.spec.slug) || "spec";
  return path.join(String(cwd || ""), SPEC_DIR, slug, `${stage}.md`);
}

/**
 * Turn spec mode on: the thread starts at requirements with nothing submitted.
 * Idempotent — a thread already in spec mode is returned untouched, so a
 * second click cannot rewind an approved stage. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function startSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.spec) return { ...thread };
  const { slugify } = require("./worktrees.js");
  const spec = {
    slug: slugify(thread.title),
    stage: "requirements",
    awaitingApproval: false,
  };
  /** @type {{ spec: object, ask?: boolean }} */
  const specPatch = { spec };
  if (thread.ask === true) specPatch.ask = false;
  const updated = store.updateThread(threadId, specPatch);
  store.save();
  return updated ? { ...updated } : { ...thread, spec };
}

/**
 * Turn spec mode off (issue #500): drop thread.spec so the thread is a
 * normal thread again. Artifacts on disk are left alone. Idempotent —
 * a thread that is not in spec mode is returned untouched. Never bumps
 * updatedAt. Does not start or stop a run.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function stopSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) return { ...thread };
  const updated = store.updateThread(threadId, { spec: undefined });
  if (updated) delete updated.spec;
  store.save();
  const next = { ...(updated || thread) };
  delete next.spec;
  return next;
}

/**
 * The agent has written the current stage's artifact and wants a human.
 * Flips the gate; the run itself stops on the agent's side. Called by the
 * coder-threads MCP tool `spec_submit`, never inferred from the transcript.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ stage: string, awaitingApproval: true }}
 */
function submitSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (thread.spec.stage === "build") {
    throw new Error("Spec is already approved; nothing left to submit");
  }
  const spec = { ...thread.spec, awaitingApproval: true };
  store.updateThread(threadId, { spec });
  store.save();
  return { stage: spec.stage, awaitingApproval: true };
}

/** The prompt that opens a stage (or re-opens it after a revise). */
function specStagePrompt(stage, feedback) {
  const note = String(feedback || "").trim();
  if (stage === "build") {
    return (
      "tasks.md is approved. Independent tasks dispatch as parallel workers " +
      "from the spec card (Dispatch). Stay on this thread as the " +
      "orchestrator — do not implement the checklist yourself unless asked. " +
      "Converge compares the repo to the spec and appends any missing " +
      "tasks to tasks.md."
    );
  }
  const goal = SPEC_GOAL[stage] || stage;
  if (note) {
    return (
      `Not approved yet. The human's feedback on ${stage}.md:\n\n${note}\n\n` +
      "Update the artifact accordingly, then call spec_submit and stop."
    );
  }
  return (
    `Write ${goal}. Then call spec_submit and stop — a human approves this ` +
    "stage before the next one opens."
  );
}

/**
 * Answer the stage gate (issue #269). Approve advances one stage; revise
 * keeps it and hands the feedback back. Returns the updated thread plus the
 * prompt the caller must dispatch — services never start runs itself.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, decision: "approve" | "revise", feedback?: string }} input
 * @returns {{ thread: object, prompt: string }}
 */
function reviewSpec(store, input) {
  const { threadId, decision, feedback } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (!thread.spec.awaitingApproval) {
    throw new Error("No spec artifact is awaiting approval");
  }
  if (decision !== "approve" && decision !== "revise") {
    throw new Error(`Invalid spec decision: ${decision}`);
  }
  const stage =
    decision === "approve"
      ? nextSpecStage(thread.spec.stage) || "build"
      : thread.spec.stage;
  const spec = { ...thread.spec, stage, awaitingApproval: false };
  const updated = store.updateThread(threadId, { spec });
  store.save();
  return {
    thread: updated ? { ...updated } : { ...thread, spec },
    prompt: specStagePrompt(stage, decision === "revise" ? feedback : ""),
  };
}

/**
 * @param {object} task
 * @returns {string}
 */
function specDispatchPrompt(task) {
  const id = task && task.id ? String(task.id) : "?";
  const title = task && task.title ? String(task.title) : "";
  return (
    "[Spec dispatch] You are a worker forked from a spec thread. Your task:\n\n" +
    `${id}: ${title}\n\n` +
    "Implement this task and only this task. Tick it off in tasks.md " +
    "(`- [x]`) when it lands. Then call task_complete with a short note " +
    "(a summary, or a `branch:path` another worker can read with git show) " +
    "and stop. Do not pick up another task."
  );
}

/**
 * @param {{ spec?: { slug?: string } } | null | undefined} thread
 * @param {string} cwd
 */
function specConvergePrompt(thread, cwd) {
  const req = specArtifactPath(thread, cwd, "requirements");
  const design = specArtifactPath(thread, cwd, "design");
  const tasks = specArtifactPath(thread, cwd, "tasks");
  return (
    "[Spec converge] Compare the codebase against the approved spec and " +
    "append any missing work to tasks.md.\n\n" +
    "Read:\n" +
    `- ${req}\n- ${design}\n- ${tasks}\n\n` +
    "Then inspect the repo. For each requirement or design decision that " +
    "is not already covered by a checkbox (done or open), append a new " +
    "checkbox to tasks.md using the same format:\n\n" +
    "- [ ] N. Title (`files`) — req X\n" +
    "- [ ] N. Title (`files`) — req X — needs: A, B\n\n" +
    "Do not implement anything. Do not rewrite or reorder existing tasks. " +
    "Only append. When you are done, stop — do not call spec_submit."
  );
}

/**
 * Fold a freshly parsed tasks.md into the crew list: add any checkbox the
 * crew does not already have (matched by title), then close tasks whose
 * box is already ticked. Services never start runs — the caller forks
 * workers for the current wave.
 *
 * @param {import('./store').Store} store
 * @param {string} threadId
 * @param {Array<{ id: string, title: string, needs: string[], done: boolean }>} parsed
 */
function syncSpecCrewFromParsed(store, threadId, parsed) {
  const { tasks: existing } = listCrewTasks(store, { threadId });
  const titleKey = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const byTitle = new Map(existing.map((t) => [titleKey(t.title), t]));
  /** @type {Map<string, string>} */
  const sourceToCrew = new Map();
  for (const p of parsed) {
    const hit = byTitle.get(titleKey(p.title));
    if (hit) sourceToCrew.set(p.id, hit.id);
  }

  const toAdd = parsed.filter((p) => !sourceToCrew.has(p.id));
  if (toAdd.length > 0) {
    let next = 1;
    for (const t of existing) {
      const n = Number(String(t.id).replace(/^t/, ""));
      if (Number.isInteger(n) && n >= next) next = n + 1;
    }
    for (const p of toAdd) {
      sourceToCrew.set(p.id, `t${next++}`);
    }
    addCrewTasks(store, {
      threadId,
      tasks: toAdd.map((p) => ({
        title: p.title,
        needs: p.needs
          .map((n) => sourceToCrew.get(n))
          .filter(Boolean),
      })),
    });
  }

  const { tasks: after } = listCrewTasks(store, { threadId });
  const afterByTitle = new Map(after.map((t) => [titleKey(t.title), t]));
  for (const p of parsed) {
    if (!p.done) continue;
    const hit = afterByTitle.get(titleKey(p.title));
    if (hit && hit.status !== "done") {
      completeCrewTask(store, {
        threadId,
        taskId: hit.id,
        note: "already done in tasks.md",
      });
    }
  }
}

/**
 * Parse the spec thread's tasks.md, load it into the crew-task list, and
 * describe the current wave of claimable tasks. The caller (IPC) forks a
 * worker per wave entry and starts the run — services never start runs.
 *
 * Available only at the build stage (tasks.md is approved). A second click
 * does not re-add existing titles; it only forks workers for tasks that
 * are still open and unblocked.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{
 *   thread: object,
 *   path: string,
 *   tasks: Array<object>,
 *   waves: string[][],
 *   wave: Array<object>,
 *   reason?: string,
 * }}
 */
function dispatchSpec(store, input) {
  const { parseTasksMd } = require("./specTasks.js");
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (thread.spec.stage !== "build") {
    throw new Error("Dispatch is available after tasks.md is approved");
  }

  const cwd = specCwd(store, thread);
  const file = specArtifactPath(thread, cwd, "tasks");
  let text = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  if (text == null) {
    throw new Error(`tasks.md is not written yet (${file})`);
  }

  const parsed = parseTasksMd(text);
  if (parsed.errors.length > 0) {
    throw new Error(`tasks.md is not a valid DAG: ${parsed.errors.join("; ")}`);
  }
  if (parsed.tasks.length === 0) {
    throw new Error("tasks.md has no checkbox tasks");
  }

  syncSpecCrewFromParsed(store, threadId, parsed.tasks);
  const { tasks } = listCrewTasks(store, { threadId });
  const wave = tasks.filter((t) => t.status === "open" && !t.blocked);
  const reason =
    wave.length === 0
      ? tasks.some((t) => t.status === "open")
        ? "No claimable tasks: remaining work is still blocked on dependencies."
        : "No open tasks left."
      : undefined;
  return {
    thread: { ...thread },
    path: file,
    tasks,
    waves: parsed.waves,
    wave,
    reason,
  };
}

/**
 * Fork one orchWorker per claimable wave task, claim it, and return the
 * prompts the caller must dispatch. Does not start runs.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, wave: Array<{ id: string, title?: string }> }} input
 * @param {(store: any, input: any) => any} [forkImpl]
 * @returns {Array<{ thread: object, task: object, prompt: string }>}
 */
function forkSpecWave(store, input, forkImpl) {
  const threadId = input && input.threadId;
  const wave = Array.isArray(input && input.wave) ? input.wave : [];
  const dispatched = [];
  for (const task of wave) {
    const worker = forkWorkerThread(
      store,
      { threadId, title: task.title },
      forkImpl || forkThread,
    );
    const claimed = claimCrewTask(store, {
      threadId: worker.id,
      taskId: task.id,
    });
    if (!claimed.task) continue;
    const title = String(task.title || claimed.task.title || "")
      .trim()
      .slice(0, THREAD_TITLE_MAX);
    if (title) store.updateThread(worker.id, { title });
    const fresh = store.getThread(worker.id) || worker;
    dispatched.push({
      thread: { ...fresh, ...(title ? { title } : {}) },
      task: claimed.task,
      prompt: specDispatchPrompt(claimed.task),
    });
  }
  if (dispatched.length > 0) store.save();
  return dispatched;
}

/**
 * Start a converge pass: the spec thread reads the three artifacts plus
 * the repo and appends missing checkboxes to tasks.md. Available only at
 * build. Services never start the run — the caller dispatches the prompt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ thread: object, prompt: string }}
 */
function convergeSpec(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!thread.spec) {
    throw new Error("Thread is not in spec mode");
  }
  if (thread.spec.stage !== "build") {
    throw new Error("Converge is available after tasks.md is approved");
  }
  const cwd = specCwd(store, thread);
  return {
    thread: { ...thread },
    prompt: specConvergePrompt(thread, cwd),
  };
}

/**
 * Standing note appended to every dispatched prompt while a spec thread is
 * still behind the gate. Same rule as planboardNoteFor / hypothesisNoteFor:
 * returns "" when there is nothing to say (no spec, or stage build).
 *
 * ponytail: the gate is procedural — the note plus the human's Approve click.
 * Nothing stops a determined agent editing source early; add a can_use_tool
 * deny in runner.js if that turns out to happen in practice.
 *
 * @param {{ spec?: { slug?: string, stage?: string, awaitingApproval?: boolean } } | null | undefined} thread
 * @param {string} cwd Worktree (or project) folder the CLI runs in.
 * @returns {string}
 */
function specNoteFor(thread, cwd) {
  const spec = thread && thread.spec;
  if (!spec || !spec.stage || spec.stage === "build") return "";
  const file = specArtifactPath(thread, cwd, spec.stage);
  return (
    `\n\n[Spec mode] This thread is spec-driven: ${SPEC_ARTIFACTS.join(" → ")} ` +
    "are written and approved one at a time before any code changes. " +
    `Current stage: ${spec.stage}. Write ${file} and change NO other file. ` +
    "When it is ready call the coder-threads tool spec_submit and stop — " +
    "a human approves each stage."
  );
}

/**
 * Read one artifact off disk for the UI. `text` is null when the agent has
 * not written it yet; the path is returned either way so the card can say
 * where it will land.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, stage: string }} input
 * @returns {{ path: string, text: string | null }}
 */
function readSpecArtifact(store, input) {
  const { threadId, stage } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!SPEC_ARTIFACTS.includes(stage)) {
    throw new Error(`Invalid spec stage: ${stage}`);
  }
  const project = store.getProject(thread.projectId);
  const cwd = thread.worktreePath || (project && project.path) || "";
  const file = specArtifactPath(thread, cwd, stage);
  let text = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = null;
  }
  return { path: file, text };
}

module.exports = {
  SPEC_ARTIFACTS,
  SPEC_DIR,
  nextSpecStage,
  specArtifactPath,
  startSpec,
  stopSpec,
  submitSpec,
  specStagePrompt,
  reviewSpec,
  specDispatchPrompt,
  specConvergePrompt,
  dispatchSpec,
  forkSpecWave,
  convergeSpec,
  specNoteFor,
  readSpecArtifact,
};
