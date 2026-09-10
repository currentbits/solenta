"use strict";

/**
 * Codex app-server ServerRequest mapping (issue #1171).
 *
 * Command approval (`item/commandExecution/requestApproval`, kind=command)
 * is the only ask that reuses Solenta's permission card. Everything else
 * is fail-closed until a dedicated UI exists. Do not send `updatedCommand`
 * into this RPC: Accept runs the proposed string (#509 hole).
 */

const METHOD_COMMAND = "item/commandExecution/requestApproval";
const METHOD_FILE_CHANGE = "item/fileChange/requestApproval";
const METHOD_PERMISSIONS = "item/permissions/requestApproval";
const METHOD_ELICITATION = "mcpServer/elicitation/request";
const METHOD_USER_INPUT = "item/tool/requestUserInput";

const DECISION_ACCEPT = "accept";
const DECISION_SESSION = "acceptForSession";
const DECISION_DECLINE = "decline";
const DECISION_CANCEL = "cancel";

const JSONRPC_METHOD_NOT_FOUND = -32601;

/** Methods we recognize but do not map onto PermissionPrompt. */
const UNSUPPORTED_METHODS = new Set([
  METHOD_FILE_CHANGE,
  METHOD_PERMISSIONS,
  METHOD_ELICITATION,
  METHOD_USER_INPUT,
]);

/**
 * @param {unknown} available
 * @returns {string[] | null} null means the server advertised no restriction
 */
function decisionNames(available) {
  if (!Array.isArray(available) || available.length === 0) return null;
  /** @type {string[]} */
  const names = [];
  for (const item of available) {
    if (typeof item === "string" && item) names.push(item);
    else if (item && typeof item === "object") {
      const rec = /** @type {Record<string, unknown>} */ (item);
      if (typeof rec.decision === "string" && rec.decision) {
        names.push(rec.decision);
      } else if (typeof rec.type === "string" && rec.type) {
        names.push(rec.type);
      }
    }
  }
  return names.length ? names : null;
}

/**
 * @param {string} method
 * @param {unknown} params
 * @returns {{
 *   action: "command" | "unsupported" | "unknown",
 *   method: string,
 *   kind?: string | null,
 *   reason: string,
 * }}
 */
function classifyServerRequest(method, params) {
  const name = String(method || "");
  if (name === METHOD_COMMAND) {
    const rec =
      params && typeof params === "object" && !Array.isArray(params)
        ? /** @type {Record<string, unknown>} */ (params)
        : {};
    const kind = rec.kind == null ? "command" : String(rec.kind);
    if (kind === "writeStdin") {
      return {
        action: "unsupported",
        method: name,
        kind,
        reason: `${name} (writeStdin)`,
      };
    }
    return { action: "command", method: name, kind, reason: name };
  }
  if (UNSUPPORTED_METHODS.has(name)) {
    return { action: "unsupported", method: name, reason: name };
  }
  return { action: "unknown", method: name, reason: name || "unknown" };
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function stringifyRpcId(id) {
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return JSON.stringify(id);
}

/**
 * Shape a command ServerRequest for pendingPermissions / PermissionPrompt.
 * `commandEditable` is always false: the reply cannot rewrite the command.
 *
 * @param {unknown} rpcId
 * @param {unknown} params
 */
function pendingFromCommand(rpcId, params) {
  const rec =
    params && typeof params === "object" && !Array.isArray(params)
      ? /** @type {Record<string, unknown>} */ (params)
      : {};
  const command =
    rec.command == null || rec.command === ""
      ? rec.command === ""
        ? ""
        : null
      : String(rec.command);
  const available = decisionNames(rec.availableDecisions);
  const cwd = typeof rec.cwd === "string" ? rec.cwd : "";
  const reason = typeof rec.reason === "string" ? rec.reason : "";
  /** @type {Record<string, unknown>} */
  const rawInput = { command: command == null ? "" : command };
  if (cwd) rawInput.cwd = cwd;
  if (reason) rawInput.reason = reason;
  const summary =
    command && command.trim()
      ? `command: ${command.length > 80 ? `${command.slice(0, 80)}…` : command}`
      : "command";
  let input;
  try {
    input = JSON.stringify(rawInput, null, 2);
  } catch {
    input = String(command || "");
  }
  return {
    id: stringifyRpcId(rpcId),
    rpcId,
    approvalId: rec.approvalId == null ? null : rec.approvalId,
    toolName: "command",
    summary,
    input,
    rawInput,
    command,
    commandEditable: false,
    acceptAlways: !available || available.includes(DECISION_SESSION),
    availableDecisions: available,
  };
}

/**
 * Solenta permission button → Codex decision. Deny is `decline` (turn
 * continues). Stop uses `cancel` separately. `updatedCommand` is ignored.
 *
 * @param {"allow" | "allowAlways" | "deny"} decision
 * @param {string[] | null | undefined} available
 * @returns {string}
 */
function mapSolentaDecision(decision, available) {
  let mapped =
    decision === "allowAlways"
      ? DECISION_SESSION
      : decision === "allow"
        ? DECISION_ACCEPT
        : DECISION_DECLINE;
  if (!available || available.length === 0) return mapped;
  if (available.includes(mapped)) return mapped;
  if (mapped === DECISION_SESSION && available.includes(DECISION_ACCEPT)) {
    return DECISION_ACCEPT;
  }
  if (available.includes(DECISION_DECLINE)) return DECISION_DECLINE;
  return mapped;
}

/**
 * @param {string} method
 * @param {string} [detail]
 */
function unsupportedError(method, detail) {
  const label = detail || method || "unknown";
  return {
    code: JSONRPC_METHOD_NOT_FOUND,
    message: `Unsupported ServerRequest: ${label}`,
  };
}

module.exports = {
  METHOD_COMMAND,
  METHOD_FILE_CHANGE,
  METHOD_PERMISSIONS,
  METHOD_ELICITATION,
  METHOD_USER_INPUT,
  DECISION_ACCEPT,
  DECISION_SESSION,
  DECISION_DECLINE,
  DECISION_CANCEL,
  JSONRPC_METHOD_NOT_FOUND,
  classifyServerRequest,
  decisionNames,
  stringifyRpcId,
  pendingFromCommand,
  mapSolentaDecision,
  unsupportedError,
};
