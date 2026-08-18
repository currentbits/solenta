/**
 * Composer orchestration commands (issue #338): `/handoff`, `/advisor`,
 * `/committee`. Each is a named composition of machinery that already exists
 * (fork hand-off, orchWorker notices, crew peer messaging) behind a one-word
 * entry point, so the user does not choreograph threads by hand.
 *
 * This module is PURE — parsing and prompt text only. The runner owns the
 * forks, the runs and the event messages, exactly like it owns pendingFork.
 * Same shape as src/delegate.ts, which is the renderer-side precedent for a
 * first-token command with testable rules.
 *
 *   /handoff   [@provider] <task>      plan here, implement on a fresh model
 *   /advisor   [@provider] <question>  one read-only second opinion, reported back
 *   /committee [@a] [@b]  <problem>    two contrasting models converge adversarially
 *
 * Provider arguments are optional; without them the defaults pick models that
 * CONTRAST with the calling thread's, which is the whole point (same-model
 * agents agree with themselves — see the conformity note on issue #338).
 */

/** @typedef {"handoff" | "advisor" | "committee"} OrchCommandKind */

/**
 * @typedef {object} OrchCommand
 * @property {OrchCommandKind} kind
 * @property {string} task - the prompt after the command and its @provider args
 * @property {string[]} providers - one provider id per worker to fork, in order
 */

/** Workers forked per command kind. Committee is two by definition. */
const WORKERS_PER_KIND = { handoff: 1, advisor: 1, committee: 2 };

const KINDS = new Set(Object.keys(WORKERS_PER_KIND));

/**
 * Parse a composer orchestration command.
 *
 * Returns null for anything that is not one of the three commands, and for a
 * command with no task after it — a bare `/advisor` falls through to a normal
 * send rather than dispatching an empty question.
 *
 * @param {string} prompt
 * @param {{ installed: string[], current: string }} ctx - installed provider
 *   ids (registry order) and the calling thread's provider
 * @returns {OrchCommand | null}
 */
function parseOrchCommand(prompt, ctx) {
  try {
    if (typeof prompt !== "string") return null;
    const trimmed = prompt.trim();
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!m) return null;
    const token = m[1];
    if (!token.startsWith("/")) return null;
    const kind = token.slice(1);
    if (!KINDS.has(kind)) return null;

    const installed = Array.isArray(ctx && ctx.installed)
      ? ctx.installed.filter((id) => typeof id === "string" && id)
      : [];
    const current = ctx && typeof ctx.current === "string" ? ctx.current : "";
    const need = WORKERS_PER_KIND[kind];
    const { explicit, task } = takeProviders(m[2] || "", need, installed);
    if (!task) return null;
    return {
      kind,
      task,
      providers: fillProviders(need, explicit, installed, current),
    };
  } catch {
    return null;
  }
}

/**
 * Consume up to `max` leading `@<id>` tokens that are in `installed`. An
 * unknown `@foo` is left on the task (it may be an @file mention).
 * @param {string} rest
 * @param {number} max
 * @param {string[]} installed
 * @returns {{ explicit: string[], task: string }}
 */
function takeProviders(rest, max, installed) {
  const explicit = [];
  let remaining = rest.trim();
  while (explicit.length < max) {
    const m = /^@(\S+)(?:\s+([\s\S]*))?$/.exec(remaining);
    if (!m) break;
    const id = m[1] ?? "";
    if (!installed.includes(id)) break;
    explicit.push(id);
    remaining = (m[2] ?? "").trim();
  }
  return { explicit, task: remaining };
}

/**
 * Fill to exactly `need` provider ids. Explicit args first, then installed
 * ids that contrast with `current` and are not already picked (registry
 * order). If that runs out, fall back to `current`; reuse only as a last
 * resort so a single-provider machine still produces a command.
 * @param {number} need
 * @param {string[]} explicit
 * @param {string[]} installed
 * @param {string} current
 * @returns {string[]}
 */
function fillProviders(need, explicit, installed, current) {
  const out = explicit.slice(0, need);
  const picked = new Set(out);
  for (const id of installed) {
    if (out.length >= need) break;
    if (id !== current && !picked.has(id)) {
      out.push(id);
      picked.add(id);
    }
  }
  if (out.length < need && current && !picked.has(current)) {
    out.push(current);
    picked.add(current);
  }
  while (out.length < need) {
    out.push(current || installed[0] || out[0] || "");
  }
  return out;
}

/**
 * Prompt for one worker of a dispatched command. Self-contained: a fork
 * carries only a truncated digest of the source thread, so the role, the
 * task and the reporting contract all have to be stated here.
 *
 * @param {OrchCommandKind} kind
 * @param {string} task
 * @param {{ index: number, total: number, peerIds: string[] }} role - 0-based
 *   worker index, worker count, and the OTHER workers' thread ids (committee
 *   members argue with each other directly via the peer_send MCP tool)
 * @returns {string}
 */
function workerPrompt(kind, task, role) {
  const text = typeof task === "string" ? task : "";
  const index = role && Number.isFinite(role.index) ? role.index : 0;
  const total = role && Number.isFinite(role.total) ? role.total : 1;
  const peerIds =
    role && Array.isArray(role.peerIds)
      ? role.peerIds.map((id) => String(id))
      : [];

  if (kind === "handoff") {
    return (
      "You are the implementer of a hand-off. The plan is in the hand-off " +
      "context above. Implement the task below on your branch, commit when " +
      "you are done, and reply with a summary of what changed and anything " +
      "the planner got wrong.\n\nTask: " +
      text
    );
  }
  if (kind === "advisor") {
    return (
      "You are a second opinion on a different model. Do not edit files. " +
      "Do not commit. Investigate the question below and reply with a " +
      "verdict, the reasoning, the strongest objection to the current " +
      "approach, and your confidence.\n\nQuestion: " +
      text
    );
  }
  if (kind === "committee") {
    const peers = peerIds.length > 0 ? peerIds.join(", ") : "(none named)";
    return (
      "You are committee member " +
      (index + 1) +
      " of " +
      total +
      ". Independently root-cause the problem below first. Do not edit " +
      "files.\n\nThen use the peer_send MCP tool to send your root cause " +
      "to each of these peer thread ids and read their reply: " +
      peers +
      ". Where you disagree, argue it with them directly (at most 3 " +
      "rounds) and concede when their evidence is better.\n\nYour final " +
      "reply is the consensus root cause, or the remaining split stated " +
      "plainly with both positions.\n\nProblem: " +
      text
    );
  }
  return text;
}

/**
 * Event line appended to the LEAD thread when a command dispatches, so the
 * transcript says what was launched and what will wake this thread.
 *
 * @param {OrchCommandKind} kind
 * @param {Array<{ id: string, provider: string }>} workers
 * @returns {string}
 */
function dispatchNote(kind, workers) {
  const list = Array.isArray(workers) ? workers : [];
  const parts = list.map((w) => {
    const provider = w && w.provider != null ? String(w.provider) : "";
    const id = w && w.id != null ? String(w.id).slice(0, 8) : "";
    return [provider, id].filter(Boolean).join(" ");
  });
  const n = list.length;
  const noun = n === 1 ? "worker" : "workers";
  const who = parts.join(", ");
  return (
    "[orchestration] /" +
    kind +
    " dispatched " +
    n +
    " " +
    noun +
    " (" +
    who +
    "); they wake this thread when they land."
  );
}

module.exports = {
  WORKERS_PER_KIND,
  parseOrchCommand,
  workerPrompt,
  dispatchNote,
};
