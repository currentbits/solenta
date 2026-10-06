"use strict";

// Per-thread state setters (archive, pin, queue, btw, notes, verify, ...).

const { randomUUID } = require("node:crypto");
const { normalizeMessagePins } = require("./messagePins.js");
const { ejectCommand } = require("./providers.js");
const { normalizeCommand, runVerifyCommand } = require("./verify.js");
const { prepareVerifyRun } = require("./verifyEfficiency.js");
const btw = require("./btw.js");
const { scheduleImagePruneFromStore } = require("./image-store.js");
const {
  scheduleSimulatorRelease,
  canHostWorktree,
  specCwd,
} = require("./services-shared.js");
const {
  THREAD_NOTES_MAX,
  FELT_ESTIMATE_MAX_MS,
  HYPOTHESES_MAX,
  HYPOTHESIS_CLAIM_MAX,
  HYPOTHESIS_REASON_MAX,
  HYPOTHESIS_STATUSES,
  SUGGESTIONS_MAX,
  SUGGESTION_TITLE_MAX,
  SUGGESTION_PROMPT_MAX,
  SUGGESTION_RESOLVE_STATUSES,
} = require("./services-notes.js");
const {
  normalizeBaseBranch,
  decorateThread,
} = require("./services-threads.js");

/**
 * Archive or unarchive a thread. Does not bump updatedAt (not real activity).
 * @param {import('./store').Store} store
 * @param {{ threadId: string, archived: boolean }} input
 * @param {{ getIosSimulator?: () => object | null, cleanupRunArtifacts?: () => unknown, log?: (msg: string) => void }} [opts]
 */
function setArchived(store, input, opts) {
  const { threadId, archived } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const updated = store.updateThread(threadId, {
    archived: Boolean(archived),
  });
  store.save();
  if (Boolean(archived)) {
    void scheduleImagePruneFromStore(store);
    void scheduleSimulatorRelease(opts, "releaseThread", { threadId });
  }
  return updated ? { ...updated } : { ...thread, archived: Boolean(archived) };
}

const SETTLE_OVERRIDES = new Set(["settled", "active", null]);

/**
 * Patch fields that clear a stale settle override when real activity starts
 * (startRun or startWorkflow). A "settled" override is cleared so the
 * thread does not re-fold the moment the run ends; an "active" override is
 * left alone so the user can keep a thread out of auto-settle.
 *
 * Round 44: this patch must NOT clear pinnedAt or snooze fields.
 * - Pin survives activity (t3: pins block auto-settle and are sticky).
 * - Snooze is visibility only; server fields persist; wake is derived
 *   client-side (timer or raised-hand), never by wiping on run start.
 *
 * @param {{ settledOverride?: string | null } | null | undefined} thread
 * @returns {{ settledOverride: null, settledAt: null } | {}}
 */
function clearSettledOnActivity(thread) {
  if (thread && thread.settledOverride === "settled") {
    return { settledOverride: null, settledAt: null };
  }
  return {};
}

/**
 * Set or clear the settle override (t3-style). Does not bump updatedAt:
 * settling is bookkeeping, and bumping would push the thread to the top of
 * a list it is leaving.
 *
 * Mutual exclusion with pin (round 44): an explicit "settled" override also
 * clears pinnedAt; setPinned(true) clears a "settled" override. Both directions
 * live here and in setPinned so they cannot drift.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, override: "settled" | "active" | null }} input
 */
function setSettled(store, input) {
  const { threadId, override } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  // Accept only the three contract values. null is allowed (clear).
  if (!SETTLE_OVERRIDES.has(override)) {
    throw new Error(
      `Invalid settle override: ${JSON.stringify(override)}. Expected "settled", "active", or null`,
    );
  }
  if (
    override === "settled" &&
    (thread.status === "working" || thread.status === "quota-wait")
  ) {
    throw new Error("Cannot settle a thread while a run is active");
  }
  const patch = {
    settledOverride: override,
    settledAt: override != null ? Date.now() : null,
  };
  // Mutual exclusion: settle clears pin (mirror of setPinned clearing settle).
  // Explicit settle also unsnoozes immediately (t3: companion unsnooze) so
  // the row leaves the snoozed shelf instead of staying hidden until wake.
  if (override === "settled") {
    patch.pinnedAt = null;
    patch.snoozedUntil = null;
    patch.snoozedAt = null;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Pin or unpin. Never bumps updatedAt.
 * Mutual exclusion with settle: pinning clears a "settled" override (+settledAt);
 * setSettled("settled") clears the pin. See setSettled for the other direction.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, pinned: boolean }} input
 */
