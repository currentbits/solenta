"use strict";

/**
 * Cross-thread message delivery contract (issue #551).
 *
 * Pure helpers used by thread_send: inbound policy, attributed prompt
 * wrapping, and the hold-until-idle / refuse / undeliverable decision.
 * Mutation (queue, startRun, unarchive) stays in the caller.
 */

const INBOUND_POLICIES = ["accept", "queue-only", "refuse"];

/**
 * @param {unknown} value
 * @returns {"accept" | "queue-only" | "refuse"}
 */
function normalizeInboundPolicy(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === "queue-only" || v === "queueonly" || v === "hold") {
    return "queue-only";
  }
  if (v === "refuse" || v === "deny") return "refuse";
  return "accept";
}

/**
 * @param {{ id?: unknown, title?: unknown } | null | undefined} from
 * @param {unknown} text
 * @returns {string}
 */
function attributedPrompt(from, text) {
  const body = String(text || "");
  const id = from && from.id != null ? String(from.id) : "";
  if (!id) return body;
  const title = from.title != null ? String(from.title) : "";
  const label = title ? `${id} ("${title}")` : id;
  return `[from thread ${label}]\n${body}`;
}

/**
 * @param {{ automationId?: unknown } | null | undefined} thread
 */
function isUnattended(thread) {
  return Boolean(thread && thread.automationId);
}

/**
 * @param {{ id?: unknown, title?: unknown } | null | undefined} thread
 * @returns {{ id: string, title: string } | null}
 */
function fromThreadMeta(thread) {
  if (!thread || thread.id == null) return null;
  return {
    id: String(thread.id),
    title: thread.title != null ? String(thread.title) : "",
  };
}

/**
 * Decide what thread_send should do. Does not mutate.
 *
 * @param {{
 *   target: {
 *     id?: string,
 *     archived?: boolean,
 *     orchWorker?: boolean,
 *     automationId?: unknown,
 *     crossThreadInbound?: unknown,
 *   },
 *   from?: { id?: string, automationId?: unknown } | null,
 *   running?: boolean,
 * }} input
 * @returns {{
 *   outcome: "delivered" | "queued" | "refused" | "undeliverable",
 *   reason?: string,
 *   policy?: "accept" | "queue-only" | "refuse",
 *   unarchive?: boolean,
 *   queue?: boolean,
 *   start?: boolean,
 * }}
 */
function decideCrossThreadSend(input) {
  const target = input.target;
  const from = input.from || null;
  const running = input.running === true;

  if (from && isUnattended(from)) {
    return { outcome: "undeliverable", reason: "unattended sender" };
  }
  if (isUnattended(target)) {
    return { outcome: "undeliverable", reason: "unattended receiver" };
  }
  if (target.archived && !target.orchWorker) {
    return { outcome: "undeliverable", reason: "archived" };
  }

  const policy = normalizeInboundPolicy(target.crossThreadInbound);
  if (policy === "refuse") {
    return { outcome: "refused", reason: "inbound refuse", policy };
  }

  const unarchive = Boolean(target.archived && target.orchWorker);

  if (policy === "queue-only" || running) {
    return {
      outcome: "queued",
      policy,
      unarchive,
      queue: true,
      start: false,
    };
  }

  return {
    outcome: "delivered",
    policy,
    unarchive,
    queue: false,
    start: true,
  };
}

module.exports = {
  INBOUND_POLICIES,
  normalizeInboundPolicy,
  attributedPrompt,
  fromThreadMeta,
  decideCrossThreadSend,
  isUnattended,
};
