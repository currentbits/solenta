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

  it("fail-closes known non-command ServerRequests", () => {
    for (const method of [
      METHOD_FILE_CHANGE,
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
