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
  void prompt;
  void ctx;
  return null; // TODO(#338)
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
  void kind;
  void task;
  void role;
  return ""; // TODO(#338)
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
  void kind;
  void workers;
  return ""; // TODO(#338)
}

module.exports = {
  WORKERS_PER_KIND,
  parseOrchCommand,
  workerPrompt,
  dispatchNote,
};