function setPinned(store, input) {
  const { threadId, pinned } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (pinned) {
    patch.pinnedAt = Date.now();
    // Mutual exclusion: pin clears an explicit settle (not an "active" override).
    if (thread.settledOverride === "settled") {
      patch.settledOverride = null;
      patch.settledAt = null;
    }
  } else {
    patch.pinnedAt = null;
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Persist or clear the type-ahead queue for a thread (issue #137).
 * prompt === null clears. A non-null prompt APPENDS to any existing queue
 * (same join as the old renderer startRun) so two mid-run sends cannot
 * race-replace each other across the async IPC hop. Never bumps updatedAt:
 * queueing is not activity, same rule as setPinned.
 *
 * @param {import('./store').Store} store
 * @param {{
 *   threadId: string,
 *   prompt: string | null,
 *   attachments?: object[],
 *   replace?: boolean,
 *   fromThread?: { id: string, title: string } | null,
 *   inbound?: boolean,
 *   posted?: boolean,
 * }} input
 */
/** Per-thought list for the queued blob (#809). prompt is always the join. */
function queuedThoughts(prev, prompt, input) {
  if (input.replace === true) {
    const items =
      Array.isArray(input.items) && input.items.length
        ? input.items.map((s) => String(s))
        : [prompt];
    return { prompt: items.join("\n\n"), items };
  }
  const prevItems = Array.isArray(prev?.items)
    ? prev.items.map((s) => String(s))
    : prev?.prompt != null
      ? String(prev.prompt).split("\n\n")
      : [];
  const items = [...prevItems, prompt];
  return { prompt: items.join("\n\n"), items };
}

function setQueued(store, input) {
  const { threadId, prompt, attachments } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  let queued = null;
  if (prompt !== null && input.replace === true) {
    // Edit in place (issue #364): the user rewrote the blob, so it overwrites
    // prompt AND attachments, and drops any inbound/fromThread provenance —
    // the content is user-authored now. Still drops the delivery error.
    const thoughts = queuedThoughts(null, prompt, input);
    queued = { prompt: thoughts.prompt, items: thoughts.items };
    if (attachments && attachments.length) queued.attachments = attachments;
  } else if (prompt !== null) {
    const prev = thread.queued;
    const files = [...(prev?.attachments ?? []), ...(attachments ?? [])];
    const thoughts = queuedThoughts(prev, prompt, input);
    queued = {
      prompt: thoughts.prompt,
      items: thoughts.items,
      attachments: files.length ? files : undefined,
      // A new/appended prompt drops any previous delivery error (#314).
    };
    const fromThread = input.fromThread || (prev && prev.fromThread);
    if (fromThread && fromThread.id) {
      queued.fromThread = {
        id: String(fromThread.id),
        title: fromThread.title != null ? String(fromThread.title) : "",
      };
    }
    // inbound stays true only when every line in the blob is inbound
    // (a user follow-up mixed in must still drain at idle).
    if (prev ? prev.inbound === true && input.inbound === true : input.inbound === true) {
      queued.inbound = true;
    }
    if (prev ? prev.posted === true && input.posted === true : input.posted === true) {
      queued.posted = true;
    }
  }
  // Queueing a follow-up mid-run is still the user speaking, so it supersedes
  // an open question card the same way startRun does (issue #647). Clearing
  // the queue (prompt === null) is not: the card outlives a cancelled draft.
  // An inbound cross-thread send is another agent, not the user: it queues
  // behind the card instead of deleting it.
  const patch =
    queued && input.inbound !== true
      ? { queued, pendingQuestion: null }
      : { queued };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, queued };
}

/**
 * Atomically read-and-clear the type-ahead queue (issue #314). Returns the
 * queued payload or null when empty. Never bumps updatedAt: taking is
 * delivery, not activity.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @returns {{ prompt: string, attachments?: object[], error?: string | null } | null}
 */
function takeQueued(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const queued = thread.queued || null;
  if (!queued) return null;
  store.updateThread(threadId, { queued: null });
  store.save();
  return queued;
}

/**
 * Open a `/btw` side-question card (issue #471). Returns `{ thread, card }`.
 * Never bumps updatedAt: a side question is not thread activity, same rule
 * as setQueued. Caps in-flight cards at BTW_RUNNING_MAX.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, question: unknown }} input
 * @returns {{ thread: object, card: object }}
 */
function addBtw(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const question = btw.normalizeBtwQuestion(input.question);
  if (!question) {
    throw new Error("Side question is empty");
  }
  const cards = Array.isArray(thread.btw) ? thread.btw.slice() : [];
  const running = cards.filter((c) => c && c.status === "running").length;
  if (running >= btw.BTW_RUNNING_MAX) {
    throw new Error(
      `Already ${btw.BTW_RUNNING_MAX} side questions in flight`,
    );
  }
  const card = {
    id: randomUUID(),
    question,
    status: "running",
    createdAt: Date.now(),
  };
  cards.push(card);
  if (cards.length > btw.BTW_MAX) {
    cards.splice(0, cards.length - btw.BTW_MAX);
  }
  const updated = store.updateThread(threadId, { btw: cards });
  store.save();
  const next = updated ? { ...updated } : { ...thread, btw: cards };
  return { thread: next, card };
}

/**
 * Write the answer (or error) onto an existing card. No-op when the card
 * is gone (dismissed). Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, id: string, answer?: unknown, error?: unknown, source?: unknown }} input
 * @returns {object | null}
 */
function finishBtw(store, input) {
  const { threadId, id } = input;
  const thread = store.getThread(threadId);
  if (!thread) return null;
  const cards = Array.isArray(thread.btw) ? thread.btw.slice() : [];
  const idx = cards.findIndex((c) => c && c.id === id);
  if (idx === -1) return null;
  const prev = cards[idx];
  const errText =
    input.error != null && String(input.error).trim()
      ? String(input.error).trim()
      : "";
  const answer =
    input.answer != null ? String(input.answer).slice(0, btw.BTW_ANSWER_MAX) : "";
  const source =
    input.source === "fm" ||
    input.source === "print" ||
    input.source === "retrieval"
      ? input.source
      : undefined;
  const nextCard = {
    ...prev,
    status: errText && !answer ? "error" : "done",
    answer: answer || prev.answer,
  };
  if (errText) nextCard.error = errText;
  else delete nextCard.error;
  if (source) nextCard.source = source;
  cards[idx] = nextCard;
  const updated = store.updateThread(threadId, { btw: cards });
  store.save();
  return updated ? { ...updated } : { ...thread, btw: cards };
}

/**
 * Drop a side-question card. Unknown id is a no-op (already gone).
 * Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, id: string }} input
 * @returns {object}
 */
function dismissBtw(store, input) {
  const { threadId, id } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const cards = Array.isArray(thread.btw) ? thread.btw : [];
  const next = cards.filter((c) => c && c.id !== id);
  if (next.length === cards.length) {
    return { ...thread };
  }
  const patch = { btw: next.length ? next : undefined };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, btw: patch.btw };
}

/**
 * Queue the side question as a follow-up and drop the card. The answer
 * (when present) rides along so the main agent does not redo the lookup.
 * Unknown id is an error so a double-click cannot silently no-op.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, id: string }} input
 * @returns {object}
 */
function promoteBtw(store, input) {
  const { threadId, id } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const cards = Array.isArray(thread.btw) ? thread.btw : [];
  const card = cards.find((c) => c && c.id === id);
  if (!card) {
    throw new Error(`Unknown side question: ${id}`);
  }
  const answer = typeof card.answer === "string" ? card.answer.trim() : "";
  const prompt = answer
    ? `Follow-up from a side question:\n${card.question}\n\n(Already answered off-thread; use or ignore:)\n${answer}`
    : card.question;
  const remaining = cards.filter((c) => c && c.id !== id);
  store.updateThread(threadId, {
    btw: remaining.length ? remaining : undefined,
  });
  return setQueued(store, { threadId, prompt });
}

/**
 * Snooze until an epoch ms, or clear with null. Visibility only: no run-state
 * guards (a working thread is snoozable). Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, until: number | null }} input
 */
function setSnoozed(store, input) {
  const { threadId, until } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  /** @type {Record<string, unknown>} */
  let patch;
  if (until === null || until === undefined) {
    patch = { snoozedUntil: null, snoozedAt: null };
  } else {
    const t = Number(until);
    if (!Number.isFinite(t) || !(t > Date.now())) {
      throw new Error(`Snooze time ${until} is not in the future`);
    }
    patch = { snoozedUntil: t, snoozedAt: Date.now() };
  }
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Replace a thread's user-defined tags (issue #789). Tags are trimmed,
 * lowercased, deduped; capped at 12 tags / 24 chars each so the sidebar
 * chips stay one line. Never bumps updatedAt: categorization is bookkeeping.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, tags: unknown }} input
 */
