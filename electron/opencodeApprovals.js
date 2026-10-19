"use strict";

/**
 * OpenCode serve permission.asked → Solenta permission prompt (#451 item 3),
 * the opencode counterpart of codexApprovals.js. Verified on 1.17.12/1.19.3:
 *
 *   permission.asked { id: "per_…", sessionID, permission: "bash",
 *     patterns: ["echo hi"], metadata: { command: "echo hi" },
 *     always: ["echo *"], tool: { messageID, callID } }
 *
 * Answered via POST /permission/:id/reply { reply: once|always|reject }.
 * The reply cannot rewrite the command, so commandEditable is always false.
 */

const REPLY_ONCE = "once";
const REPLY_ALWAYS = "always";
const REPLY_REJECT = "reject";

/**
 * @param {any} req - permission.asked properties
 */
function pendingFromOpencode(req) {
  const r = req && typeof req === "object" ? req : {};
  const permission = String(r.permission || "permission");
  const patterns = Array.isArray(r.patterns) ? r.patterns.map(String) : [];
  const metadata = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
  const command = permission === "bash" && typeof metadata.command === "string"
    ? metadata.command
    : null;
  const what = command || patterns.join(", ");
  /** @type {Record<string, unknown>} */
  const rawInput = command != null ? { command } : { patterns, ...metadata };
  let input;
  try {
    input = JSON.stringify(rawInput, null, 2);
  } catch {
    input = what;
  }
  return {
    id: String(r.id || ""),
    toolName: permission,
    summary: what ? `${permission}: ${what.length > 80 ? `${what.slice(0, 80)}…` : what}` : permission,
    input,
    rawInput,
    command,
    commandEditable: false,
    acceptAlways: true,
  };
}

/**
 * Solenta button → opencode reply. Deny and Stop both reject: opencode has
 * no separate cancel, and Stop aborts the session anyway.
 * @param {"allow" | "allowAlways" | "deny" | "cancel"} decision
 */
function mapOpencodeDecision(decision) {
  if (decision === "allowAlways") return REPLY_ALWAYS;
  if (decision === "allow") return REPLY_ONCE;
  return REPLY_REJECT;
}

module.exports = {
  REPLY_ONCE,
  REPLY_ALWAYS,
  REPLY_REJECT,
  pendingFromOpencode,
  mapOpencodeDecision,
};
