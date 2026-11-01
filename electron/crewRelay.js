"use strict";

/**
 * Crew relay (#1821), the host side of a worker another computer forked
 * here. That worker's crew (its lead, the shared task list, its peers)
 * lives on the lead's computer, so its task_* and peer_send calls are
 * pushed down the lead computer's hub socket as `crew:call`; that computer
 * runs them against its crew and answers with threads:crewReply.
 */

const crypto = require("node:crypto");

const CALL_TIMEOUT_MS = 60_000;
const RELAYED_TOOLS = new Set(["task_list", "task_add", "task_claim", "task_complete", "task_release", "peer_send"]);

/**
 * @param {{ store: any, pushWeb: (channel: string, payload: unknown) => void }} deps
 */
function createCrewRelay({ store, pushWeb }) {
  /** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  /** threads:setCrewRelay: mark a thread as another computer's worker. */
  function attach(input) {
    const thread = store.getThread(input && input.threadId);
    if (!thread) throw new Error(`Unknown thread: ${input && input.threadId}`);
    if (!input.leadId) throw new Error("leadId is required");
    store.updateThread(thread.id, {
      crewRelay: { leadId: String(input.leadId), leadTitle: input.leadTitle ? String(input.leadTitle) : null },
    });
    store.save();
    return { ok: true };
  }

  /** The relayed worker making this call, or null when it runs locally. */
  function relayedThread(tool, threadId) {
    if (!RELAYED_TOOLS.has(tool)) return null;
    const thread = store.getThread(threadId);
    return thread && thread.crewRelay ? thread : null;
  }

  function call(thread, tool, args) {
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(
          "Your lead's computer did not answer. It may be asleep or have closed Solenta; " +
            "try again later, or finish without the crew tools.",
        ));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      pending.set(callId, { resolve, reject, timer });
      pushWeb("crew:call", { callId, workerId: thread.id, tool, args });
    });
  }

  /** threads:crewReply: the lead's computer answered a crew:call. */
  function reply(input) {
    const p = pending.get(String(input && input.callId));
    if (!p) return { ok: false };
    pending.delete(String(input.callId));
    clearTimeout(p.timer);
    if (input.error) p.reject(new Error(String(input.error)));
    else p.resolve(input.result);
    return { ok: true };
  }

  return { attach, relayedThread, call, reply };
}

module.exports = { createCrewRelay, RELAYED_TOOLS };