function setTags(store, input) {
  const { threadId, tags } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!Array.isArray(tags)) {
    throw new Error(`tags must be an array (got ${JSON.stringify(tags)})`);
  }
  const seen = new Set();
  const clean = [];
  for (const raw of tags) {
    const tag = String(raw ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    clean.push(tag);
    if (clean.length >= 12) break;
  }
  const patch = { tags: clean };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Recategorize a thread onto another project (issue #737). Never bumps
 * updatedAt: the move is bookkeeping. Same-project is a no-op even when
 * the thread could not otherwise move.
 *
 * Worktree-backed threads (worktreePath set) refuse: merge/cleanup use
 * store.getProject(thread.projectId).path as the git destination, so a
 * moved row would operate on repo B while the directory still belongs
 * to repo A. The worktree is left untouched.
 *
 * Active runs (working / quota-wait) refuse: a live runner callback can
 * write the old sessionId back after the patch.
 *
 * A permitted move drops cwd/session and git/GitHub bindings that would
 * still name the source repo. pendingWorktree stays so first-run
 * materialize uses the destination project. Crew workers (orchWorker /
 * leadSnapshotSha) refuse: resolveWorktreeStart uses that SHA exclusively
 * and would look it up in repo B. Dropping sessionId sets replayContext
 * so the next turn digests this thread's retained tail (same as rewind).
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, projectId: string }} input
 */
