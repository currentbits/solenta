/**
 * `/feedback` parse (issue #681).
 *
 * Run: node --experimental-strip-types --test test/feedback.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFeedbackCommand } from "../src/feedback.ts";
import { SLASH_COMMANDS, matchSlashCommands } from "../src/slashCommands.ts";

describe("parseFeedbackCommand", () => {
  it("returns the text after /feedback", () => {
    assert.equal(
      parseFeedbackCommand("/feedback the sidebar flickers"),
      "the sidebar flickers",
    );
    assert.equal(
      parseFeedbackCommand("  /feedback   worktrees eat my disk  "),
      "worktrees eat my disk",
    );
  });

  it("keeps a multi-line report", () => {
    assert.equal(
      parseFeedbackCommand("/feedback steps:\n1. open\n2. crash"),
      "steps:\n1. open\n2. crash",
    );
  });

  it("returns null for a bare /feedback so an empty report is never sent", () => {
    assert.equal(parseFeedbackCommand("/feedback"), null);
    assert.equal(parseFeedbackCommand("/feedback   "), null);
  });

  it("does not swallow other drafts", () => {
    assert.equal(parseFeedbackCommand("/btw where"), null);
    assert.equal(parseFeedbackCommand("feedback: it is slow"), null);
    assert.equal(parseFeedbackCommand("/FEEDBACK shouty"), null);
    // A word that merely starts with the verb must still reach the model.
    assert.equal(parseFeedbackCommand("/feedbackloop explain"), null);
  });
});

describe("/feedback in the palette", () => {
  it("is insert-only, so the send path can intercept it", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/feedback");
    assert.ok(cmd, "/feedback is in the palette");
    assert.equal(cmd.kind, "insert");
    assert.equal(cmd.action, undefined);
  });

  it("is offered while the token is being typed", () => {
    assert.ok(matchSlashCommands("/fee").some((c) => c.name === "/feedback"));
  });
});
