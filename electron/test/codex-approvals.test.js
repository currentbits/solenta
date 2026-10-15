"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
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
  pendingFromCommand,
  pendingFromApproval,
  approvalResponse,
  mapSolentaDecision,
  unsupportedError,
} = require("../codexApprovals.js");

describe("codexApprovals classifyServerRequest", () => {
  it("maps command kind=command onto the permission card", () => {
    const got = classifyServerRequest(METHOD_COMMAND, {
      kind: "command",
      command: "ls",
    });
    assert.equal(got.action, "command");
  });

  it("does not treat writeStdin as a command card", () => {
    const got = classifyServerRequest(METHOD_COMMAND, {
      kind: "writeStdin",
      command: "y\n",
    });
    assert.equal(got.action, "unsupported");
    assert.match(got.reason, /writeStdin/);
  });

  it("maps file-change and sandbox-permission asks onto the approval card (#1190)", () => {
    assert.equal(classifyServerRequest(METHOD_FILE_CHANGE, {}).action, "approval");
    assert.equal(classifyServerRequest(METHOD_PERMISSIONS, { permissions: {} }).action, "approval");
  });

  it("grants exactly the requested sandbox profile, or nothing", () => {
    const permissions = { network: { enabled: true }, fileSystem: null };
    const pending = pendingFromApproval("p", METHOD_PERMISSIONS, { cwd: "/w", reason: "fetch deps", permissions });
    assert.equal(pending.summary, "sandbox permissions: fetch deps");
    assert.deepEqual(pending.availableDecisions, [DECISION_ACCEPT, DECISION_SESSION, DECISION_DECLINE]);
    assert.deepEqual(approvalResponse(METHOD_PERMISSIONS, DECISION_ACCEPT, pending.grant),
      { permissions: { network: { enabled: true } }, scope: "turn" });
    assert.deepEqual(approvalResponse(METHOD_PERMISSIONS, DECISION_SESSION, pending.grant),
      { permissions: { network: { enabled: true } }, scope: "session" });
    for (const decision of [DECISION_DECLINE, DECISION_CANCEL]) {
      assert.deepEqual(approvalResponse(METHOD_PERMISSIONS, decision, pending.grant),
        { permissions: {}, scope: "turn" });
    }
  });

  it("never shows a file-change ask without its diff", () => {
    assert.throws(() => pendingFromApproval("f", METHOD_FILE_CHANGE, { reason: "x" }));
    const pending = pendingFromApproval("f", METHOD_FILE_CHANGE, { grantRoot: "/etc" }, '[{"path":"/etc/hosts"}]');
    assert.match(pending.input, /"grantRoot": "\/etc"[\s\S]*\/etc\/hosts/);
    assert.deepEqual(approvalResponse(METHOD_FILE_CHANGE, DECISION_SESSION), { decision: DECISION_SESSION });
  });

  it("fail-closes known non-command ServerRequests", () => {
    for (const method of [
      METHOD_PERMISSIONS,
      METHOD_ELICITATION,
      METHOD_USER_INPUT,
    ]) {
      const got = classifyServerRequest(method, {});
      assert.equal(got.action, "unsupported", method);
    }
  });

  it("fail-closes unknown methods", () => {
    const got = classifyServerRequest("item/tool/call", {});
    assert.equal(got.action, "unknown");
    assert.equal(
      unsupportedError(got.method).code,
      JSONRPC_METHOD_NOT_FOUND,
    );
  });
});

describe("codexApprovals pendingFromCommand", () => {
  it("stores the JSON-RPC id, read-only command, and session cache flag", () => {
    const pending = pendingFromCommand(7, {
      command: "npm test",
      cwd: "/tmp/wt",
      reason: "sandbox",
      approvalId: "a1",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    });
    assert.equal(pending.id, "7");
    assert.equal(pending.rpcId, 7);
    assert.equal(pending.toolName, "command");
    assert.equal(pending.command, "npm test");
    assert.equal(pending.commandEditable, false);
    assert.equal(pending.acceptAlways, true);
    assert.equal(pending.approvalId, "a1");
    assert.equal(pending.rawInput.command, "npm test");
  });

  it("hides Accept all when acceptForSession is absent", () => {
    const pending = pendingFromCommand("srv-1", {
      command: "ls",
      availableDecisions: ["accept", "decline"],
    });
    assert.equal(pending.acceptAlways, false);
  });
});

describe("codexApprovals mapSolentaDecision", () => {
  it("maps allow / allowAlways / deny; deny is decline not cancel", () => {
    assert.equal(mapSolentaDecision("allow"), DECISION_ACCEPT);
    assert.equal(mapSolentaDecision("allowAlways"), DECISION_SESSION);
    assert.equal(mapSolentaDecision("deny"), DECISION_DECLINE);
    assert.notEqual(mapSolentaDecision("deny"), DECISION_CANCEL);
  });

  it("falls back from acceptForSession to accept when the server omitted it", () => {
    assert.equal(
      mapSolentaDecision("allowAlways", ["accept", "decline"]),
      DECISION_ACCEPT,
    );
  });
});