function setThreadProject(store, input) {
  const { threadId, projectId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const id = projectId != null ? String(projectId) : "";
  if (!id) {
    throw new Error("projectId is required");
  }
  const project = store.getProject(id);
  if (!project) {
    throw new Error(`Unknown project: ${id}`);
  }
  if (thread.projectId === id) {
    return { ...thread };
  }
  if (thread.worktreePath) {
    throw new Error("Cannot move a thread that has a worktree");
  }
  if (thread.orchWorker || thread.leadSnapshotSha) {
    throw new Error("Cannot move a crew worker");
  }
  if (thread.status === "working" || thread.status === "quota-wait") {
    throw new Error("Cannot move a thread while a run is active");
  }
  const patch = {
    projectId: id,
    sessionId: null,
    replayContext: true,
    // Scratch has no git: a draft moved there cannot keep a worktree intent.
    ...(project.scratch === true ? { pendingWorktree: false } : {}),
    branch: null,
    baseBranch: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    prMergeable: null,
    issueNumber: null,
    lane: undefined,
    leadSnapshotSha: null,
    leadSnapshotBranch: null,
    leadSnapshotDirty: undefined,
  };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Mute/unmute desktop notifications for one thread (issue #87). Notification
 * only: no run-state or visibility effect, and never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, muted: boolean }} input
 */
function setMuted(store, input) {
  const { threadId, muted } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const patch = { muted: muted === true };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Best-effort clipboard write. Missing electron (tests, web) is a no-op.
 * @param {string} text
 */
function defaultClipboardWrite(text) {
  try {
    const { clipboard } = require("electron");
    if (clipboard && typeof clipboard.writeText === "function") {
      clipboard.writeText(text);
    }
  } catch {
    // no clipboard in this process
  }
}

/**
 * Copy the raw-CLI resume command and, when $TERMINAL is set, run it.
 * Reclaim (ejected: false) never copies. Clipboard still succeeds if the
 * terminal spawn throws.
 *
 * @param {import('./store').Store} store
 * @param {object} thread
 * @param {{
 *   writeText?: (text: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: typeof import('node:child_process').spawn,
 * } | null | undefined} opts
 */
function copyEjectCommand(store, thread, opts) {
  const project = store.getProject(thread.projectId);
  const cwd = thread.worktreePath || (project && project.path) || "";
  const { command } = ejectCommand({
    provider: thread.provider,
    sessionId: thread.sessionId,
    cwd,
    model: thread.model,
    sessionStartModel: thread.sessionStartModel,
  });
  const writeText =
    opts && typeof opts.writeText === "function"
      ? opts.writeText
      : defaultClipboardWrite;
  writeText(command);

  const env = (opts && opts.env) || process.env;
  const term = String((env && env.TERMINAL) || "").trim();
  if (!term) return;
  const spawnFn =
    opts && typeof opts.spawn === "function"
      ? opts.spawn
      : require("node:child_process").spawn;
  const runnable = command.split("\n")[0];
  try {
    const child = spawnFn(term, ["-e", "sh", "-c", runnable], {
      detached: true,
      stdio: "ignore",
    });
    if (child && typeof child.unref === "function") child.unref();
  } catch {
    // command is still on the clipboard
  }
}

/**
 * Mark a thread ejected so Solenta will not resume its provider session
 * (issue #554). The sessionId stays on the row for the raw CLI. Never
 * bumps updatedAt: eject is ownership, not activity. Eject copies the
 * per-provider resume command and optionally runs it in $TERMINAL.
 *
 * Reclaim (`ejected: false`) re-reads the known provider session for
 * this sessionId and appends turns that happened outside Solenta
 * (#433 reader: Codex rollout, Claude ~/.claude/projects jsonl, Grok
 * chat_history.jsonl, Cursor agent-transcripts jsonl, OpenCode
 * opencode.db / JSON fallback, Kimi sessions/<wd>/<id>/agents/main/wire.jsonl,
 * Muse sessions/YYYY/MM/DD/<id>/session.jsonl).
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, ejected: boolean, home?: string }} input
 * @param {{
 *   writeText?: (text: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: typeof import('node:child_process').spawn,
 * } | null | undefined} [opts]
 */
function setEjected(store, input, opts) {
  const { threadId, ejected } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const patch = { ejected: ejected === true };
  const updated = store.updateThread(threadId, patch);
  const next = updated ? { ...updated } : { ...thread, ...patch };
  if (ejected === true) {
    try {
      copyEjectCommand(store, next, opts);
    } catch {
      // ejected is persisted; clipboard / $TERMINAL is best-effort
    }
  } else {
    const { absorbSessionTurns } = require("./cli-sessions.js");
    absorbSessionTurns(store, next, {
      home: input && input.home,
      cwd: specCwd(store, next),
    });
  }
  store.save();
  return store.getThread(threadId) || next;
}

/**
 * Per-thread inbound policy for cross-thread messages (issue #551).
 * accept (default, stored as absent) / queue-only / refuse.
 * Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, policy: unknown }} input
 */
function setCrossThreadInbound(store, input) {
  const { INBOUND_POLICIES } = require("./crossThread.js");
  const raw = String(input.policy || "")
    .trim()
    .toLowerCase();
  if (!INBOUND_POLICIES.includes(raw)) {
    throw new Error(
      `Invalid inbound policy: ${input.policy}. Expected one of: ${INBOUND_POLICIES.join(", ")}`,
    );
  }
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const patch = { crossThreadInbound: raw === "accept" ? null : raw };
  const updated = store.updateThread(threadId, patch);
  store.save();
  const row = updated ? { ...updated } : { ...thread, ...patch };
  if (raw === "accept") delete row.crossThreadInbound;
  return row;
}

/**
 * Per-thread quota-wait auto-resume override (#462). true/false pins the
 * thread; null inherits the global setting. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, enabled: boolean | null }} input
 */
function setQuotaWaitAutoResume(store, input) {
  const { threadId, enabled } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (enabled !== true && enabled !== false && enabled !== null) {
    throw new Error("quotaWaitAutoResume must be true, false, or null");
  }
  const patch = { quotaWaitAutoResume: enabled };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return decorateThread(store, updated || { ...thread, ...patch });
}

/**
 * Per-thread PR watch-and-wake switch (#1493 D, electron/prWatch.js).
 * Turning it on re-arms a paused watch: the wake count and reported
 * fingerprints reset, so the next refresher pass takes a fresh baseline.
 * Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, enabled: boolean }} input
 */
function setPrWatch(store, input) {
  const { threadId, enabled } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (enabled !== true && enabled !== false) {
    throw new Error("prWatch must be true or false");
  }
  const patch = { prWatch: enabled, prWatchState: null };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return decorateThread(store, updated || { ...thread, ...patch });
}

/**
 * Set or clear the per-thread scratch pad (issue #194). User-facing only:
 * the agent never reads it. Trims, caps at THREAD_NOTES_MAX, empty string
 * clears. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, notes: string }} input
 */
function setNotes(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const notes = String(input.notes ?? "").trim().slice(0, THREAD_NOTES_MAX);
  const patch = { notes };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Replace the per-thread transcript bookmark list (issue #1217).
 * Deduped by messageId, capped, excerpts/labels truncated. Empty array
 * clears. Never bumps updatedAt. Does not copy message bodies.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, pins: unknown }} input
 */
function setMessagePins(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!Array.isArray(input.pins)) {
    throw new Error(`pins must be an array (got ${JSON.stringify(input.pins)})`);
  }
  const patch = { messagePins: normalizeMessagePins(input.pins) };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Change the recorded merge/PR base after create (#187 / #775).
 * Empty/null clears to the repo default. A non-empty name must be a
 * local branch. Refused after the first pull request. A bound worktree
 * rebases unique thread commits onto the new base when clean, or
 * resets when there are none; dirty trees and rebase conflicts are
 * refused and the recorded base is left unchanged. Never bumps updatedAt.
 * Orchestration workers keep their lead snapshot and commits: their base
 * is only the merge/PR destination. Refresh snapshot rebases their work.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, baseBranch?: string | null }} input
 */
function setBaseBranch(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.prNumber) {
    throw new Error("Cannot change the merge base after the first pull request");
  }
  const name = normalizeBaseBranch(input.baseBranch);
  const { listBranches, retargetWorktreeBase } = require("./worktrees.js");
  if (name) {
    const project = store.getProject(thread.projectId);
    if (!project || !project.path) {
      throw new Error(`Unknown base branch: ${name}`);
    }
    const listed = listBranches(project.path);
    if (!listed.branches.includes(name)) {
      throw new Error(`Unknown base branch: ${name}`);
    }
  }
  if (thread.worktreePath && !thread.orchWorker) {
    retargetWorktreeBase({ store, thread, baseName: name });
  }
  const patch = { baseBranch: name };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Draft workspace choice (composer strip): arm or drop the lazy worktree
 * before the first send. `fromOrigin` (optional) starts it from the
 * freshly fetched origin copy of the base instead of the local branch. Locked once the thread has a worktree or any user
 * message, so a running conversation never changes checkout underneath
 * itself. Arming requires a local git project. Never bumps updatedAt.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, worktree: boolean, fromOrigin?: boolean }} input
 */
