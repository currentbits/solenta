"use strict";

/**
 * Codex app-server ServerRequest mapping (issue #1171).
 *
 * Command approval, file-change approval (#1189) and input requests reuse
 * the pending-permission queue. Everything else is fail-closed until a
 * dedicated UI exists. Do not send `updatedCommand` into this RPC: Accept
 * runs the proposed string (#509 hole).
 */

const path = require("node:path");

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
 *   action: "command" | "fileChange" | "mcp" | "input" | "unsupported" | "unknown",
 *   method: string,
 *   kind?: string | null,
 *   reason: string,
 * }}
 */
function classifyServerRequest(method, params) {
  const name = String(method || "");
  // Codex uses elicitation for ordinary tool approval too. Only an empty
  // confirmation form fits our permission card; never invent form answers.
  if (name === METHOD_ELICITATION && params?.mode === "form" &&
      params?._meta?.codex_approval_kind === "mcp_tool_call") {
    const schema = params.requestedSchema;
    if (schema?.type === "object" && schema.properties &&
        !Array.isArray(schema.properties) && typeof schema.properties === "object" &&
        Object.keys(schema.properties).length === 0 &&
        (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
        Object.keys(schema).every((key) => ["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(key))) {
      return { action: "mcp", method: name, reason: name };
    }
  }
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
  if (name === METHOD_FILE_CHANGE) {
    return { action: "fileChange", method: name, reason: name };
  }
  if ((name === METHOD_ELICITATION && typeof params?.message === "string") ||
      (name === METHOD_USER_INPUT && Array.isArray(params?.questions) && params.questions.length)) {
    return { action: "input", method: name, reason: name };
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

// ponytail: one cap for the whole patch; it rides every pushDetail while pending.
const FILE_CHANGE_DIFF_MAX = 200_000;

/**
 * Codex fileChange `changes` ({ path, kind: { type, move_path? }, diff })
 * as a git-style patch the renderer's parsePatch reads. `diff` is the
 * whole file for add/delete and bare hunks for update.
 *
 * @param {object[]} changes
 * @param {string | null} root - shown paths are relative to this when inside
 */
function fileChangePatch(changes, root) {
  const show = (p) => {
    const rel = root ? path.relative(root, p) : p;
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
  };
  const files = changes.map((c) => {
    const type = c.kind && c.kind.type;
    const from = show(c.path);
    const to = type === "update" && c.kind.move_path ? show(c.kind.move_path) : from;
    const text = typeof c.diff === "string" ? c.diff : "";
    let body = "";
    if (type === "add" || type === "delete") {
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const sign = type === "add" ? "+" : "-";
      const range = lines.length ? `1,${lines.length}` : "0,0";
      body = lines.length
        ? `@@ ${type === "add" ? `-0,0 +${range}` : `-${range} +0,0`} @@\n` +
          lines.map((l) => sign + l).join("\n") + "\n"
        : "";
    } else {
      const at = text.search(/^@@/m);
      body = at < 0 ? "" : text.slice(at);
      if (body && !body.endsWith("\n")) body += "\n";
    }
    return (
      `diff --git a/${from} b/${to}\n` +
      `--- ${type === "add" ? "/dev/null" : `a/${from}`}\n` +
      `+++ ${type === "delete" ? "/dev/null" : `b/${to}`}\n` +
      body
    );
  });
  const patch = files.join("");
  return patch.length <= FILE_CHANGE_DIFF_MAX
    ? patch
    : `${patch.slice(0, FILE_CHANGE_DIFF_MAX)}\n\\ diff truncated (${patch.length - FILE_CHANGE_DIFF_MAX} more chars)\n`;
}

/**
 * Shape item/fileChange/requestApproval for PermissionPrompt. The request
 * carries no diff; `changes` comes from the correlated item/started.
 *
 * @param {unknown} rpcId
 * @param {unknown} params
 * @param {unknown} changes - fileChange item `changes` from item/started
 * @param {string | null} root - worktree, for display paths
 */
function pendingFromFileChange(rpcId, params, changes, root) {
  const rec =
    params && typeof params === "object" && !Array.isArray(params)
      ? /** @type {Record<string, unknown>} */ (params)
      : {};
  const list = (Array.isArray(changes) ? changes : []).filter(
    (c) => c && typeof c === "object" && typeof c.path === "string" && c.path,
  );
  const reason = typeof rec.reason === "string" && rec.reason ? rec.reason : null;
  const grantRoot =
    typeof rec.grantRoot === "string" && rec.grantRoot ? rec.grantRoot : null;
  /** @type {Record<string, unknown>} */
  const rawInput = {
    changes: list.map((c) => ({ path: c.path, kind: c.kind ?? null })),
  };
  if (reason) rawInput.reason = reason;
  if (grantRoot) rawInput.grantRoot = grantRoot;
  const first = list[0] ? list[0].path : "";
  const short = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  return {
    id: stringifyRpcId(rpcId),
    rpcId,
    toolName: "Edit",
    summary: !first ? "Edit" : list.length === 1 ? `Edit: ${short}` : `Edit: ${short} +${list.length - 1}`,
    input: JSON.stringify(rawInput, null, 2),
    rawInput,
    command: null,
    commandEditable: false,
    acceptAlways: true,
    availableDecisions: null,
    fileChange: { diff: fileChangePatch(list, root), reason, grantRoot },
  };
}

function pendingFromMcp(rpcId, params) {
  const rawInput = params._meta.tool_params ?? {};
  return {
    id: stringifyRpcId(rpcId), rpcId, method: METHOD_ELICITATION,
    toolName: `mcp__${params.serverName || "server"}`,
    summary: String(params.message || `MCP: ${params.serverName || "server"}`),
    input: JSON.stringify(rawInput, null, 2), rawInput,
    command: null, commandEditable: false, acceptAlways: false,
    availableDecisions: [DECISION_ACCEPT, DECISION_DECLINE],
  };
}

function approvalResponse(method, decision, content = {}) {
  if (method === METHOD_ELICITATION) {
    const action = decision === DECISION_SESSION ? DECISION_ACCEPT : decision;
    return { action, content: action === DECISION_ACCEPT ? content : null, _meta: null };
  }
  if (method === METHOD_USER_INPUT) return { answers: decision === DECISION_ACCEPT
    ? Object.fromEntries(Object.entries(content).map(([id, answer]) => [id, { answers: [answer] }])) : {} };
  return { decision };
}

/**
 * Solenta permission button → Codex decision. Deny is `decline` (turn
 * continues). Stop uses `cancel` separately. `updatedCommand` is ignored.
 *
 * @param {"allow" | "allowAlways" | "deny" | "cancel"} decision
 * @param {string[] | null | undefined} available
 * @returns {string}
 */
function mapSolentaDecision(decision, available) {
  if (decision === "cancel") return DECISION_CANCEL;
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
  pendingFromFileChange,
  fileChangePatch,
  pendingFromMcp,
  approvalResponse,
  mapSolentaDecision,
  unsupportedError,
};
