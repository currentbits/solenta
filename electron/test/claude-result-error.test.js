"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classifyClaudeResultError } = require("../runner.js");

describe("classifyClaudeResultError (#549)", () => {
  it("maps a bare cancelled errors[] to a stop, not a failure", () => {
    assert.deepEqual(classifyClaudeResultError({ errors: ["cancelled"] }), {
      kind: "stop",
    });
    assert.equal(
      classifyClaudeResultError({ errors: ["Canceled"] }).kind,
      "stop",
    );
  });

  it("maps cancelled in result with no other detail to a stop", () => {
    assert.equal(
      classifyClaudeResultError({ errors: [], result: "cancelled" }).kind,
      "stop",
    );
  });

  it("bare cancelled in errors[] stays a stop even if result echoes assistant text", () => {
    assert.equal(
      classifyClaudeResultError({
        errors: ["cancelled"],
        result: "About to run a tool",
      }).kind,
      "stop",
    );
  });

  it("fails remaining error_during_execution cases with CLI text, no subtype", () => {
    const out = classifyClaudeResultError({
      errors: ["MCP server memory failed: connection refused"],
      subtype: "error_during_execution",
    });
    assert.equal(out.kind, "fail");
    assert.equal(out.sessionLost, false);
    assert.match(out.text, /MCP server memory failed: connection refused/);
    assert.doesNotMatch(out.text, /result subtype|error_during_execution/);
  });

  it("uses stderr when errors[] is empty", () => {
    const out = classifyClaudeResultError({
      errors: [],
      stderr: "host: tool gated with no prompt channel\n",
    });
    assert.equal(out.kind, "fail");
    assert.match(out.text, /tool gated with no prompt channel/);
    assert.doesNotMatch(out.text, /result subtype|error_during_execution/);
  });

  it("keeps a tool cancel with extra detail as a failure", () => {
    const out = classifyClaudeResultError({
      errors: ["cancelled", "Write: permission denied"],
    });
    assert.equal(out.kind, "fail");
    assert.match(out.text, /Write: permission denied/);
    assert.doesNotMatch(out.text, /result subtype/);
  });

  it("surfaces session-lost with the CLI error and the reset follow-up", () => {
    const out = classifyClaudeResultError({
      errors: ["No conversation found with session ID: sess-stale-999"],
      stderr: "No conversation found with session ID: sess-stale-999\n",
    });
    assert.equal(out.kind, "fail");
    assert.equal(out.sessionLost, true);
    assert.match(out.text, /No conversation found/);
    assert.match(out.text, /starts fresh/);
    assert.doesNotMatch(out.text, /result subtype|error_during_execution/);
    assert.equal(
      out.text.split("No conversation found").length - 1,
      1,
      "do not repeat the same CLI line from errors[] and stderr",
    );
  });

  it("falls back to Run error when there is no CLI text", () => {
    const out = classifyClaudeResultError({
      errors: [],
      subtype: "error_during_execution",
    });
    assert.equal(out.kind, "fail");
    assert.equal(out.text, "Run error");
  });
});