function setPendingWorktree(store, input) {
  const { threadId } = input || {};
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const want = input.worktree === true;
  const origin =
    typeof input.fromOrigin === "boolean" ? input.fromOrigin : undefined;
  if (
    Boolean(thread.pendingWorktree) === want &&
    !thread.worktreePath &&
    (origin === undefined || Boolean(thread.worktreeFromOrigin) === origin)
  ) {
    return { ...thread };
  }
  if (thread.worktreePath) {
    throw new Error("This thread already has a worktree");
  }
  if (store.getMessages(threadId).some((m) => m.role === "user")) {
    throw new Error("The workspace is locked after the first message");
  }
  if (want && !canHostWorktree(store.getProject(thread.projectId))) {
    throw new Error("This project can't host a worktree (needs a local git repo)");
  }
  /** @type {{ pendingWorktree: boolean, worktreeFromOrigin?: boolean }} */
  const patch = { pendingWorktree: want };
  if (origin !== undefined) patch.worktreeFromOrigin = origin;
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Retarget an idle orchestration worker onto the lead's current committed
 * HEAD (#1110). Updates `leadSnapshotSha` only — never `baseBranch`.
 * Materialized worktrees reuse retargetWorktreeBase / #775 rebase-onto
 * from the previous snapshot. Dirty lead edits are noted, never copied.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 */
function refreshWorkerSnapshot(store, input) {
  const threadId = input && input.threadId;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.status === "working") {
    throw new Error("Cannot refresh a running worker. Wait until it is idle.");
  }
  if (!thread.orchWorker) {
    throw new Error("Refresh is only for orchestration workers.");
  }
  const pending = thread.pendingWorktree === true;
  const live = Boolean(thread.worktreePath);
  if (!pending && !live) {
    throw new Error("Refresh is only for worktree workers.");
  }

  const lead = thread.handoffFrom
    ? store.getThread(thread.handoffFrom)
    : null;
  const {
    captureLeadSnapshot,
    retargetWorktreeBase,
  } = require("./worktrees.js");
  const snapshot = captureLeadSnapshot(store, lead);

  if (live) {
    const fromRef =
      typeof thread.leadSnapshotSha === "string"
        ? thread.leadSnapshotSha.trim()
        : "";
    if (!fromRef) {
      throw new Error(
        "This orchestration worker has no recorded lead snapshot. Refusing to fall back to main.",
      );
    }
    retargetWorktreeBase({
      store,
      thread,
      fromRef,
      ontoRef: snapshot.sha,
    });
  }

  const patch = {
    leadSnapshotSha: snapshot.sha,
    leadSnapshotBranch: snapshot.branch,
    leadSnapshotDirty: snapshot.dirty === true,
  };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Record the one-tap felt estimate for a thread (issue #401). savedMs is a
 * non-negative duration clamped to FELT_ESTIMATE_MAX_MS; null records a
 * decline so the transcript card never asks again. User-facing bookkeeping,
 * never bumps updatedAt — same rule as setNotes.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, savedMs: number | null }} input
 */
function setFeltEstimate(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const at = Date.now();
  let feltEstimate;
  if (input.savedMs == null) {
    feltEstimate = { kind: "declined", at };
  } else {
    const savedMs = Number(input.savedMs);
    if (!Number.isFinite(savedMs) || savedMs < 0) {
      throw new Error(
        `Invalid felt estimate: ${JSON.stringify(input.savedMs)}. Expected a non-negative number of ms, or null to decline`,
      );
    }
    feltEstimate = {
      kind: "saved",
      savedMs: Math.min(savedMs, FELT_ESTIMATE_MAX_MS),
      at,
    };
  }
  const patch = { feltEstimate };
  const updated = store.updateThread(threadId, patch);
  store.save();
  return updated ? { ...updated } : { ...thread, ...patch };
}

/**
 * Append one hypothesis to a thread's ledger (issue #303). Agent-written
 * only — never inferred. Trims and caps claim/reason, rejects a blank claim
 * and an unknown status. Newest-last, capped at HYPOTHESES_MAX (oldest
 * dropped). Never bumps updatedAt: the ledger is not sidebar activity,
 * same rule as setNotes.
 *
 * ponytail: same-ms uniqueness is Date.now() plus a scan of this thread's
 * existing ids (max 50). A process-global counter if that ever collides.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, claim: unknown, status: unknown, reason?: unknown }} input
 * @returns {{ id: string, claim: string, status: string, reason: string, at: number }}
 */
function recordHypothesis(store, input) {
  const { threadId, status } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!HYPOTHESIS_STATUSES.includes(status)) {
    throw new Error(
      `Invalid hypothesis status: ${status}. Must be one of: ${HYPOTHESIS_STATUSES.join(", ")}`,
    );
  }
  const claim = String(input.claim ?? "").trim().slice(0, HYPOTHESIS_CLAIM_MAX);
  if (!claim) {
    throw new Error("Hypothesis claim must not be empty");
  }
  const reason = String(input.reason ?? "").trim().slice(0, HYPOTHESIS_REASON_MAX);
  const existing = Array.isArray(thread.hypotheses) ? thread.hypotheses : [];
  const now = Date.now();
  let seq = 0;
  for (const h of existing) {
    if (h && typeof h.id === "string" && h.id.startsWith(`${now}-`)) seq += 1;
  }
  const entry = {
    id: `${now}-${seq}`,
    claim,
    status,
    reason,
    at: now,
  };
  const hypotheses = existing.concat(entry);
  if (hypotheses.length > HYPOTHESES_MAX) {
    hypotheses.splice(0, hypotheses.length - HYPOTHESES_MAX);
  }
  store.updateThread(threadId, { hypotheses });
  store.save();
  return entry;
}

/**
 * Append one suggested-work chip to a thread (issue #550). Agent-written
 * only — never parsed out of the transcript. Trims and caps title/prompt,
 * rejects a blank of either. Newest-last, capped at SUGGESTIONS_MAX (oldest
 * dropped). An open chip with the same lower-cased title is returned as-is
 * instead of appending a duplicate. Never bumps updatedAt: same rule as
 * recordHypothesis / setNotes.
 *
 * ponytail: same-ms uniqueness is Date.now() plus a scan of this thread's
 * existing ids (max 20).
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, title: unknown, prompt: unknown }} input
 * @returns {{ id: string, title: string, prompt: string, status: string, at: number }}
 */
function recordSuggestion(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const title = String(input.title ?? "").trim().slice(0, SUGGESTION_TITLE_MAX);
  if (!title) {
    throw new Error("Suggestion title must not be empty");
  }
  const prompt = String(input.prompt ?? "")
    .trim()
    .slice(0, SUGGESTION_PROMPT_MAX);
  if (!prompt) {
    throw new Error("Suggestion prompt must not be empty");
  }
  const existing = Array.isArray(thread.suggestions) ? thread.suggestions : [];
  const titleKey = title.toLowerCase();
  for (const s of existing) {
    if (
      s &&
      s.status === "open" &&
      String(s.title || "").toLowerCase() === titleKey
    ) {
      return s;
    }
  }
  const now = Date.now();
  let seq = 0;
  for (const s of existing) {
    if (s && typeof s.id === "string" && s.id.startsWith(`${now}-`)) seq += 1;
  }
  const entry = {
    id: `${now}-${seq}`,
    title,
    prompt,
    status: "open",
    at: now,
  };
  const suggestions = existing.concat(entry);
  if (suggestions.length > SUGGESTIONS_MAX) {
    suggestions.splice(0, suggestions.length - SUGGESTIONS_MAX);
  }
  store.updateThread(threadId, { suggestions });
  store.save();
  return entry;
}

/**
 * Resolve a suggested-work chip (issue #550): flip its status to
 * "started" / "filed" / "dismissed" and optionally stamp startedThreadId
 * / issueNumber. Rejects an unknown thread or suggestion id, and a
 * status of "open" (chips never reopen). Returns the updated thread,
 * same convention as setNotes.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, suggestionId: string, status: unknown, startedThreadId?: unknown, issueNumber?: unknown }} input
 * @returns {object}
 */
function resolveSuggestion(store, input) {
  const { threadId, suggestionId, status } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (!SUGGESTION_RESOLVE_STATUSES.includes(status)) {
    throw new Error(
      `Invalid suggestion status: ${status}. Must be one of: ${SUGGESTION_RESOLVE_STATUSES.join(", ")}`,
    );
  }
  const existing = Array.isArray(thread.suggestions) ? thread.suggestions : [];
  const idx = existing.findIndex((s) => s && s.id === suggestionId);
  if (idx < 0) {
    throw new Error(`Unknown suggestion: ${suggestionId}`);
  }
  const patched = { ...existing[idx], status };
  if (input.startedThreadId != null) {
    patched.startedThreadId = String(input.startedThreadId);
  }
  if (input.issueNumber != null) {
    patched.issueNumber = Number(input.issueNumber);
  }
  const suggestions = existing.slice();
  suggestions[idx] = patched;
  const updated = store.updateThread(threadId, { suggestions });
  store.save();
  return updated ? { ...updated } : { ...thread, suggestions };
}

/**
 * Set or clear the thread's verification command (issue #296). A non-empty
 * command arms the gate; empty / null / whitespace disarms it. Trimmed and
 * capped by normalizeCommand. Never bumps updatedAt: a setting is not
 * activity, same rule as setNotes / setPinned.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string, command: unknown }} input
 */
function setVerifyCommand(store, input) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  const verifyCommand = normalizeCommand(input.command);
  const updated = store.updateThread(threadId, { verifyCommand });
  store.save();
  return updated ? { ...updated } : { ...thread, verifyCommand };
}

/**
 * Run the thread's verify command now and persist the evidence (issue #296).
 * Manual counterpart to the runner's automatic gate. Rejects when no
 * command is set or a run is already active.
 *
 * @param {import('./store').Store} store
 * @param {{ threadId: string }} input
 * @param {{ runner: { isRunning: (id: string) => boolean } }} deps
 * @returns {Promise<import('../src/shared/ipc').VerifyResult>}
 */
async function runVerifyNow(store, input, deps) {
  const { threadId } = input;
  const thread = store.getThread(threadId);
  if (!thread) {
    throw new Error(`Unknown thread: ${threadId}`);
  }
  if (thread.verifyCommand == null) {
    throw new Error("No verify command set for this thread");
  }
  if (deps.runner.isRunning(threadId)) {
    throw new Error("A run is already active on this thread");
  }

  const project = store.getProject(thread.projectId);
  const cwd = thread.worktreePath || (project && project.path) || process.cwd();
  const prepared = prepareVerifyRun({
    command: thread.verifyCommand,
    cwd,
    project,
  });
  const ran = await runVerifyCommand({
    command: prepared.command,
    cwd,
    project,
    env: prepared.env,
  });
  if (prepared.reason && ran && ran.log != null) {
    ran.log = `[verify] ${prepared.reason}\n${ran.log}`;
  }

  // Worktree HEAD only; a project checkout is not a checkpoint. Best-effort:
  // a git failure yields null and never throws.
  let sha = null;
  if (thread.worktreePath) {
    try {
      const { gitTryAsync } = require("./worktrees.js");
      const rev = await gitTryAsync(thread.worktreePath, ["rev-parse", "HEAD"]);
      if (rev.ok && rev.stdout) {
        const trimmed = String(rev.stdout).trim();
        sha = trimmed || null;
      }
    } catch {
      sha = null;
    }
  }

  /** @type {import('../src/shared/ipc').VerifyResult} */
  const result = {
    runId: "manual",
    command: prepared.command,
    ok: ran.ok,
    exitCode: ran.exitCode,
    timedOut: ran.timedOut,
    log: ran.log,
    sha,
    durationMs: ran.durationMs,
    at: Date.now(),
    attempt: (thread.verify?.attempt ?? 0) + 1,
  };
  store.updateThread(threadId, { verify: result });
  store.save();
  return result;
}

module.exports = {
  setArchived,
  clearSettledOnActivity,
  setSettled,
  setPinned,
  setQueued,
  takeQueued,
  addBtw,
  finishBtw,
  dismissBtw,
  promoteBtw,
  setSnoozed,
  setTags,
  setThreadProject,
  setMuted,
  setEjected,
  setCrossThreadInbound,
  setQuotaWaitAutoResume,
  setPrWatch,
  setNotes,
  setMessagePins,
  setBaseBranch,
  setPendingWorktree,
  refreshWorkerSnapshot,
  setFeltEstimate,
  recordHypothesis,
  recordSuggestion,
  resolveSuggestion,
  setVerifyCommand,
  runVerifyNow,
};
